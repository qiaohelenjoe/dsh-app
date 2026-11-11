import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHostService, type DshHostContext } from './host.js';
import { isPanelSession, type PanelSessionStore } from './panel-session.js';
import {
  FS_FILE_ROUTE,
  FS_LIST_ROUTE,
  FS_ROOTS_ROUTE,
  handleFsFile,
  handleFsList,
  handleFsRoots,
} from './fs-routes.js';

/**
 * 把面板会话暴露给浏览器侧插件（同源 JSON 接口）。
 *
 * 只注册在 DSH 自己的 Web 服务上：面板与接口同源，浏览器存储不再承担持久化职责；
 * 同源校验避免任意网页读到 refresh token。宿主机若没有 `webServer` 服务（老版本），
 * 注册会安静放弃，浏览器侧自动回落 sessionStorage（行为与改动前一致）。
 */
export const PANEL_SESSION_ROUTE = '/plugins/dsh-mobile-tunnel/panel-session';

/**
 * 移动端文件面板需要的会话上下文（只读）。
 *
 * 文件树/预览走 `remote.workspaceFiles.<method>(sessionId, path)`，而 sessionId 只有
 * 官方 sidebar tab 组件内部才持有。这里从 `~/.dsh/sessions/<workspace>/session-<id>/`
 * 里取**最近活跃**的会话，供我们自己的面板使用；不改任何数据。
 */
export const WORKSPACE_ROUTE = '/plugins/dsh-mobile-tunnel/workspace';

/** 客户端自报诊断日志：写本机文件，供排查用（只追加文本，不接受任意路径）。 */
export const DIAG_ROUTE = '/plugins/dsh-mobile-tunnel/diag';
export const DIAG_LOG = join(homedir(), '.dsh', 'dsh-mobile-tunnel-diag.log');

/** 只读隧道状态（真连接状态、最后帧时间、重连次数、最近失败原因），排障用。 */
export const TUNNEL_STATUS_ROUTE = '/plugins/dsh-mobile-tunnel/tunnel-status';

/**
 * 面板登录后把本机登记为受控设备（面板登录本身只建网页会话）。
 * 幂等：同名同平台设备已存在时复用。
 */
export const REGISTER_DEVICE_ROUTE = '/plugins/dsh-mobile-tunnel/register-device';

/**
 * 一次性认领历史设备：把"从没记过计算机名称"的旧设备认成当前这台机器（1.1.6）。
 * 认领只写计算机名称，不新建设备、不占用名额；之后按计算机名称复用，与设备名称无关。
 */
export const CLAIM_DEVICE_ROUTE = '/plugins/dsh-mobile-tunnel/claim-device';

/**
 * 面板会话续期：由宿主进程串行执行刷新并先落盘，避免浏览器侧并发轮换导致
 * 服务端判定 refresh 复用而撤销整条会话（1.1.6）。
 */
export const REFRESH_ROUTE = '/plugins/dsh-mobile-tunnel/panel-refresh';

/**
 * 退出登录：先停本机隧道（agent.logout），再清面板会话（1.1.6）。
 */
export const LOGOUT_ROUTE = '/plugins/dsh-mobile-tunnel/panel-logout';

/**
 * 隧道状态推送（SSE）：状态变化即推，面板不再轮询（1.1.6）。
 */
export const EVENTS_ROUTE = '/plugins/dsh-mobile-tunnel/events';

interface PanelSessionValue {
  accessToken: string;
  refreshToken: string;
  email: string;
}

