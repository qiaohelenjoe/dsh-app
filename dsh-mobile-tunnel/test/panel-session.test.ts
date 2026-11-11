import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PanelSessionStore, isPanelSession } from '../src/panel-session.js';
import {
  EVENTS_ROUTE,
  LOGOUT_ROUTE,
  PANEL_SESSION_ROUTE,
  REFRESH_ROUTE,
  registerPanelSessionRoutes,
} from '../src/panel-session-routes.js';

const session = { accessToken: 'access-token', refreshToken: 'refresh-token', email: 'a@example.com' };

describe('面板会话文件存储', () => {
  let dir = '';
  let store: PanelSessionStore;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-panel-session-'));
    store = new PanelSessionStore(join(dir, 'panel.json'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('保存后可读回，登出后清空', async () => {
    assert.equal(await store.load(), null);
    await store.save(session);
    assert.deepEqual(await store.load(), session);
    const raw = await readFile(store.path, 'utf8');
    assert.ok(raw.includes(session.email), '文件里应有账号');
    await store.clear();
    assert.equal(await store.load(), null);
  });

  test('文件损坏按未登录处理，不抛错', async () => {
    await writeFile(store.path, '{not json', 'utf8');
    assert.equal(await store.load(), null);
  });

  test('字段缺失的会话视为无效', () => {
    assert.equal(isPanelSession({ accessToken: 'a', refreshToken: 'b' }), false);
    assert.equal(isPanelSession({ accessToken: 'a', refreshToken: 'b', email: 'c' }), true);
    assert.equal(isPanelSession(null), false);
  });
});

describe('面板会话 HTTP 接口', () => {
  let dir = '';
  let server: Server;
  let apiServer: Server;
  let baseUrl = '';
  let apiBase = '';
  let store: PanelSessionStore;
  let refreshCount = 0;
  let refreshMode: 'ok' | 'too-many' | 'revoked' = 'ok';
  let logoutCalled = 0;

  const request = async (
    init: RequestInit & { path?: string } = {},
  ): Promise<Response> => {
    const { path: routePath, ...rest } = init;
    return fetch(`${baseUrl}${routePath ?? PANEL_SESSION_ROUTE}`, rest);
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-panel-routes-'));
    store = new PanelSessionStore(join(dir, 'panel.json'));

    // 假账号服务：只实现 /v1/auth/refresh
    apiServer = createServer((req, res) => {
      if (req.url === '/v1/auth/refresh') {
        refreshCount += 1;
        if (refreshMode === 'too-many') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end('{"error":{"code":"rate_limit.exceeded"}}');
          return;
        }
        if (refreshMode === 'revoked') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":{"code":"auth.token_invalid"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
    const fakeContext = {
      get: (name: string) =>
        name === 'webServer'
          ? {
              register: (route: {
                path: string;
                handler: (req: IncomingMessage, res: ServerResponse) => void;
              }) => {
                routes.set(route.path, route.handler);
                return () => routes.delete(route.path);
              },
            }
          : undefined,
    };
    registerPanelSessionRoutes(
      fakeContext,
      store,
      { apiBase, downloadUrl: `${apiBase}/download` },
      () => undefined,
      undefined,
      undefined,
      async () => {
        logoutCalled += 1;
      },
      (cb) => {
        cb({ type: 'tunnel', tunnel: { online: true, deviceId: 'dev-1' } });
        return () => undefined;
      },
    );
    assert.ok(routes.has(PANEL_SESSION_ROUTE), '应注册面板会话路由');
    assert.ok(routes.has(REFRESH_ROUTE), '应注册 panel-refresh 路由');
    assert.ok(routes.has(LOGOUT_ROUTE), '应注册 panel-logout 路由');
    assert.ok(routes.has(EVENTS_ROUTE), '应注册 events(SSE) 路由');
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const handler = routes.get(path);
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    refreshCount = 0;
    refreshMode = 'ok';
    logoutCalled = 0;
    await store.clear();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  test('未登录返回 null；登录后返回会话；登出后清空', async () => {
    const empty = await request();
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { session: unknown; apiBase: string; downloadUrl: string };
    assert.equal(emptyBody.session, null);
    assert.equal(emptyBody.apiBase, apiBase);
    assert.equal(emptyBody.downloadUrl, `${apiBase}/download`);

    const saved = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
    });
    assert.equal(saved.status, 200);
    const afterSave = (await (await request()).json()) as { session: unknown };
    assert.deepEqual(afterSave.session, session);

    const removed = await request({ method: 'DELETE' });
    assert.equal(removed.status, 200);
    const afterClear = (await (await request()).json()) as { session: unknown };
    assert.equal(afterClear.session, null);
  });

  test('非法请求被拒绝：跨源 403、非 JSON 415、字段缺失 400、方法 405', async () => {
    const crossOrigin = await request({ headers: { origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);

    const wrongType = await request({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"session":{}}',
    });
    assert.equal(wrongType.status, 415);

    const invalid = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: { accessToken: 'a' } }),
    });
    assert.equal(invalid.status, 400);

    const method = await request({ method: 'PUT' });
    assert.equal(method.status, 405);
  });

  test('panel-refresh 串行刷新并先落盘，并发只请求一次', async () => {
    await store.save(session);
    const [first, second] = await Promise.all([
      request({ method: 'POST', path: REFRESH_ROUTE }),
      request({ method: 'POST', path: REFRESH_ROUTE }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(refreshCount, 1, '并发刷新应合并成一次请求');
    const stored = await store.load();
    assert.equal(stored?.accessToken, 'access-2');
    assert.equal(stored?.refreshToken, 'refresh-2', '新 refresh 必须已落盘');
  });

  test('panel-refresh 遇到限流返回 transient 且不清凭据', async () => {
    await store.save(session);
    refreshMode = 'too-many';
    const limited = await request({ method: 'POST', path: REFRESH_ROUTE });
    assert.equal(limited.status, 503);
    const body = (await limited.json()) as { error: string };
    assert.equal(body.error, 'transient');
    assert.deepEqual(await store.load(), session, '限流不应清掉本地凭据');
  });

  test('panel-refresh 收到 401 才判定会话被撤销', async () => {
    await store.save(session);
    refreshMode = 'revoked';
    const revoked = await request({ method: 'POST', path: REFRESH_ROUTE });
    assert.equal(revoked.status, 401);
    const body = (await revoked.json()) as { error: string };
    assert.equal(body.error, 'revoked');
  });

  test('panel-logout 调用宿主退出并清掉面板会话', async () => {
    await store.save(session);
    const result = await request({ method: 'POST', path: LOGOUT_ROUTE });
    assert.equal(result.status, 200);
    const body = (await result.json()) as { ok: boolean; tunnelStopped: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.tunnelStopped, true);
    assert.equal(logoutCalled, 1, '应调用宿主退出（停隧道 + 清凭据）');
    assert.equal(await store.load(), null, '面板会话应被清除');
  });

  test('events 路由以 SSE 推送首帧快照', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}${EVENTS_ROUTE}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader, 'SSE 响应应有可读流');
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /^data: /, `首帧应是 data 事件，实际：${text}`);
    assert.match(text, /"online":true/, '首帧应带隧道状态');
    controller.abort();
  });
});
