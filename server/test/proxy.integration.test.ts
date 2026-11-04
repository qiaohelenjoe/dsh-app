import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.js';
import { TunnelRegistry } from '../src/tunnel/registry.js';
import { createTempDatabase, type TempDatabase } from './helpers/db.js';
import { loginAccount, makeTestAuthConfig, registerAccount, type AccountSession } from './helpers/auth.js';
import { issueTunnelTicket, tunnelSocketUrl } from './helpers/tunnel.js';

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

interface CannedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function respondFor(path: string): CannedResponse {
  const pathname = path.split('?')[0] ?? '/';
  switch (pathname) {
    case '/':
      return {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'dsh-auth-abc=1; Path=/; HttpOnly, other=2; Path=/api',
        },
        body:
          '<html><head><link rel="stylesheet" href="/assets/app.css"></head>' +
          '<body><script src="./assets/x.js"></script><img src="/assets/logo.png"></body></html>',
      };
    case '/assets/x.js':
      return { status: 200, headers: { 'content-type': 'text/javascript' }, body: 'console.log(1)' };
    case '/assets/app.css':
      return { status: 200, headers: { 'content-type': 'text/css' }, body: 'body{background:url(/assets/bg.png)}' };
    case '/api/redirect':
      return { status: 303, headers: { location: '/#/login' }, body: '' };
    case '/api/wrong-length':
      return { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '999' }, body: 'hello' };
    case '/api/session/list':
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"sessions":[]}' };
    default:
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
  }
}

class FakeTunnel {
  readonly requests: RecordedRequest[] = [];
  private registered = false;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame['t'] === 'ping') {
        socket.send(JSON.stringify({ t: 'pong' }));
        return;
      }
      if (frame['t'] === 'req') {
        const method = frame['method'] as string;
        const path = frame['path'] as string;
        const headers = (frame['headers'] as Record<string, string>) ?? {};
        this.requests.push({ method, path, headers });
        const canned = respondFor(path);
        const body = Buffer.from(canned.body);
        socket.send(
          JSON.stringify({
            t: 'res',
            id: frame['id'],
            status: canned.status,
            headers: canned.headers,
            body: body.toString('base64'),
            more: false,
          }),
        );
        return;
      }
      if (frame['t'] === 'registered') this.registered = true;
    });
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }
}

interface ProxyTestContext {
  db: TempDatabase;
  pool: ReturnType<typeof createPool>;
  app: ReturnType<typeof buildApp>;
  registry: TunnelRegistry;
  session: AccountSession;
  tunnel: FakeTunnel | null;
  port: number;
  close(): Promise<void>;
}

