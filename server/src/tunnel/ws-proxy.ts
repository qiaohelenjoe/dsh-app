import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { findSessionById } from '../auth/repositories/sessions.js';
import type { DbPool } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { AccessTokenExpiredError, verifyAccessToken } from '../security/tokens.js';
import { DEFAULT_MAX_FRAME_BYTES, isTunnelPathAllowed, normalizeWsCloseCode } from './protocol.js';
import type { TunnelRegistry } from './registry.js';
import { auditTunnelEvent, findDeviceForTunnel } from './repository.js';

export interface WsProxyOptions {
  pool: DbPool;
  jwtSecret: string;
  registry: TunnelRegistry;
  maxFrameBytes?: number;
}

const DEVICE_PATH_PATTERN = /^\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/;

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

const FORWARDED_HEADERS = ['accept', 'origin', 'user-agent', 'sec-websocket-protocol', 'accept-language'];

/**
 * 客户端（浏览器/手机 WebView）→ 服务端 → 隧道 → 桌面端本地 WS 的升级与双向转发。
 * 与 T07 的普通 HTTP 代理共用 `/t/:deviceId/*` 入口，按 Upgrade 头分流。
 */
export class WsProxyServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly options: WsProxyOptions) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      // 公网链路下 mux 的 JSON 帧（会话/工作区数据）体积大、压缩率高。
      // DSH 客户端只有 15s 的实时连接初始化窗口，不压缩会让首同步超时，
      // 进而使 Remote 插件装配失败（表现为「文件资源服务不可用」）。
      perMessageDeflate: {
        threshold: 1024,
        zlibDeflateOptions: { level: 3 },
      },
    });
  }

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const cookies = parseCookieHeader(request.headers.cookie);
    // 根路径模式：设备由 dsh_device cookie 决定（DSH 前端只支持挂在根路径）
    const match = DEVICE_PATH_PATTERN.exec(url.pathname);
    const cookieDevice = cookies['dsh_device'];
    const deviceId = match ? (match[1] as string) : cookieDevice;
    if (!deviceId) {
      this.reject(socket, 404, 'Not Found');
      return;
    }
    const forwardedPathRaw = match ? url.pathname.slice(`/t/${deviceId}`.length) || '/' : url.pathname;
    // token 只用于服务端鉴权，不能透传给桌面端
    const forwardedQuery = new URLSearchParams(url.search);
    forwardedQuery.delete('token');
    const query = forwardedQuery.toString();
    const forwardedPath = `${forwardedPathRaw}${query ? `?${query}` : ''}`;

    const token = this.extractToken(request, url);
    if (!token) {
      this.reject(socket, 401, 'Unauthorized');
      return;
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, this.options.jwtSecret);
    } catch (error) {
      this.reject(socket, 401, error instanceof AccessTokenExpiredError ? 'Token Expired' : 'Unauthorized');
      return;
    }

    const session = await findSessionById(this.options.pool, claims.sessionId);
    if (!session || session.account_id !== claims.accountId || session.revoked_at !== null) {
      this.reject(socket, 401, 'Unauthorized');
      return;
    }

    const device = await findDeviceForTunnel(this.options.pool, deviceId);
    // 未注册 / 已撤销 / 非本账号：统一 503，避免泄漏设备是否存在
    if (!device || device.account_id !== claims.accountId || device.revoked_at !== null) {
      this.reject(socket, 503, 'Service Unavailable');
      return;
    }
    if (!isTunnelPathAllowed(forwardedPath)) {
      await auditTunnelEvent(this.options.pool, {
        accountId: claims.accountId,
        deviceId,
        action: 'tunnel.path_denied',
        result: 'denied',
        detail: { path: forwardedPath, method: 'WS' },
      });
      this.reject(socket, 403, 'Forbidden');
      return;
    }
    if (!this.options.registry.isOnline(deviceId)) {
      this.reject(socket, 503, 'Service Unavailable');
      return;
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    let channel;
    let client: WebSocket | null = null;
    let lastOpenError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        channel = await this.options.registry.openWsChannel(deviceId, { path: forwardedPath, headers }, {
        onData: (data, binary) => {
          if (client && client.readyState === WebSocket.OPEN) client.send(data, { binary });
        },
        onClose: (code, reason) => {
          console.log('[ws-upstream-close]', deviceId, forwardedPath, code, String(reason).slice(0, 80));
          if (client && (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING)) {
            client.close(normalizeWsCloseCode(code), reason);
          }
        },
        });
      } catch (error) {
        lastOpenError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
      }
    }
    if (!channel) {
      const error = lastOpenError;
      const status = error instanceof ApiError ? error.statusCode : 502;
      console.log('[ws-open-fail]', deviceId, forwardedPath, status, String((error as Error)?.message ?? error).slice(0, 160));
      this.reject(socket, status, 'Bad Gateway');
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const wsClient = ws;
      client = ws;
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      wsClient.on('message', (data, isBinary) => {
        channel.send(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), isBinary);
      });
      wsClient.on('close', (code, reason) => {
        console.log('[ws-client-close]', deviceId, forwardedPath, code, reason.toString().slice(0, 80));
        channel.close(code === 0 ? 1000 : code, reason.toString());
        if (code === 1009) {
          void auditTunnelEvent(this.options.pool, {
            accountId: claims.accountId,
            deviceId,
            action: 'tunnel.frame_too_large',
            result: 'error',
            detail: { direction: 'client-to-device' },
          }).catch(() => undefined);
        }
      });
      wsClient.on('error', (error: Error) => {
        // ws 在超出 maxPayload 时会先触发 error（Max payload size exceeded）再以 1006 本地关闭，
        // 远端看到的是 1009；这里统一记录并审计。
        if (/max payload/i.test(error.message)) {
          void auditTunnelEvent(this.options.pool, {
            accountId: claims.accountId,
            deviceId,
            action: 'tunnel.frame_too_large',
            result: 'error',
            detail: { direction: 'client-to-device' },
          }).catch(() => undefined);
          channel.close(1009, 'frame too large');
          return;
        }
        channel.close(1011, 'client-error');
      });
    });
  }

  /** 关闭所有客户端连接（preClose 阶段调用，避免 http.Server 等待升级连接）。 */
  close(): void {
    for (const client of [...this.clients]) {
      try {
        client.terminate();
      } catch {
        // 忽略已关闭连接
      }
    }
    this.clients.clear();
    this.wss.close();
  }

  private extractToken(request: IncomingMessage, url: URL): string | null {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim() || null;
    }
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
    const cookieToken = parseCookieHeader(request.headers.cookie)['dsh_access'];
    return cookieToken ?? null;
  }

  private reject(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}
