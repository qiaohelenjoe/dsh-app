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

function latestWorkspaceContext(): WorkspaceContext | null {
  const root = join(homedir(), '.dsh', 'sessions');
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