async function createProxyContext(options: { withTunnel?: boolean } = {}): Promise<ProxyTestContext> {
  const db = await createTempDatabase();
  const pool = createPool({ databaseUrl: db.url });
  await runMigrations(pool);
  const registry = new TunnelRegistry({
    pool,
    jwtSecret: makeTestAuthConfig().jwtSecret,
    heartbeatSec: 1,
    offlineSec: 30,
  });
  const app = buildApp({
    pool,
    migrationsDir: defaultMigrationsDir(),
    authConfig: makeTestAuthConfig(),
    tunnelRegistry: registry,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  const holder = { app };
  await registerAccount(holder);
  const session = await loginAccount(holder);

  let tunnel: FakeTunnel | null = null;
  if (options.withTunnel !== false) {
    const ticket = await issueTunnelTicket(app, session);
    const socket = new WebSocket(tunnelSocketUrl(port, ticket));
    tunnel = new FakeTunnel(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    tunnel.send({ t: 'register', deviceId: session.deviceId, protocol: 1 });
    for (let attempt = 0; attempt < 100 && !tunnel.isRegistered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  return {
    db,
    pool,
    app,
    registry,
    session,
    tunnel,
    port,
    async close(): Promise<void> {
      await app.close();
      await pool.end().catch(() => undefined);
      await db.drop();
    },
  };
}

function cookieHeader(session: AccountSession): Record<string, string> {
  return { cookie: `dsh_access=${encodeURIComponent(session.accessToken)}` };
}

describe('设备 UI 代理 /t/:deviceId/*（T07）', () => {
  test('未登录：HTML 请求 302 到 /login，JSON 请求 401', async () => {
    const ctx = await createProxyContext();
    try {
      const html = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/`,
        headers: { accept: 'text/html' },
      });
      assert.equal(html.statusCode, 302);
      assert.match(html.headers['location'] as string, /^\/login\?next=/);

      const json = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/`,
        headers: { accept: 'application/json' },
      });
      assert.equal(json.statusCode, 401);
      assert.equal((json.json() as { error: { code: string } }).error.code, 'auth.token_invalid');
    } finally {
      await ctx.close();
    }
  });

  test('访问他人设备返回 403 authz.forbidden', async () => {
    const ctx = await createProxyContext();
    try {
      await registerAccount({ app: ctx.app }, 'other@example.com');
      const other = await loginAccount({ app: ctx.app }, { email: 'other@example.com' });
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${other.deviceId}/`,
        headers: { ...cookieHeader(ctx.session), accept: 'application/json' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'authz.forbidden');
    } finally {
      await ctx.close();
    }
  });

  test('设备离线：HTML 友好页与 JSON 错误体', async () => {
    const ctx = await createProxyContext({ withTunnel: false });
    try {
      const html = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/`,
        headers: { ...cookieHeader(ctx.session), accept: 'text/html' },
      });
      assert.equal(html.statusCode, 503);
      assert.match(html.body, /这台设备当前不在线/);

      const json = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/`,
        headers: { ...cookieHeader(ctx.session), accept: 'application/json' },
      });
      assert.equal(json.statusCode, 503);
      assert.equal((json.json() as { error: { code: string } }).error.code, 'tunnel.device_offline');
    } finally {
      await ctx.close();
    }
  });

  test('在线设备首页 200，HTML 中的根绝对路径被加前缀（相对路径保持）', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/`,
        headers: { ...cookieHeader(ctx.session), accept: 'text/html' },
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] as string, /text\/html/);
      assert.match(response.body, new RegExp(`/t/${ctx.session.deviceId}/assets/app\\.css`));
      assert.match(response.body, new RegExp(`/t/${ctx.session.deviceId}/assets/logo\\.png`));
      assert.match(response.body, new RegExp(`src="/t/${ctx.session.deviceId}/assets/x\\.js"`), '相对路径也加前缀（DSH 根路径语义）');
      assert.ok(
        response.body.includes(`t.streamBaseUrl=location.origin+"/t/${ctx.session.deviceId}/"`),
        'Remote mux 基址必须是绝对 URL 并带设备前缀，否则 DSH 的 new URL() 会抛错、mux 完全不发起',
      );
      assert.equal(
        response.headers['cache-control'],
        'no-store',
        'HTML 必须禁止缓存，否则客户端拿不到注入后的新版本',
      );
    } finally {
      await ctx.close();
    }
  });

  test('根路径模式下 Remote mux 基址为 /', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/',
        headers: {
          cookie: `dsh_access=${encodeURIComponent(ctx.session.accessToken)}; dsh_device=${ctx.session.deviceId}`,
          accept: 'text/html',
        },
      });
      assert.equal(response.statusCode, 200);
      assert.ok(
        response.body.includes('t.streamBaseUrl=location.origin+"/"'),
        '根路径模式同样必须是绝对 URL',
      );
    } finally {
      await ctx.close();
    }
  });

  test('静态资源经 /t/<id>/assets/* 转发，CSS 内绝对 URL 也被改写', async () => {
    const ctx = await createProxyContext();
    try {
      const script = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/assets/x.js`,
        headers: { ...cookieHeader(ctx.session) },
      });
      assert.equal(script.statusCode, 200);
      assert.equal(script.body, 'console.log(1)');
      assert.equal(ctx.tunnel?.requests[0]?.path, '/assets/x.js');

      const css = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/assets/app.css`,
        headers: { ...cookieHeader(ctx.session) },
      });
      assert.equal(css.statusCode, 200);
      assert.match(css.body, new RegExp(`url\\(/t/${ctx.session.deviceId}/assets/bg\\.png\\)`));
    } finally {
      await ctx.close();
    }
  });

  test('Set-Cookie 的 Path 改写为 /t/<id>', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/`,
        headers: { ...cookieHeader(ctx.session), accept: 'text/html' },
      });
      const setCookie = response.headers['set-cookie'];
      const text = Array.isArray(setCookie) ? setCookie.join(',') : String(setCookie);
      assert.match(text, new RegExp(`Path=/t/${ctx.session.deviceId}`));
      assert.ok(!/Path=\/;/.test(text));
    } finally {
      await ctx.close();
    }
  });

  test('Content-Length 以实际响应体为准（不信任上游声明）', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/api/wrong-length`,
        headers: { ...cookieHeader(ctx.session) },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, 'hello');
      assert.equal(response.headers['content-length'], '5');
    } finally {
      await ctx.close();
    }
  });

  test('Location 重定向的站内绝对路径被加前缀', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/api/redirect`,
        headers: { ...cookieHeader(ctx.session) },
      });
      assert.equal(response.statusCode, 303);
      assert.equal(response.headers['location'], `/t/${ctx.session.deviceId}/#/login`);
    } finally {
      await ctx.close();
    }
  });

  test('代理请求的 Cookie 不转发到上游', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/api/session/list`,
        headers: {
          cookie: `dsh_access=${encodeURIComponent(ctx.session.accessToken)}; sensitive=1`,
          accept: 'application/json',
        },
      });
      assert.equal(response.statusCode, 200);
      const forwarded = ctx.tunnel?.requests[0];
      assert.ok(forwarded);
      assert.equal(forwarded.headers['cookie'], undefined);
      assert.equal(forwarded.headers['authorization'], undefined);
      assert.equal(response.body, '{"sessions":[]}');
    } finally {
      await ctx.close();
    }
  });

  test('query 中的 Windows 反斜杠路径不被路径检查拦截', async () => {
    const ctx = await createProxyContext();
    try {
      const query = 'path=G%3A%5Czxht%5Cdsh-app%5Cdocs%2Fui.png';
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/api/file?${query}`,
        headers: { ...cookieHeader(ctx.session) },
      });
      // 上游 mock 对该路径返回 404；关键是不能被我们自己的 assertSafePath 判成 400
      assert.equal(response.statusCode, 404);
      assert.equal(ctx.tunnel?.requests[0]?.path, `/api/file?${query}`);
    } finally {
      await ctx.close();
    }
  });

  test('路径包含 .. 或编码绕过返回 400', async () => {
    const ctx = await createProxyContext();
    try {
      // 用真实 HTTP 客户端发送原始路径：app.inject 会先做 URL 归一化，无法覆盖该场景
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: ctx.port,
            method: 'GET',
            path: `/t/${ctx.session.deviceId}/%2e%2e/secret`,
            headers: { cookie: `dsh_access=${encodeURIComponent(ctx.session.accessToken)}` },
          },
          (response) => {
            resolve(response.statusCode ?? 0);
            response.resume();
          },
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 400);
    } finally {
      await ctx.close();
    }
  });

  test('/t/<id> 无尾斜杠重定向到 /t/<id>/', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}`,
        headers: { ...cookieHeader(ctx.session) },
      });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers['location'], `/t/${ctx.session.deviceId}/`);
    } finally {
      await ctx.close();
    }
  });

  test('token 查询参数可用于鉴权且不转发给上游', async () => {
    const ctx = await createProxyContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/?token=${encodeURIComponent(ctx.session.accessToken)}`,
        headers: { accept: 'text/html' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(ctx.tunnel?.requests[0]?.path, '/');
    } finally {
      await ctx.close();
    }
  });
});
