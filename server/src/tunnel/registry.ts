import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { DbPool } from '../db/pool.js';
import type { TunnelControl } from '../devices/tunnel-hooks.js';
import { ApiError } from '../http/errors.js';
import {
  auditTunnelDenied,
  auditTunnelEvent,
  findDeviceForTunnel,
  markDeviceOffline,
  markDeviceSeen,
} from './repository.js';
import {
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_INFLIGHT,
  DEFAULT_MAX_PENDING_WS_MESSAGES,
  DEFAULT_MAX_WS_PER_DEVICE,
  DEFAULT_OFFLINE_SEC,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WS_CHUNK_BYTES,
  DEFAULT_WS_MAX_MESSAGE_BYTES,
  DEFAULT_WS_REASSEMBLY_TIMEOUT_MS,
  MIN_TUNNEL_PROTOCOL_VERSION,
  TUNNEL_PROTOCOL_VERSION,
  WS_FRAGMENT_PROTOCOL_VERSION,
  WS_OPEN_TIMEOUT_MS,
  decodeBase64Body,
  encodeServerFrame,
  isTunnelPathAllowed,
  parseClientFrame,
  type RequestFrame,
  type ResponseFrame,
  type TunnelHttpRequest,
  type TunnelHttpResponse,
  type WsCloseFrame,
  type WsDataFrame,
  type WsOpenAckFrame,
  type WsOpenFrame,
} from './protocol.js';
import { WsFragmentReassembler, fragmentWsData, type WsFragmentDrop } from './ws-fragment.js';
import { AccessTokenExpiredError, verifyAccessToken } from '../security/tokens.js';
import { findSessionById } from '../auth/repositories/sessions.js';
import {
  TunnelTicketStore,
  type IssuedTunnelTicket,
  type TunnelTicketIdentity,
} from './tickets.js';

export interface TunnelRegistryOptions {
  pool: DbPool;
  jwtSecret: string;
  heartbeatSec?: number;
  offlineSec?: number;
  maxInflight?: number;
  maxFrameBytes?: number;
  maxWsPerDevice?: number;
  requestTimeoutMs?: number;
  wsOpenTimeoutMs?: number;
  /** wsdata 分片大小（默认 256 KiB）。 */
  wsChunkBytes?: number;
  /** 单条 WS 消息（分片重组后）上限（默认 64 MiB）。 */
  wsMaxMessageBytes?: number;
  /** 分片重组超时（默认 30 秒）。 */
  wsReassemblyTimeoutMs?: number;
  /** 单连接同时重组的消息数上限（默认 64）。 */
  wsMaxPendingMessages?: number;
  /** 一次性票据存储（缺省自建，测试可注入缩短 TTL）。 */
  tickets?: TunnelTicketStore;
  /**
   * 是否允许旧版 `Authorization: Bearer <access token>` 直接升级。
   * 默认 false：无票据一律 401；仅在灰度回滚时通过 ALLOW_TUNNEL_BEARER 打开。
   */
  allowBearer?: boolean;
}

interface PendingRequest {
  resolve: (response: TunnelHttpResponse) => void;
  reject: (error: Error) => void;
  status: number | null;
  headers: Record<string, string>;
  chunks: Buffer[];
  timer: NodeJS.Timeout;
}

export interface WsChannelHandlers {
  onData: (data: Buffer, binary: boolean) => void;
  onClose: (code: number, reason: string) => void;
}

export interface WsChannelHandle {
  readonly id: string;
  send(data: Buffer, binary: boolean): void;
  close(code: number, reason: string): void;
}

interface WsChannelRecord {
  id: string;
  session: TunnelSession;
  handlers: WsChannelHandlers;
  state: 'opening' | 'open' | 'closed';
  resolveOpen: () => void;
  rejectOpen: (error: Error) => void;
  openTimer: NodeJS.Timeout;
}

