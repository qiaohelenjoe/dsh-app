import { WebSocket } from 'ws';
import type { LocalRequestInput, LocalResponseResult } from './dsh-credentials.js';
import {
  DEFAULT_WS_CHUNK_BYTES,
  DEFAULT_WS_MAX_MESSAGE_BYTES,
  DEFAULT_WS_REASSEMBLY_TIMEOUT_MS,
  DEFAULT_MAX_PENDING_WS_MESSAGES,
  WS_FRAGMENT_PROTOCOL_VERSION,
  WsFragmentReassembler,
  fragmentWsData,
  type WsDataFrame,
  type WsFragmentDrop,
} from './ws-fragment.js';

export type TunnelStatus = 'stopped' | 'connecting' | 'online' | 'reconnecting' | 'fatal';

export interface LocalWsOpenInput {
  path: string;
  headers: Record<string, string>;
  onMessage: (data: Buffer, binary: boolean) => void;
  onClose: (code: number, reason: string) => void;
}

export interface LocalWsHandle {
  send(data: Buffer, binary: boolean): void;
  close(code: number, reason: string): void;
}

export interface TunnelClientOptions {
  serverBaseUrl: string;
  deviceId: string;
  getAccessToken: () => Promise<string | null>;
  /** access token 失效时刷新；返回新的 access token 或 null */
  refreshAccessToken: () => Promise<string | null>;
  /** 建链前申请一次性隧道票据（R06）；缺省回落到旧版 Bearer（仅兼容/回滚用）。 */
  getTunnelTicket?: (accessToken: string) => Promise<string | null>;
  forwardLocalRequest: (input: LocalRequestInput) => Promise<LocalResponseResult>;
  openLocalWebSocket: (input: LocalWsOpenInput) => Promise<LocalWsHandle>;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** HTTP res 分块大小，同时作为 wsdata 分片大小（默认 256 KiB）。 */
  chunkBytes?: number;
  /** 单条 WS 消息（分片重组后）上限（默认 64 MiB）。 */
  wsMessageMaxBytes?: number;
  /** 分片重组超时（默认 30 秒）。 */
  wsFragmentTimeoutMs?: number;
  /** 单连接同时重组的消息数上限（默认 64）。 */
  wsMaxPendingMessages?: number;
  onStatusChange?: (status: TunnelStatus, detail?: string) => void;
  log?: (message: string) => void;
}

interface ResFrame {
  t: 'res';
  id: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string | null;
  more?: boolean;
}

/** 桌面端当前实现的隧道协议版本（v2：wsdata 分片）。 */
const TUNNEL_PROTOCOL_VERSION = 2;

/**
 * 桌面端隧道客户端：出站 WSS、register 握手、心跳、req/res 转发、
 * wsopen/wsdata/wsclose 双向代理、指数退避重连（上限 30 秒）。
 */