async function handleDiag(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    let text = '';
    try {
      const { readFileSync } = await import('node:fs');
      text = readFileSync(DIAG_LOG, 'utf8').slice(-4000);
    } catch {
      text = '';
    }
    sendJson(res, 200, { log: DIAG_LOG, text });
    return;
  }
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 32 * 1024) break;
  }
  try {
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${body.slice(0, 4000)}\n`, 'utf8');
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error).message) });
  }
}

async function handleTunnelStatus(
  req: IncomingMessage,
  res: ServerResponse,
  getDiagnostics?: () => unknown,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  if (!getDiagnostics) {
    sendJson(res, 503, { error: 'unavailable' });
    return;
  }
  try {
    sendJson(res, 200, { tunnel: getDiagnostics() });
  } catch (error) {
    sendJson(res, 500, { error: String((error as Error).message) });
  }
}

interface WorkspaceContext {
  sessionId: string;
  workspaceDir: string;
  updatedAt: number;
}

/** 面板会话过期时用 refreshToken 换新会话并落盘；失败返回 null。 */
async function refreshPanelSession(
  store: PanelSessionStore,
  session: { accessToken: string; refreshToken: string; email: string },
  apiBase: string,
): Promise<{ accessToken: string; refreshToken: string; email: string } | null> {
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, '')}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { accessToken?: string; refreshToken?: string };
    if (!body.accessToken || !body.refreshToken) return null;
    const next = { accessToken: body.accessToken, refreshToken: body.refreshToken, email: session.email };
    await store.save(next);
    return next;
  } catch {
    return null;
  }
}

type RefreshOutcome =
  | { ok: true; session: PanelSessionValue }
  | { ok: false; reason: 'revoked' | 'transient'; message?: string };

/**
 * 分类刷新：只有服务端明确返回 401/403 才判定会话被撤销；限流、5xx、网络异常
 * 都算 transient，由面板提示重试而**不清**本地凭据。
 */
async function refreshPanelSessionClassified(
  store: PanelSessionStore,
  session: PanelSessionValue,
  apiBase: string,
): Promise<RefreshOutcome> {
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, '')}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'revoked' };
    }
    if (!response.ok) {
      return { ok: false, reason: 'transient', message: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { accessToken?: string; refreshToken?: string };
    if (!body.accessToken || !body.refreshToken) {
      return { ok: false, reason: 'transient', message: 'invalid-body' };
    }
    const next = { accessToken: body.accessToken, refreshToken: body.refreshToken, email: session.email };
    // 先落盘再返回：保证新 refresh 一定写进宿主文件，避免下次用旧令牌被判复用
    await store.save(next);
    return { ok: true, session: next };
  } catch (error) {
    return { ok: false, reason: 'transient', message: String((error as Error).message) };
  }
}

/** 单飞：同一时刻只允许一个刷新在飞，多个调用共享同一结果。 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

function singleFlightRefresh(
  store: PanelSessionStore,
  session: PanelSessionValue,
  apiBase: string,
): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = refreshPanelSessionClassified(store, session, apiBase).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function handlePanelRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  store: PanelSessionStore,
  apiBase: string,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  const session = await store.load();
  if (!session) {
    sendJson(res, 401, { error: 'not-logged-in' });
    return;
  }
  const result = await singleFlightRefresh(store, session, apiBase);
  if (!result.ok) {
    const status = result.reason === 'revoked' ? 401 : 503;
    sendJson(res, status, { error: result.reason, message: result.message ?? null });
    return;
  }
  sendJson(res, 200, { ok: true, session: result.session });
}

async function handlePanelLogout(
  req: IncomingMessage,
  res: ServerResponse,
  store: PanelSessionStore,
  logout?: () => Promise<void>,
  log?: (message: string) => void,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  let tunnelStopped = false;
  if (logout) {
    try {
      await logout();
      tunnelStopped = true;
    } catch (error) {
      // 隧道停不下来也要清掉面板会话，否则用户会卡在“已登录但连不上”
      log?.(`[dsh-mobile-tunnel] 面板退出时停止隧道失败：${(error as Error).message}`);
    }
  }
  await store.clear();
  sendJson(res, 200, { ok: true, tunnelStopped });
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  subscribe?: (cb: (event: unknown) => void) => () => void,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  if (!subscribe) {
    sendJson(res, 503, { error: 'unavailable' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // 关闭 Node 默认的响应超时，让长连接一直保持（面板关闭时由客户端断开）
  res.setTimeout?.(0);
  res.flushHeaders?.();
  const write = (payload: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = subscribe(write);
  } catch {
    write({ type: 'unavailable' });
  }
  const ping = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': ping\n\n');
  }, 20_000);
  ping.unref?.();
  const cleanup = (): void => {
    clearInterval(ping);
    try {
      unsubscribe?.();
    } catch {
      // 忽略
    }
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handleRegisterDevice(
  req: IncomingMessage,
  res: ServerResponse,
  store: PanelSessionStore,
  apiBase: string,
  adopt?: (
    session: { accessToken: string; refreshToken: string; email: string },
  ) => Promise<{ deviceId: string; reused: boolean; online: boolean; deviceName?: string; platform?: string }>,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  if (!adopt) {
    sendJson(res, 503, { error: 'unavailable' });
    return;
  }
  let session = await store.load();
  if (!session) {
    sendJson(res, 401, { error: 'not-logged-in' });
    return;
  }
  try {
    const result = await adopt(session);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const message = String((error as Error).message ?? error);
    // 面板会话过期：刷新一次后重试（面板本身也会在打开时刷新，这里兜底）
    if (!/HTTP 401|token_expired|token_invalid/.test(message)) {
      sendJson(res, 400, { error: message });
      return;
    }
    const refreshed = await refreshPanelSession(store, session, apiBase);
    if (!refreshed) {
      sendJson(res, 401, { error: 'session-expired', message });
      return;
    }
    session = refreshed;
    try {
      const result = await adopt(session);
      sendJson(res, 200, { ok: true, ...result });
    } catch (retryError) {
      sendJson(res, 400, { error: String((retryError as Error).message) });
    }
  }
}

async function handleClaimDevice(
  req: IncomingMessage,
  res: ServerResponse,
  store: PanelSessionStore,
  apiBase: string,
  claim?: (
    deviceId: string,
    session: { accessToken: string; refreshToken: string; email: string },
  ) => Promise<{ deviceId: string; deviceName?: string; online?: boolean }>,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  if (!claim) {
    sendJson(res, 503, { error: 'unavailable' });
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, { error: 'json-required' });
    return;
  }
  let payload: { deviceId?: unknown } | null = null;
  try {
    payload = JSON.parse(await readBody(req)) as { deviceId?: unknown };
  } catch {
    sendJson(res, 400, { error: 'invalid-json' });
    return;
  }
  const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId.trim() : '';
  if (!/^[0-9a-fA-F-]{36}$/.test(deviceId)) {
    sendJson(res, 400, { error: 'invalid-device-id' });
    return;
  }
  let session = await store.load();
  if (!session) {
    sendJson(res, 401, { error: 'not-logged-in' });
    return;
  }
  try {
    const result = await claim(deviceId, session);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (!/HTTP 401|token_expired|token_invalid/.test(message)) {
      sendJson(res, 400, { error: message });
      return;
    }
    const refreshed = await refreshPanelSession(store, session, apiBase);
    if (!refreshed) {
      sendJson(res, 401, { error: 'session-expired', message });
      return;
    }
    try {
      const result = await claim(deviceId, refreshed);
      sendJson(res, 200, { ok: true, ...result });
    } catch (retryError) {
      sendJson(res, 400, { error: String((retryError as Error).message) });
    }
  }
}

function latestWorkspaceContext(): WorkspaceContext | null {  const root = join(homedir(), '.dsh', 'sessions');
  let best: WorkspaceContext | null = null;
  let workspaces: string[];
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const workspaceDir of workspaces) {
    let sessions: string[];
    try {
      sessions = readdirSync(join(root, workspaceDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const dir of sessions) {
      const file = join(root, workspaceDir, dir, 'session.v4.jsonl.zstd');
      try {
        const info = statSync(file);
        if (!best || info.mtimeMs > best.updatedAt) {
          best = {
            sessionId: dir.slice('session-'.length),
            workspaceDir,
            updatedAt: info.mtimeMs,
          };
        }
      } catch {
        // 会话还没落盘，跳过
      }
    }
  }
  return best;
}

async function handleWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }
  const context = latestWorkspaceContext();
  if (!context) {
    sendJson(res, 404, { error: 'no-session' });
    return;
  }
  sendJson(res, 200, {
    sessionId: context.sessionId,
    workspaceDir: context.workspaceDir,
    updatedAt: context.updatedAt,
  });
}

const MAX_BODY_BYTES = 64 * 1024;
const RETRY_INTERVAL_MS = 500;
const MAX_RETRIES = 120;

interface WebServerLike {
  register?: (route: {
    kind: 'exact';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void;
  }) => unknown;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin === undefined || host === undefined) return true;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface PanelPublicConfig {
  /** 账号服务基址（面板登录/账号接口都走它） */
  apiBase: string;
  /** App 下载页地址（二维码与下载链接都用它） */
  downloadUrl: string;
  /** 本机计算机名称（PC-XXXX-XXXX）：设备身份，面板展示用；读不到时为 null。 */
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: PanelSessionStore,
  publicConfig: PanelPublicConfig,
  log: (message: string) => void,
): Promise<void> {
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'origin-rejected' });
    return;
  }
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { session: await store.load(), ...publicConfig });
      return;
    }
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        sendJson(res, 415, { error: 'json-required' });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'invalid-json' });
        return;
      }
      const session = (payload as { session?: unknown } | null)?.session;
      if (!isPanelSession(session)) {
        sendJson(res, 400, { error: 'invalid-session' });
        return;
      }
      await store.save(session);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'DELETE') {
      await store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'method-not-allowed' });
  } catch (error) {
    log(`[dsh-mobile-tunnel] 面板会话接口失败：${(error as Error).message}`);
    sendJson(res, 500, { error: 'store-failed' });
  }
}

/**
 * 等宿主 `webServer` 就绪后注册路由（apply 可能早于该服务装配）。
 * 注册成功返回；宿主持久不可用则安静放弃，不影响隧道。
 */
export function registerPanelSessionRoutes(
  ctx: DshHostContext,
  store: PanelSessionStore,
  publicConfig: PanelPublicConfig,
  log: (message: string) => void,
  getTunnelDiagnostics?: () => unknown,
  adoptPanelDevice?: (
    session: { accessToken: string; refreshToken: string; email: string },
  ) => Promise<{ deviceId: string; reused: boolean; online: boolean; deviceName?: string; platform?: string }>,
  logoutPanelDevice?: () => Promise<void>,
  subscribeStatus?: (cb: (event: unknown) => void) => () => void,
  claimPanelDevice?: (
    deviceId: string,
    session: { accessToken: string; refreshToken: string; email: string },
  ) => Promise<{ deviceId: string; deviceName?: string; online?: boolean }>,
): void {
  let disposed = false;
  let release: (() => void) | undefined;
  let retries = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tryRegister = (): boolean => {
    if (disposed || release) return true;
    const webServer = getHostService<WebServerLike>(ctx, 'webServer');
    if (typeof webServer?.register !== 'function') return false;
    try {
      const disposers: Array<() => void> = [];
      const registered = webServer.register({
        kind: 'exact',
        path: PANEL_SESSION_ROUTE,
        handler: (req, res) => {
          void handle(req, res, store, publicConfig, log);
        },
      });
      if (typeof registered === 'function') disposers.push(registered as () => void);
      const workspaceRegistered = webServer.register({
        kind: 'exact',
        path: WORKSPACE_ROUTE,
        handler: (req, res) => {
          void handleWorkspace(req, res);
        },
      });
      if (typeof workspaceRegistered === 'function') disposers.push(workspaceRegistered as () => void);
      const diagRegistered = webServer.register({
        kind: 'exact',
        path: DIAG_ROUTE,
        handler: (req, res) => {
          void handleDiag(req, res);
        },
      });
      if (typeof diagRegistered === 'function') disposers.push(diagRegistered as () => void);
      const statusRegistered = webServer.register({
        kind: 'exact',
        path: TUNNEL_STATUS_ROUTE,
        handler: (req, res) => {
          void handleTunnelStatus(req, res, getTunnelDiagnostics);
        },
      });
      if (typeof statusRegistered === 'function') disposers.push(statusRegistered as () => void);
      const registerDeviceRoute = webServer.register({
        kind: 'exact',
        path: REGISTER_DEVICE_ROUTE,
        handler: (req, res) => {
          void handleRegisterDevice(req, res, store, publicConfig.apiBase, adoptPanelDevice);
        },
      });
      if (typeof registerDeviceRoute === 'function') disposers.push(registerDeviceRoute as () => void);
      const claimDeviceRoute = webServer.register({
        kind: 'exact',
        path: CLAIM_DEVICE_ROUTE,
        handler: (req, res) => {
          void handleClaimDevice(req, res, store, publicConfig.apiBase, claimPanelDevice);
        },
      });
      if (typeof claimDeviceRoute === 'function') disposers.push(claimDeviceRoute as () => void);
      const refreshDeviceRoute = webServer.register({
        kind: 'exact',
        path: REFRESH_ROUTE,
        handler: (req, res) => {
          void handlePanelRefresh(req, res, store, publicConfig.apiBase);
        },
      });
      if (typeof refreshDeviceRoute === 'function') disposers.push(refreshDeviceRoute as () => void);
      const logoutDeviceRoute = webServer.register({
        kind: 'exact',
        path: LOGOUT_ROUTE,
        handler: (req, res) => {
          void handlePanelLogout(req, res, store, logoutPanelDevice, log);
        },
      });
      if (typeof logoutDeviceRoute === 'function') disposers.push(logoutDeviceRoute as () => void);
      const eventsRoute = webServer.register({
        kind: 'exact',
        path: EVENTS_ROUTE,
        handler: (req, res) => {
          void handleEvents(req, res, subscribeStatus);
        },
      });
      if (typeof eventsRoute === 'function') disposers.push(eventsRoute as () => void);
      const fsRoots = webServer.register({
        kind: 'exact',
        path: FS_ROOTS_ROUTE,
        handler: (req, res) => {
          void handleFsRoots(req, res);
        },
      });
      if (typeof fsRoots === 'function') disposers.push(fsRoots as () => void);
      const fsList = webServer.register({
        kind: 'exact',
        path: FS_LIST_ROUTE,
        handler: (req, res) => {
          void handleFsList(req, res);
        },
      });
      if (typeof fsList === 'function') disposers.push(fsList as () => void);
      const fsFile = webServer.register({
        kind: 'exact',
        path: FS_FILE_ROUTE,
        handler: (req, res) => {
          void handleFsFile(req, res);
        },
      });
      if (typeof fsFile === 'function') disposers.push(fsFile as () => void);
      release = () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // 忽略
          }
        }
      };
      log(`[dsh-mobile-tunnel] 面板接口已注册：${PANEL_SESSION_ROUTE} / ${WORKSPACE_ROUTE}`);
    } catch (error) {
      log(`[dsh-mobile-tunnel] 面板会话接口注册失败：${(error as Error).message}`);
    }
    return true;
  };

  if (!tryRegister()) {
    timer = setInterval(() => {
      retries += 1;
      if (tryRegister() || retries >= MAX_RETRIES) {
        if (timer) clearInterval(timer);
        timer = undefined;
      }
    }, RETRY_INTERVAL_MS);
    timer.unref?.();
  }

  try {
    ctx.on?.('dispose', () => {
      disposed = true;
      if (timer) clearInterval(timer);
      try {
        release?.();
      } catch {
        // 忽略
      }
    });
  } catch {
    // 宿主没有 on 时忽略
  }
}
