import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PanelSessionStore, isPanelSession } from '../src/panel-session.js';
import { PANEL_SESSION_ROUTE, registerPanelSessionRoutes } from '../src/panel-session-routes.js';

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
  let baseUrl = '';
  let store: PanelSessionStore;

  const request = async (init: RequestInit & { path?: string } = {}): Promise<Response> => {
    const { path: routePath, ...rest } = init;
    return fetch(`${baseUrl}${routePath ?? PANEL_SESSION_ROUTE}`, rest);
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-panel-routes-'));
    store = new PanelSessionStore(join(dir, 'panel.json'));
    let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
    const fakeContext = {
      get: (name: string) =>
        name === 'webServer'
          ? {
              register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
                assert.equal(route.path, PANEL_SESSION_ROUTE);
                handler = route.handler;
                return () => undefined;
              },
            }
          : undefined,
    };
    registerPanelSessionRoutes(
      fakeContext,
      store,
      { apiBase: 'https://api.example.com', downloadUrl: 'https://api.example.com/download' },
      () => undefined,
    );
    assert.ok(handler, '应注册面板会话路由');
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  test('未登录返回 null；登录后返回会话；登出后清空', async () => {
    const empty = await request();
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { session: unknown; apiBase: string; downloadUrl: string };
    assert.equal(emptyBody.session, null);
    assert.equal(emptyBody.apiBase, 'https://api.example.com');
    assert.equal(emptyBody.downloadUrl, 'https://api.example.com/download');

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
});
