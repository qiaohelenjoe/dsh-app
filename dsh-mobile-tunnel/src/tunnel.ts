import { WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';
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

/** 隧道运行状态快照（排障用，不含任何凭据）。 */
export interface TunnelDiagnostics {
  status: TunnelStatus;
  online: boolean;
  attempts: number;
  protocolVersion: number;
  deviceId: string;
  serverBaseUrl: string;
  lastConnectedAt: string | null;
  lastFrameAt: string | null;
  lastError: string | null;
  connectTimeoutMs: number;
  keepaliveMs: number;
  deadAfterMs: number;
  backoffMaxMs: number;
}

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
  /** 建链超时：握手/注册超时后强制重建（默认 10 秒）。 */
  connectTimeoutMs?: number;
  /** 客户端主动保活间隔（默认 25 秒）。 */
  keepaliveMs?: number;
  /** 超过这么久没有任何入站数据即判定死连接（默认 75 秒）。 */
  deadAfterMs?: number;
  /** 网络变化检测间隔（默认 10 秒）。 */
  networkWatchMs?: number;
  /** 读取本机网卡地址（测试可注入；默认读 node:os）。 */
  listNetworkAddresses?: () => string[];
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
 * wsopen/wsdata/wsclose 双向代理、指数退避重连（封顶 10 秒、带抖动）。
 */
export class TunnelClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private online = false;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private status: TunnelStatus = 'stopped';
  private readonly channels = new Map<string, LocalWsHandle>();
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly connectTimeoutMs: number;
  private readonly keepaliveMs: number;
  private deadAfterMs: number;
  private readonly deadAfterConfigured: boolean;
  private readonly networkWatchMs: number;
  private readonly chunkBytes: number;
  private readonly wsMessageMaxBytes: number;
  private readonly reassembler: WsFragmentReassembler;
  /** 协商后的协议版本：连接旧服务端（4006）时回落到 v1，关闭分片。 */
  private protocolVersion = TUNNEL_PROTOCOL_VERSION;
  private messageCounter = 0;
  /** 每次建链自增，用于丢弃旧 socket 的迟到事件。 */
  private connectGeneration = 0;
  private lastInboundAt = 0;
  private lastFrameAt = 0;
  private lastConnectedAt = 0;
  private lastError: string | null = null;
  private lastNetworkSignature = '';

  constructor(private readonly options: TunnelClientOptions) {
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 10_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.keepaliveMs = options.keepaliveMs ?? 25_000;
    this.deadAfterMs = options.deadAfterMs ?? 75_000;
    this.deadAfterConfigured = options.deadAfterMs !== undefined;
    this.networkWatchMs = options.networkWatchMs ?? 10_000;
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

  /** 诊断快照（供宿主只读接口 / 状态卡片使用）。 */
  getDiagnostics(): TunnelDiagnostics {
    return {
      status: this.status,
      online: this.online,
      attempts: this.attempts,
      protocolVersion: this.protocolVersion,
      deviceId: this.options.deviceId,
      serverBaseUrl: this.options.serverBaseUrl,
      lastConnectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
      lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      lastError: this.lastError,
      connectTimeoutMs: this.connectTimeoutMs,
      keepaliveMs: this.keepaliveMs,
      deadAfterMs: this.deadAfterMs,
      backoffMaxMs: this.backoffMaxMs,
    };
  }

  start(): void {
    this.stopped = false;
    this.startNetworkWatch();
    this.connect();
  }

  stop(reason = 'plugin-stop'): void {
    this.stopped = true;
    this.online = false;
    this.stopReconnectTimer();
    this.clearConnectTimer();
    this.stopKeepalive();
    this.stopNetworkWatch();
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
    const generation = ++this.connectGeneration;
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
    if (this.stopped || generation !== this.connectGeneration) return;

    // 分片帧大小 = base64(chunkBytes) + JSON 头；按配置留足余量，默认仍远小于 2 MiB。
    const frameBudget = Math.ceil((this.chunkBytes * 4) / 3) + 64 * 1024;
    const socket = new WebSocket(this.wsUrl(ticket), {
      ...(ticket ? {} : { headers: { authorization: `Bearer ${token}` } }),
      maxPayload: Math.max(2 * 1024 * 1024, frameBudget),
    });
    this.socket = socket;

    // 连接超时：握手/注册迟迟不完成（弱网、NAT 黑洞）时强制重建，避免永远卡在 connecting
    const timer = setTimeout(() => {
      if (generation !== this.connectGeneration) return;
      this.log(`连接超时（${this.connectTimeoutMs}ms 未完成注册），强制重建`);
      this.hardReconnect(socket, generation, 'connect-timeout');
    }, this.connectTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.connectTimer = timer;

    socket.on('open', () => {
      if (generation !== this.connectGeneration) return;
      this.log(`已连接，发送 register（protocol=${this.protocolVersion}）`);
      socket.send(JSON.stringify({ t: 'register', deviceId: this.options.deviceId, protocol: this.protocolVersion }));
    });

    socket.on('message', (data) => {
      if (generation !== this.connectGeneration) return;
      const now = Date.now();
      this.lastInboundAt = now;
      this.lastFrameAt = now;
      void this.handleFrame(data.toString());
    });

    socket.on('unexpected-response', (_request, response) => {
      if (generation !== this.connectGeneration) return;
      this.clearConnectTimer();
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
      if (generation !== this.connectGeneration) return;
      this.clearConnectTimer();
      this.stopKeepalive();
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

    socket.on('error', (error) => {
      this.lastError = `socket-error: ${(error as Error).message}`;
      // 交给 close 处理
    });
  }

  /** 丢弃当前 socket 并立即重连（连接超时、死连接、网络变化时用）。 */
  private hardReconnect(socket: WebSocket | null, generation: number, reason: string): void {
    if (generation !== this.connectGeneration) return;
    this.lastError = reason;
    this.clearConnectTimer();
    this.stopKeepalive();
    this.online = false;
    this.connectGeneration += 1;
    try {
      socket?.terminate();
    } catch {
      // 忽略
    }
    this.socket = null;
    if (this.stopped) return;
    this.scheduleReconnect(reason, 0);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 客户端保活：定期 ping，并在长时间无入站数据时判定连接已死。 */
  private startKeepalive(): void {
    this.stopKeepalive();
    this.lastInboundAt = Date.now();
    const timer = setInterval(() => this.checkKeepalive(), this.keepaliveMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.keepaliveTimer = timer;
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private checkKeepalive(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.online) return;
    if (this.deadAfterMs > 0 && Date.now() - this.lastInboundAt > this.deadAfterMs) {
      this.log(`超过 ${this.deadAfterMs}ms 未收到任何数据，判定连接已死，强制重连`);
      this.hardReconnect(socket, this.connectGeneration, 'keepalive-timeout');
      return;
    }
    try {
      socket.send(JSON.stringify({ t: 'ping' }));
    } catch (error) {
      this.lastError = `ping-failed: ${(error as Error).message}`;
      this.hardReconnect(socket, this.connectGeneration, 'ping-send-failed');
    }
  }

  /** 网卡地址变化（切 Wi-Fi、插拔网线、VPN 起停、休眠唤醒）时立即重连。 */
  private startNetworkWatch(): void {
    if (this.networkTimer) return;
    this.lastNetworkSignature = this.networkSignature();
    const timer = setInterval(() => {
      const signature = this.networkSignature();
      if (signature === this.lastNetworkSignature) return;
      this.lastNetworkSignature = signature;
      this.log('检测到网络变化，立即重连');
      this.attempts = 0;
      const socket = this.socket;
      if (!socket) {
        this.stopReconnectTimer();
        void this.connect();
        return;
      }
      this.hardReconnect(socket, this.connectGeneration, 'network-changed');
    }, this.networkWatchMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.networkTimer = timer;
  }

  private stopNetworkWatch(): void {
    if (this.networkTimer) {
      clearInterval(this.networkTimer);
      this.networkTimer = null;
    }
  }

  private networkSignature(): string {
    const addresses = this.options.listNetworkAddresses
      ? this.options.listNetworkAddresses()
      : defaultNetworkAddresses();
    return addresses.slice().sort().join(',');
  }

  private scheduleReconnect(reason: string, overrideDelayMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;
    this.online = false;
    this.lastError = reason;
    // 抖动：避免多台设备在同一时刻集中重连
    const base =
      overrideDelayMs ??
      Math.min(this.backoffMaxMs, this.backoffBaseMs * Math.pow(2, Math.min(this.attempts, 10)));
    const jitter = overrideDelayMs === undefined ? 0.7 + Math.random() * 0.6 : 1;
    const delay = Math.max(0, Math.round(base * jitter));
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
      case 'registered': {
        this.clearConnectTimer();
        this.online = true;
        this.attempts = 0;
        this.lastConnectedAt = Date.now();
        this.lastInboundAt = Date.now();
        const heartbeatSec = typeof frame['heartbeatSec'] === 'number' ? frame['heartbeatSec'] : null;
        if (heartbeatSec && heartbeatSec > 0 && !this.deadAfterConfigured) {
          // 未显式配置时，死连接阈值取心跳间隔的 3 倍（不低于默认 75 秒的语义）
          this.deadAfterMs = Math.max(this.deadAfterMs, heartbeatSec * 1000 * 3);
        }
        this.startKeepalive();
        this.setStatus('online');
        this.log('隧道已上线');
        break;
      }
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

/** 非回环网卡地址集合：用于检测 Wi-Fi/有线的切换与断开。 */
function defaultNetworkAddresses(): string[] {
  const result: string[] = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] ?? []) {
      if (info.internal) continue;
      if (!info.address) continue;
      result.push(`${name}:${info.address}`);
    }
  }
  return result;
}