interface TunnelSession {
  deviceId: string;
  accountId: string;
  socket: WebSocket;
  /** 客户端注册时声明的协议版本：v1 不向其发送分片，v2 起启用 wsdata 分片。 */
  protocol: number;
  pending: Map<string, PendingRequest>;
  wsChannels: Map<string, WsChannelRecord>;
  /** 设备→浏览器方向的 wsdata 分片重组。 */
  reassembler: WsFragmentReassembler;
  lastActivityAt: number;
  heartbeatTimer: NodeJS.Timeout;
  closed: boolean;
  remoteAddress: string | null;
}

const TUNNEL_PATH = '/v1/tunnel';

/**
 * 隧道注册表：管理桌面端出站 WSS 连接，向设备转发 HTTP 请求与 WebSocket 通道。
 * 同时实现 T03 的 TunnelControl（撤销设备即断连）。
 */
export class TunnelRegistry implements TunnelControl {
  private readonly sessions = new Map<string, TunnelSession>();
  private readonly wss: WebSocketServer;
  private readonly heartbeatMs: number;
  private readonly offlineMs: number;
  private readonly maxInflight: number;
  private readonly maxFrameBytes: number;
  private readonly maxWsPerDevice: number;
  private readonly requestTimeoutMs: number;
  private readonly wsOpenTimeoutMs: number;
  private readonly wsChunkBytes: number;
  private readonly wsMaxMessageBytes: number;
  private readonly wsReassemblyTimeoutMs: number;
  private readonly wsMaxPendingMessages: number;
  /** 一次性票据存储（升级时消费）。 */
  readonly tickets: TunnelTicketStore;
  private readonly allowBearer: boolean;
  private requestCounter = 0;
  private wsChannelCounter = 0;
  /** 浏览器→设备方向的分片消息 id 序号。 */
  private wsMessageCounter = 0;

