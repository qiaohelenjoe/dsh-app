/**
 * 隧道协议（api.md §3）：JSON 帧，正文 base64。
 *
 * v2 在 v1 之上增加 wsdata 分片（mid/seq/total/more），解决大帧超过单帧上限被丢弃的问题；
 * 未携带分片字段的 wsdata 仍按 v1 的“一帧一条完整消息”处理。
 */

export const TUNNEL_PROTOCOL_VERSION = 2;
/** 仍可接受的旧协议版本（v1 客户端不做分片，服务端也不向其发送分片）。 */
export const MIN_TUNNEL_PROTOCOL_VERSION = 1;
/** 首次支持 wsdata 分片的协议版本。 */
export const WS_FRAGMENT_PROTOCOL_VERSION = 2;
export const DEFAULT_HEARTBEAT_SEC = 25;
/** 心跳超时窗口：网络抖动时留出更长的容错，避免一次抖动就判离线。 */
export const DEFAULT_OFFLINE_SEC = 150;
/** 会话断开后延迟标记离线的时间：宽限期内重连成功不会出现「闪断」。 */
export const DEFAULT_RECONNECT_GRACE_SEC = 15;
/** 入站帧刷新 last_seen_at 的节流间隔（避免每帧写库）。 */
export const DEFAULT_SEEN_THROTTLE_SEC = 10;
export const DEFAULT_MAX_INFLIGHT = 32;
export const DEFAULT_MAX_WS_PER_DEVICE = 8;
export const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024; // 32 MiB（历史会话大消息）
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const WS_OPEN_TIMEOUT_MS = 10_000;
/** wsdata 分片大小（base64 编码后约 350 KiB，远低于单帧上限）。 */
export const DEFAULT_WS_CHUNK_BYTES = 256 * 1024;
/** 单条 WS 消息（分片重组后）上限，防止恶意/异常分片撑爆内存。 */
export const DEFAULT_WS_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** 单连接同时重组的所有半成品总字节上限（多消息并发时的内存兜底）。 */
export const DEFAULT_WS_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
/** 分片重组超时：超时丢弃半成品，避免丢失分片导致内存泄漏。 */
export const DEFAULT_WS_REASSEMBLY_TIMEOUT_MS = 30_000;
/** 单连接同时进行的分片重组消息数上限。 */
export const DEFAULT_MAX_PENDING_WS_MESSAGES = 64;
/** 单条消息允许的最大分片数（防止零字节分片绕过字节上限撑爆内存）。 */
export const DEFAULT_MAX_WS_FRAGMENTS = 4096;

export interface RegisterFrame {
  t: 'register';
  deviceId: string;
  protocol: number;
}

export interface PingFrame {
  t: 'ping';
}

export interface PongFrame {
  t: 'pong';
}

export interface ResponseFrame {
  t: 'res';
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: string | null;
  more?: boolean;
}

export interface OfflineFrame {
  t: 'offline';
  reason?: string;
}

/** 客户端（桌面端）对 wsopen 的确认。 */
export interface WsOpenAckFrame {
  t: 'wsopen';
  id: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface WsDataFrame {
  t: 'wsdata';
  id: string;
  data: string;
  binary?: boolean;
  /** 分片消息 id：同一通道并发多条消息时用于区分。未分片消息省略。 */
  mid?: string;
  /** 分片序号（从 0 开始）。未分片消息省略。 */
  seq?: number;
  /** 分片总数。未分片消息省略。 */
  total?: number;
  /** 是否还有后续分片；最后一片为 false。未分片消息省略。 */
  more?: boolean;
}

export interface WsCloseFrame {
  t: 'wsclose';
  id: string;
  code?: number;
  reason?: string;
}

export type ClientFrame =
  | RegisterFrame
  | PingFrame
  | PongFrame
  | ResponseFrame
  | OfflineFrame
  | WsOpenAckFrame
  | WsDataFrame
  | WsCloseFrame;

export interface RegisteredFrame {
  t: 'registered';
  deviceId: string;
  heartbeatSec: number;
  maxInflight: number;
  /** 服务端当前协议版本（新客户端可据此协商）。 */
  protocol?: number;
  /** 服务端能力列表，目前只有 `wsdata-fragment`。 */
  features?: string[];
}

export interface ServerPingFrame {
  t: 'ping';
}

export interface RequestFrame {
  t: 'req';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

/** 服务端要求桌面端在本机建立 WebSocket。 */
export interface WsOpenFrame {
  t: 'wsopen';
  id: string;
  path: string;
  headers: Record<string, string>;
  protocol?: number;
}

export type ServerFrame = RegisteredFrame | ServerPingFrame | RequestFrame | WsOpenFrame | WsDataFrame | WsCloseFrame;

export interface TunnelHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface TunnelHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** 路径白名单（spec §9 / api.md §3.3）：命中黑名单优先拒绝。 */
const PATH_ALLOW = [/^\/$/, /^\/api\//, /^\/assets\//, /^\/plugins\//, /^\/dsh-whale\//, /^\/dsh-market\//, /^\/open-in-app\//, /^\/bsk-observation\//,
  /^\/mcp-connector\//, /^\/favicon/, /^\/manifest/];
const PATH_DENY = [
  /^\/connect(\/|$)/,
  /^\/api\/pair(\/|$)/,
  /^\/api\/plugin-manager(\/|$)/,
  /^\/api\/update(\/|$)/,
];

export function isTunnelPathAllowed(pathAndQuery: string): boolean {
  const pathname = pathAndQuery.split('?')[0] ?? '/';
  if (PATH_DENY.some((pattern) => pattern.test(pathname))) return false;
  return PATH_ALLOW.some((pattern) => pattern.test(pathname));
}

export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as { t?: unknown };
  if (typeof frame.t !== 'string') return null;
  return parsed as ClientFrame;
}

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

/** 1004/1005/1006/1015 等为保留码，不能作为发送侧关闭码；统一回落到 1000。 */
export function normalizeWsCloseCode(code: number | undefined): number {
  if (typeof code !== 'number' || !Number.isInteger(code)) return 1000;
  if (code === 1000) return code;
  if (code >= 1001 && code <= 1013 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

export function decodeBase64Body(body: string | null | undefined): Buffer {
  if (!body) return Buffer.alloc(0);
  return Buffer.from(body, 'base64');
}
