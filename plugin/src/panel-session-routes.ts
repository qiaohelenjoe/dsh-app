import type { IncomingMessage, ServerResponse } from 'node:http';
import { getHostService, type DshHostContext } from './host.js';
import { isPanelSession, type PanelSessionStore } from './panel-session.js';

/**
 * 把面板会话暴露给浏览器侧插件（同源 JSON 接口）。
 *
 * 只注册在 DSH 自己的 Web 服务上：面板与接口同源，浏览器存储不再承担持久化职责；
 * 同源校验避免任意网页读到 refresh token。宿主机若没有 `webServer` 服务（老版本），
 * 注册会安静放弃，浏览器侧自动回落 sessionStorage（行为与改动前一致）。
 */
export const PANEL_SESSION_ROUTE = '/plugins/dsh-mobile-tunnel/panel-session';

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
      const registered = webServer.register({
        kind: 'exact',
        path: PANEL_SESSION_ROUTE,
        handler: (req, res) => {
          void handle(req, res, store, publicConfig, log);
        },
      });
      release = typeof registered === 'function' ? () => (registered as () => void)() : () => undefined;
      log(`[dsh-mobile-tunnel] 面板会话接口已注册：${PANEL_SESSION_ROUTE}`);
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