  constructor(private readonly options: TunnelRegistryOptions) {
    this.heartbeatMs = (options.heartbeatSec ?? DEFAULT_HEARTBEAT_SEC) * 1000;
    this.offlineMs = (options.offlineSec ?? DEFAULT_OFFLINE_SEC) * 1000;
    this.maxInflight = options.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxWsPerDevice = options.maxWsPerDevice ?? DEFAULT_MAX_WS_PER_DEVICE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.wsOpenTimeoutMs = options.wsOpenTimeoutMs ?? WS_OPEN_TIMEOUT_MS;
    this.wsChunkBytes = options.wsChunkBytes ?? DEFAULT_WS_CHUNK_BYTES;
    this.wsMaxMessageBytes = options.wsMaxMessageBytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
    this.wsReassemblyTimeoutMs = options.wsReassemblyTimeoutMs ?? DEFAULT_WS_REASSEMBLY_TIMEOUT_MS;
    this.wsMaxPendingMessages = options.wsMaxPendingMessages ?? DEFAULT_MAX_PENDING_WS_MESSAGES;
    this.tickets = options.tickets ?? new TunnelTicketStore();
    this.allowBearer = options.allowBearer ?? false;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxFrameBytes });
  }

  private get pool(): DbPool {
    return this.options.pool;
  }

  /** 挂到 Fastify：关闭应用前清理所有隧道连接（升级入口由 buildApp 统一分发）。 */
  attach(app: FastifyInstance): void {
    // preClose 在 http.Server 等待连接关闭之前执行；若用 onClose 会与升级连接互相等待
    app.addHook('preClose', async () => {
      this.close();
    });
  }

  isOnline(deviceId: string): boolean {
    const session = this.sessions.get(deviceId);
    return session !== undefined && !session.closed;
  }

  get onlineDeviceIds(): string[] {
    return [...this.sessions.values()].filter((session) => !session.closed).map((session) => session.deviceId);
  }

  /** 某设备当前打开的 WebSocket 通道数（测试/观测用）。 */
  wsChannelCount(deviceId: string): number {
    return this.sessions.get(deviceId)?.wsChannels.size ?? 0;
  }

  /** 向设备投递一个 HTTP 请求并等待响应（支持 more 分块）。 */
  async request(deviceId: string, request: TunnelHttpRequest): Promise<TunnelHttpResponse> {
    if (!isTunnelPathAllowed(request.path)) {
      const session = this.sessions.get(deviceId);
      await auditTunnelDenied(this.pool, {
        accountId: session?.accountId ?? null,
        deviceId,
        detail: { path: request.path, method: request.method },
      });
      throw new ApiError(403, 'tunnel.path_denied', '路径不在隧道白名单内');
    }

    const session = this.sessions.get(deviceId);
    if (!session || session.closed) {
      throw new ApiError(503, 'tunnel.device_offline', '设备不在线');
    }
    if (session.pending.size >= this.maxInflight) {
      throw new ApiError(503, 'tunnel.busy', '设备并发请求过多，请稍后重试');
    }

    const id = `r_${++this.requestCounter}`;
    const frame: RequestFrame = {
      t: 'req',
      id,
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: request.body && request.body.length > 0 ? request.body.toString('base64') : null,
    };

    return new Promise<TunnelHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new ApiError(504, 'tunnel.timeout', '设备响应超时'));
      }, this.requestTimeoutMs);

      session.pending.set(id, { resolve, reject, status: null, headers: {}, chunks: [], timer });
      try {
        session.socket.send(encodeServerFrame(frame));
      } catch {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(new ApiError(503, 'tunnel.device_offline', '设备连接已断开'));
      }
    });
  }

  /**
   * 打开一条经隧道的 WebSocket 通道：发 wsopen，等桌面端确认后才算建立。
   * WS 通道不计入 HTTP 并发窗口，但每设备有独立上限。
   */
  async openWsChannel(
    deviceId: string,
    input: { path: string; headers: Record<string, string> },
    handlers: WsChannelHandlers,
  ): Promise<WsChannelHandle> {
    if (!isTunnelPathAllowed(input.path)) {
      const session = this.sessions.get(deviceId);
      await auditTunnelDenied(this.pool, {
        accountId: session?.accountId ?? null,
        deviceId,
        detail: { path: input.path, method: 'WS' },
      });
      throw new ApiError(403, 'tunnel.path_denied', '路径不在隧道白名单内');
    }

    const session = this.sessions.get(deviceId);
    if (!session || session.closed) {
      throw new ApiError(503, 'tunnel.device_offline', '设备不在线');
    }
    if (session.wsChannels.size >= this.maxWsPerDevice) {
      // 兜底：先把最旧的一条踢掉再放新连接进来。Map 保持插入顺序，
      // 最早的通常是浏览器已断但设备未确认的残留通道。
      const oldest = session.wsChannels.values().next().value;
      if (oldest !== undefined) {
        this.closeWsChannel(session, oldest.id, 1001, 'evicted-by-new-connection');
      }
    }
    if (session.wsChannels.size >= this.maxWsPerDevice) {
      throw new ApiError(503, 'tunnel.ws_limit_exceeded', `单设备 WebSocket 数量已达上限（${this.maxWsPerDevice}）`);
    }

    const id = `w_${++this.wsChannelCounter}`;
    const frame: WsOpenFrame = {
      t: 'wsopen',
      id,
      path: input.path,
      headers: input.headers,
      protocol: TUNNEL_PROTOCOL_VERSION,
    };

    return new Promise<WsChannelHandle>((resolve, reject) => {
      const record: WsChannelRecord = {
        id,
        session,
        handlers,
        state: 'opening',
        resolveOpen: () => {
          if (record.state === 'closed') {
            // 浏览器在设备确认前已断开：让设备把这条通道关掉，不再解析 open。
            try {
              session.socket.send(
                encodeServerFrame({ t: 'wsclose', id, code: 1001, reason: 'client-closed-before-open' }),
              );
            } catch {
              // 隧道已断，忽略
            }
            return;
          }
          record.state = 'open';
          clearTimeout(record.openTimer);
          resolve({
            id,
            send: (data: Buffer, binary: boolean) => this.sendWsData(session, id, data, binary),
            close: (code: number, reason: string) => this.closeWsChannel(session, id, code, reason),
          });
        },
        rejectOpen: (error: Error) => {
          record.state = 'closed';
          clearTimeout(record.openTimer);
          session.wsChannels.delete(id);
          reject(error);
        },
        openTimer: setTimeout(() => {
          record.state = 'closed';
          session.wsChannels.delete(id);
          reject(new ApiError(504, 'tunnel.ws_open_timeout', '等待设备建立 WebSocket 超时'));
        }, this.wsOpenTimeoutMs),
      };
      session.wsChannels.set(id, record);

      try {
        session.socket.send(encodeServerFrame(frame));
      } catch {
        record.rejectOpen(new ApiError(503, 'tunnel.device_offline', '设备连接已断开'));
      }
    });
  }

  /** TunnelControl：设备被撤销时立即关闭其隧道（含所有 WS 通道）。 */
  disconnectDevice(deviceId: string, reason: string): void {
    const session = this.sessions.get(deviceId);
    if (session) this.closeSession(session, reason, 4000);
  }

  close(): void {
    for (const session of [...this.sessions.values()]) {
      this.closeSession(session, 'server-shutdown', 1001);
    }
  }

  // ---------- 升级入口（由 buildApp 统一分发） ----------

  /** 签发一次性隧道票据（供 `POST /v1/tunnel/ticket` 调用）。 */
  issueTunnelTicket(identity: TunnelTicketIdentity): IssuedTunnelTicket {
    return this.tickets.issue(identity);
  }

  /**
   * 升级鉴权：优先消费 `?ticket=`（一次性、绑定 account/session/device）；
   * 无票据时仅在 allowBearer 显式打开时回落到旧版 Bearer。
   */
  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== TUNNEL_PATH) {
      this.rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const ticket = url.searchParams.get('ticket');
    if (ticket) {
      const identity = this.tickets.consume(ticket);
      if (!identity) {
        this.rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      const session = await findSessionById(this.pool, identity.sessionId);
      if (!session || session.account_id !== identity.accountId || session.revoked_at !== null) {
        this.rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.handleConnection(ws, identity.accountId, request.socket.remoteAddress ?? null, identity.deviceId);
      });
      return;
    }

    if (!this.allowBearer) {
      this.rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const token = this.extractToken(request, url);
    if (!token) {
      this.rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, this.options.jwtSecret);
    } catch (error) {
      this.rejectUpgrade(socket, 401, error instanceof AccessTokenExpiredError ? 'Token Expired' : 'Unauthorized');
      return;
    }

    const session = await findSessionById(this.pool, claims.sessionId);
    if (!session || session.account_id !== claims.accountId || session.revoked_at !== null) {
      this.rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, claims.accountId, request.socket.remoteAddress ?? null, null);
    });
  }

  // ---------- 内部实现 ----------

  private extractToken(request: IncomingMessage, url: URL): string | null {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim() || null;
    }
    return url.searchParams.get('token');
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private handleConnection(
    socket: WebSocket,
    accountId: string,
    remoteAddress: string | null,
    expectedDeviceId: string | null,
  ): void {
    let session: TunnelSession | null = null;
    const registrationTimer = setTimeout(() => {
      if (!session) socket.close(4001, 'register timeout');
    }, 10_000);

    socket.on('message', (data: RawData) => {
      void (async () => {
        try {
          const raw = data.toString();
          if (Buffer.byteLength(raw, 'utf8') > this.maxFrameBytes) {
            if (session) {
              void auditTunnelEvent(this.pool, {
                accountId: session.accountId,
                deviceId: session.deviceId,
                action: 'tunnel.frame_too_large',
                result: 'error',
                detail: { bytes: Buffer.byteLength(raw, 'utf8') },
              }).catch(() => undefined);
            }
            socket.close(1009, 'frame too large');
            return;
          }
          const frame = parseClientFrame(raw);
          if (!frame) {
            socket.close(4002, 'invalid frame');
            return;
          }

          if (!session) {
            if (frame.t !== 'register') {
              socket.close(4003, 'register required');
              return;
            }
            clearTimeout(registrationTimer);
            session = await this.registerSession(
              socket,
              accountId,
              remoteAddress,
              frame.deviceId,
              frame.protocol,
              expectedDeviceId,
            );
            return;
          }

          session.lastActivityAt = Date.now();
          switch (frame.t) {
            case 'ping':
              socket.send(JSON.stringify({ t: 'pong' }));
              break;
            case 'res':
              this.handleResponse(session, frame);
              break;
            case 'wsopen':
              this.handleWsOpenAck(session, frame);
              break;
            case 'wsdata':
              this.handleWsData(session, frame);
              break;
            case 'wsclose':
              this.handleWsClose(session, frame);
              break;
            case 'offline':
              this.closeSession(session, 'client-offline', 1000);
              break;
            default:
              break;
          }
        } catch {
          socket.close(1011, 'internal error');
        }
      })();
    });

    socket.on('close', () => {
      clearTimeout(registrationTimer);
      if (session) this.dropSession(session);
    });
    socket.on('error', () => {
      // 连接级错误交给 close 处理
    });
  }

  private async registerSession(
    socket: WebSocket,
    accountId: string,
    remoteAddress: string | null,
    deviceId: string,
    protocol: number,
    expectedDeviceId: string | null,
  ): Promise<TunnelSession | null> {
    // 兼容 v1 客户端（不分片）；更高版本一律拒绝，避免路由到未知帧语义。
    if (
      !Number.isInteger(protocol) ||
      protocol < MIN_TUNNEL_PROTOCOL_VERSION ||
      protocol > TUNNEL_PROTOCOL_VERSION
    ) {
      socket.close(4006, 'unsupported protocol');
      return null;
    }
    // 票据已绑定设备：register 帧必须声明同一设备，否则拒绝（一次性票据不能换设备使用）
    if (expectedDeviceId !== null && deviceId !== expectedDeviceId) {
      socket.close(4004, 'invalid device');
      return null;
    }
    const device = await findDeviceForTunnel(this.pool, deviceId);
    if (!device || device.account_id !== accountId || device.revoked_at !== null) {
      socket.close(4004, 'invalid device');
      return null;
    }

    const existing = this.sessions.get(deviceId);
    if (existing) this.closeSession(existing, 'replaced', 4000);

    const session: TunnelSession = {
      deviceId,
      accountId,
      socket,
      protocol,
      pending: new Map(),
      wsChannels: new Map(),
      reassembler: new WsFragmentReassembler({
        maxMessageBytes: this.wsMaxMessageBytes,
        timeoutMs: this.wsReassemblyTimeoutMs,
        maxPendingMessages: this.wsMaxPendingMessages,
        onDrop: (drop) => this.handleWsFragmentDrop(session, drop),
      }),
      lastActivityAt: Date.now(),
      heartbeatTimer: setInterval(() => this.heartbeat(session), this.heartbeatMs),
      closed: false,
      remoteAddress,
    };
    this.sessions.set(deviceId, session);
    if (typeof session.heartbeatTimer.unref === 'function') session.heartbeatTimer.unref();

    await markDeviceSeen(this.pool, deviceId, remoteAddress);
    socket.send(
      encodeServerFrame({
        t: 'registered',
        deviceId,
        heartbeatSec: this.heartbeatMs / 1000,
        maxInflight: this.maxInflight,
        protocol: TUNNEL_PROTOCOL_VERSION,
        features: ['wsdata-fragment'],
      }),
    );
    return session;
  }

  private heartbeat(session: TunnelSession): void {
    if (session.closed) return;
    if (Date.now() - session.lastActivityAt > this.offlineMs) {
      void markDeviceOffline(this.pool, session.deviceId).catch(() => undefined);
      this.closeSession(session, 'heartbeat-timeout', 4005);
      return;
    }
    try {
      session.socket.send(encodeServerFrame({ t: 'ping' }));
    } catch {
      this.closeSession(session, 'send-failed', 1011);
      return;
    }
    void markDeviceSeen(this.pool, session.deviceId, session.remoteAddress).catch(() => undefined);
  }

  private handleResponse(session: TunnelSession, frame: ResponseFrame): void {
    const pending = session.pending.get(frame.id);
    if (!pending) return;

    if (frame.status !== undefined && (typeof frame.status !== 'number' || frame.status < 100 || frame.status > 599)) {
      clearTimeout(pending.timer);
      session.pending.delete(frame.id);
      pending.reject(new ApiError(502, 'tunnel.bad_response', '设备返回了非法状态码'));
      return;
    }
    if (typeof frame.status === 'number') pending.status = frame.status;
    if (frame.headers) pending.headers = frame.headers;

    if (frame.more === true) {
      pending.chunks.push(decodeBase64Body(frame.body));
      return;
    }

    clearTimeout(pending.timer);
    session.pending.delete(frame.id);
    const body = Buffer.concat([...pending.chunks, decodeBase64Body(frame.body)]);
    pending.resolve({
      status: pending.status ?? 502,
      headers: pending.headers,
      body,
    });
  }

  private handleWsOpenAck(session: TunnelSession, frame: WsOpenAckFrame): void {
    const record = session.wsChannels.get(frame.id);
    if (!record || record.state !== 'opening') return;
    if (frame.ok) {
      record.resolveOpen();
      return;
    }
    record.rejectOpen(
      new ApiError(502, 'tunnel.ws_open_failed', frame.reason ?? `设备拒绝了 WebSocket 升级（${frame.status ?? 502}）`),
    );
  }

  private handleWsData(session: TunnelSession, frame: WsDataFrame): void {
    const record = session.wsChannels.get(frame.id);
    if (!record || record.state !== 'open') return;

    const result = session.reassembler.accept(frame.id, frame);
    if (result.status === 'complete') {
      record.handlers.onData(result.data, result.binary);
      return;
    }
    if (result.status === 'rejected') {
      if (result.reason === 'too_large') {
        void auditTunnelEvent(this.pool, {
          accountId: session.accountId,
          deviceId: session.deviceId,
          action: 'tunnel.frame_too_large',
          result: 'error',
          detail: { direction: 'device-to-client', reason: 'fragment_overflow' },
        }).catch(() => undefined);
      }
      const code = result.reason === 'invalid' ? 1002 : 1009;
      this.closeWsChannel(session, frame.id, code, `wsdata ${result.reason}`);
    }
  }

  private handleWsFragmentDrop(session: TunnelSession, drop: WsFragmentDrop): void {
    if (drop.reason !== 'timeout') return;
    void auditTunnelEvent(this.pool, {
      accountId: session.accountId,
      deviceId: session.deviceId,
      action: 'tunnel.ws_fragment_timeout',
      result: 'error',
      detail: { direction: 'device-to-client', channelId: drop.channelId, messageId: drop.messageId },
    }).catch(() => undefined);
    this.closeWsChannel(session, drop.channelId, 1009, 'ws fragment timeout');
  }

  private handleWsClose(session: TunnelSession, frame: WsCloseFrame): void {
    const record = session.wsChannels.get(frame.id);
    if (!record) return;
    if (record.state === 'opening') {
      record.rejectOpen(new ApiError(502, 'tunnel.ws_open_failed', frame.reason ?? '设备关闭了 WebSocket'));
      return;
    }
    const code = typeof frame.code === 'number' ? frame.code : 1000;
    const reason = frame.reason ?? '';
    record.state = 'closed';
    session.wsChannels.delete(record.id);
    session.reassembler.dropChannel(record.id);
    record.handlers.onClose(code, reason);
  }

  private sendWsData(session: TunnelSession, channelId: string, data: Buffer, binary: boolean): void {
    const record = session.wsChannels.get(channelId);
    if (!record || record.state !== 'open') return;

    if (data.length > this.wsMaxMessageBytes) {
      void auditTunnelEvent(this.pool, {
        accountId: session.accountId,
        deviceId: session.deviceId,
        action: 'tunnel.frame_too_large',
        result: 'error',
        detail: { direction: 'client-to-device', bytes: data.length, limit: this.wsMaxMessageBytes },
      }).catch(() => undefined);
      this.closeWsChannel(session, channelId, 1009, 'message too large');
      return;
    }

    try {
      if (session.protocol >= WS_FRAGMENT_PROTOCOL_VERSION) {
        const messageId = `m_${++this.wsMessageCounter}`;
        for (const frame of fragmentWsData({
          channelId,
          messageId,
          data,
          binary,
          chunkBytes: this.wsChunkBytes,
        })) {
          session.socket.send(encodeServerFrame(frame));
        }
      } else {
        // v1 客户端不认分片字段：保持一帧一条消息的旧行为。
        session.socket.send(encodeServerFrame({ t: 'wsdata', id: channelId, data: data.toString('base64'), binary }));
      }
    } catch {
      this.closeWsChannel(session, channelId, 1011, 'send-failed');
    }
  }

  private closeWsChannel(session: TunnelSession, channelId: string, code: number, reason: string): void {
    const record = session.wsChannels.get(channelId);
    if (!record) return;
    if (record.state === 'opening') {
      // 浏览器在设备确认 wsopen 之前就断开了（刷新/重连）：必须立刻释放名额，
      // 否则设备稍后回 wsopen 会把状态改成 open，而浏览器侧已无人关闭，
      // 该通道就永久占位，累积到上限后新连接全部 503。
      record.state = 'closed';
      session.wsChannels.delete(channelId);
      session.reassembler.dropChannel(channelId);
      clearTimeout(record.openTimer);
      try {
        session.socket.send(encodeServerFrame({ t: 'wsclose', id: channelId, code, reason }));
      } catch {
        // 隧道已断，忽略
      }
      record.rejectOpen(new ApiError(499, 'tunnel.ws_cancelled', '客户端已关闭'));
      return;
    }
    if (record.state !== 'open') return;
    record.state = 'closed';
    session.wsChannels.delete(channelId);
    session.reassembler.dropChannel(channelId);
    try {
      session.socket.send(encodeServerFrame({ t: 'wsclose', id: channelId, code, reason }));
    } catch {
      // 连接已断开，忽略
    }
    // 本地主动关闭（超限/重组超时等）也要通知浏览器侧，否则客户端会一直等待。
    try {
      record.handlers.onClose(code, reason);
    } catch {
      // 上层关闭回调异常不影响其他通道
    }
  }

  private closeSession(session: TunnelSession, reason: string, code: number): void {
    if (session.closed) return;
    session.closed = true;
    clearInterval(session.heartbeatTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ApiError(503, 'tunnel.device_offline', '设备连接已断开'));
    }
    session.pending.clear();
    for (const channel of session.wsChannels.values()) {
      clearTimeout(channel.openTimer);
      channel.state = 'closed';
    }
    session.wsChannels.clear();
    session.reassembler.reset();
    try {
      session.socket.close(code, reason);
    } catch {
      // 忽略已关闭连接
    }
    this.dropSession(session);
  }

  private dropSession(session: TunnelSession): void {
    session.closed = true;
    clearInterval(session.heartbeatTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ApiError(503, 'tunnel.device_offline', '设备连接已断开'));
    }
    session.pending.clear();
    for (const channel of session.wsChannels.values()) {
      clearTimeout(channel.openTimer);
      channel.state = 'closed';
    }
    session.wsChannels.clear();
    session.reassembler.reset();
    if (this.sessions.get(session.deviceId) === session) {
      this.sessions.delete(session.deviceId);
      void markDeviceOffline(this.pool, session.deviceId).catch(() => undefined);
    }
  }
}