export class TunnelClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private online = false;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private status: TunnelStatus = 'stopped';
  private readonly channels = new Map<string, LocalWsHandle>();
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly chunkBytes: number;
  private readonly wsMessageMaxBytes: number;
  private readonly reassembler: WsFragmentReassembler;
  /** 协商后的协议版本：连接旧服务端（4006）时回落到 v1，关闭分片。 */
  private protocolVersion = TUNNEL_PROTOCOL_VERSION;
  private messageCounter = 0;

  constructor(private readonly options: TunnelClientOptions) {
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_WS_CHUNK_BYTES;
    this.wsMessageMaxBytes = options.wsMessageMaxBytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
    this.reassembler = new WsFragmentReassembler({
      maxMessageBytes: this.wsMessageMaxBytes,
      timeoutMs: options.wsFragmentTimeoutMs ?? DEFAULT_WS_REASSEMBLY_TIMEOUT_MS,
      maxPendingMessages: options.wsMaxPendingMessages ?? DEFAULT_MAX_PENDING_WS_MESSAGES,
      onDrop: (drop) => this.handleFragmentDrop(drop),
    });
  }

  get isOnline(): boolean {
    return this.online;
  }

  start(): void {
    if (this.stopped && this.status === 'stopped') {
      this.stopped = false;
    }
    this.stopped = false;
    this.connect();
  }

  stop(reason = 'plugin-stop'): void {
    this.stopped = true;
    this.online = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const channel of this.channels.values()) channel.close(1001, reason);
    this.channels.clear();
    this.reassembler.reset();
    try {
      this.socket?.close(1000, reason);
    } catch {
      // 忽略
    }
    this.socket = null;
    this.setStatus('stopped');
  }

  /** 主动告知服务端下线（登出 / 退出前）。 */
  sendOfflineAndStop(): void {
    try {
      this.socket?.send(JSON.stringify({ t: 'offline' }));
    } catch {
      // 忽略
    }
    this.stop('offline');
  }

  private setStatus(status: TunnelStatus, detail?: string): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status, detail);
  }

  private log(message: string): void {
    this.options.log?.(`[tunnel] ${message}`);
  }

  private wsUrl(ticket: string | null): string {
    const base = this.options.serverBaseUrl.replace(/\/$/, '');
    const url = `${base.replace(/^http/, 'ws')}/v1/tunnel`;
    return ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    let token = await this.options.getAccessToken().catch(() => null);
    if (!token) token = await this.options.refreshAccessToken().catch(() => null);
    if (!token) {
      this.log('没有可用的 access token，稍后重试');
      this.scheduleReconnect('no-token');
      return;
    }

    // 票据一次性（R06）：每次建链前重新申请；申请失败时刷新令牌再试一次
    let ticket: string | null = null;
    if (this.options.getTunnelTicket) {
      ticket = await this.options.getTunnelTicket(token).catch(() => null);
      if (!ticket) {
        const refreshed = await this.options.refreshAccessToken().catch(() => null);
        if (refreshed) ticket = await this.options.getTunnelTicket(refreshed).catch(() => null);
      }
      if (!ticket) {
        this.log('申请隧道票据失败，稍后重试');
        this.scheduleReconnect('no-ticket');
        return;
      }
    }

    // 分片帧大小 = base64(chunkBytes) + JSON 头；按配置留足余量，默认仍远小于 2 MiB。
    const frameBudget = Math.ceil((this.chunkBytes * 4) / 3) + 64 * 1024;
    const socket = new WebSocket(this.wsUrl(ticket), {
      ...(ticket ? {} : { headers: { authorization: `Bearer ${token}` } }),
      maxPayload: Math.max(2 * 1024 * 1024, frameBudget),
    });
    this.socket = socket;

    socket.on('open', () => {
      this.log(`已连接，发送 register（protocol=${this.protocolVersion}）`);
      socket.send(JSON.stringify({ t: 'register', deviceId: this.options.deviceId, protocol: this.protocolVersion }));
    });

    socket.on('message', (data) => {
      void this.handleFrame(data.toString());
    });

    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 401) {
        this.log('隧道鉴权失败（401），重新申请票据后重连');
        void (async () => {
          const refreshed = await this.options.refreshAccessToken().catch(() => null);
          // 票据模式下即使刷新失败也应重试（可能只是票据过期/已消费）
          if (refreshed || this.options.getTunnelTicket) {
            this.scheduleReconnect('auth-refreshed', 0);
          } else {
            this.setStatus('fatal', 'unauthorized');
          }
        })();
        return;
      }
      this.scheduleReconnect(`http-${response.statusCode}`);
    });

    socket.on('close', (code, reason) => {
      this.online = false;
      this.reassembler.reset();
      for (const channel of this.channels.values()) channel.close(1001, 'tunnel-closed');
      this.channels.clear();

      // 旧服务端只接受 protocol=1：回落一次，关闭 wsdata 分片（大帧仍受对端限制）。
      if (code === 4006 && this.protocolVersion >= WS_FRAGMENT_PROTOCOL_VERSION) {
        this.log('服务端不支持隧道协议 v2，回落到 v1（wsdata 分片不可用）');
        this.protocolVersion = 1;
        this.scheduleReconnect('protocol-downgrade', 0);
        return;
      }
      if (code === 4000) {
        // 被新连接踢掉 / 设备被撤销：停止重连，等待重新登录
        this.log(`隧道被服务端关闭（${reason.toString() || code}），停止重连`);
        this.setStatus('fatal', reason.toString() || 'replaced');
        this.stop('closed-by-server');
        return;
      }
      if (this.stopped) return;
      this.scheduleReconnect(`close-${code}`);
    });

    socket.on('error', () => {
      // 交给 close 处理
    });
  }

  private scheduleReconnect(reason: string, overrideDelayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    this.online = false;
    const delay =
      overrideDelayMs ??
      Math.min(this.backoffMaxMs, this.backoffBaseMs * Math.pow(2, Math.min(this.attempts, 10)));
    this.attempts += 1;
    this.log(`将在 ${delay}ms 后重连（${reason}）`);
    this.setStatus('reconnecting', reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async handleFrame(raw: string): Promise<void> {
    let frame: { t?: string; [key: string]: unknown };
    try {
      frame = JSON.parse(raw) as { t?: string; [key: string]: unknown };
    } catch {
      return;
    }

    switch (frame.t) {
      case 'registered':
        this.online = true;
        this.attempts = 0;
        this.setStatus('online');
        this.log('隧道已上线');
        break;
      case 'ping':
        this.socket?.send(JSON.stringify({ t: 'pong' }));
        break;
      case 'req':
        await this.handleRequest(frame as unknown as { id: string; method: string; path: string; headers?: Record<string, string>; body?: string | null });
        break;
      case 'wsopen':
        await this.handleWsOpen(frame as unknown as { id: string; path: string; headers?: Record<string, string> });
        break;
      case 'wsdata': {
        const id = frame['id'] as string;
        const channel = this.channels.get(id);
        if (!channel) break;
        const result = this.reassembler.accept(id, frame as unknown as WsDataFrame);
        if (result.status === 'complete') {
          channel.send(result.data, result.binary);
        } else if (result.status === 'rejected') {
          this.log(`wsdata 分片重组失败（${result.reason}），关闭通道 ${id}`);
          this.reassembler.dropChannel(id);
          this.closeLocalChannel(id, result.reason === 'invalid' ? 1002 : 1009, `wsdata ${result.reason}`);
        }
        break;
      }
      case 'wsclose': {
        const id = frame['id'] as string;
        const channel = this.channels.get(id);
        if (channel) channel.close((frame['code'] as number) ?? 1000, (frame['reason'] as string) ?? '');
        this.channels.delete(id);
        this.reassembler.dropChannel(id);
        break;
      }
      default:
        break;
    }
  }

  private async handleRequest(frame: {
    id: string;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | null;
  }): Promise<void> {
    let result: LocalResponseResult;
    try {
      result = await this.options.forwardLocalRequest({
        method: frame.method,
        path: frame.path,
        headers: frame.headers ?? {},
        body: frame.body ? Buffer.from(frame.body, 'base64') : null,
      });
    } catch (error) {
      result = {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: Buffer.from(`local forward error: ${(error as Error).message}${(error as any)?.cause ? " / " + String((error as any).cause) : ""}`),
      };
    }
    this.sendResponse(frame.id, result);
  }

  private sendResponse(id: string, result: LocalResponseResult): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const body = result.body ?? Buffer.alloc(0);
    if (body.length <= this.chunkBytes) {
      socket.send(
        JSON.stringify({
          t: 'res',
          id,
          status: result.status,
          headers: result.headers,
          body: body.toString('base64'),
          more: false,
        } satisfies ResFrame & { t: 'res' }),
      );
      return;
    }
    for (let offset = 0; offset < body.length; offset += this.chunkBytes) {
      const chunk = body.subarray(offset, offset + this.chunkBytes);
      const isLast = offset + this.chunkBytes >= body.length;
      socket.send(
        JSON.stringify({
          t: 'res',
          id,
          status: result.status,
          headers: result.headers,
          body: chunk.toString('base64'),
          more: !isLast,
        }),
      );
    }
  }

  private async handleWsOpen(frame: {
    id: string;
    path: string;
    headers?: Record<string, string>;
  }): Promise<void> {
    try {
      const channel = await this.options.openLocalWebSocket({
        path: frame.path,
        headers: frame.headers ?? {},
        onMessage: (data, binary) => {
          this.sendWsMessage(frame.id, data, binary);
        },
        onClose: (code, reason) => {
          this.channels.delete(frame.id);
          this.reassembler.dropChannel(frame.id);
          this.socket?.send(JSON.stringify({ t: 'wsclose', id: frame.id, code, reason }));
        },
      });
      this.channels.set(frame.id, channel);
      this.socket?.send(JSON.stringify({ t: 'wsopen', id: frame.id, ok: true }));
    } catch (error) {
      this.socket?.send(
        JSON.stringify({
          t: 'wsopen',
          id: frame.id,
          ok: false,
          status: 502,
          reason: (error as Error).message,
        }),
      );
    }
  }

  /** 本机 DSH → 服务端：按协商版本切分大消息（v1 服务端保持单帧旧行为）。 */
  private sendWsMessage(channelId: string, data: Buffer, binary: boolean): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    if (data.length > this.wsMessageMaxBytes) {
      this.log(`WS 消息超过上限（${data.length} > ${this.wsMessageMaxBytes}），关闭通道 ${channelId}`);
      this.closeLocalChannel(channelId, 1009, 'message too large');
      return;
    }

    try {
      if (this.protocolVersion >= WS_FRAGMENT_PROTOCOL_VERSION) {
        const messageId = `m_${++this.messageCounter}`;
        for (const frame of fragmentWsData({
          channelId,
          messageId,
          data,
          binary,
          chunkBytes: this.chunkBytes,
        })) {
          socket.send(JSON.stringify(frame));
        }
      } else {
        socket.send(JSON.stringify({ t: 'wsdata', id: channelId, data: data.toString('base64'), binary }));
      }
    } catch {
      this.closeLocalChannel(channelId, 1011, 'send-failed');
    }
  }

  private handleFragmentDrop(drop: WsFragmentDrop): void {
    if (drop.reason !== 'timeout') return;
    this.log(`wsdata 分片重组超时，关闭通道 ${drop.channelId}`);
    this.closeLocalChannel(drop.channelId, 1009, 'ws fragment timeout');
  }

  private closeLocalChannel(channelId: string, code: number, reason: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    try {
      channel.close(code, reason);
    } catch {
      // 忽略已关闭连接；onClose 会向服务端发 wsclose
    }
  }
}
