import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.js';
import { TunnelRegistry } from '../src/tunnel/registry.js';
import { TunnelTicketStore } from '../src/tunnel/tickets.js';
import { createTempDatabase, type TempDatabase } from './helpers/db.js';
import {
  authHeader,
  loginAccount,
  makeTestAuthConfig,
  registerAccount,
  type AccountSession,
} from './helpers/auth.js';
import { issueTunnelTicket, tunnelSocketUrl } from './helpers/tunnel.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Frame {
  t: string;
  [key: string]: unknown;
}

/** 测试用假隧道客户端（与 tunnel.integration.test.ts 同一模式）。 */
class FakeTunnel {
  readonly frames: Frame[] = [];
  private readonly waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  closeInfo: { code: number; reason: string } | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
    socket.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  nextFrame(predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing) {
      this.frames.splice(this.frames.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待帧超时')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          this.frames.splice(this.frames.indexOf(frame), 1);
          resolve(frame);
        },
      });
    });
  }

  waitClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs);
      this.socket.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }
}

interface TicketTestContext {
  db: TempDatabase;
  pool: ReturnType<typeof createPool>;
  app: ReturnType<typeof buildApp>;
  registry: TunnelRegistry;
  session: AccountSession;
  port: number;
  close(): Promise<void>;
}

async function createTicketContext(
  options: { ttlMs?: number; allowBearer?: boolean } = {},
): Promise<TicketTestContext> {
  const db = await createTempDatabase();
  const pool = createPool({ databaseUrl: db.url });
  await runMigrations(pool);
  const registry = new TunnelRegistry({
    pool,
    jwtSecret: makeTestAuthConfig().jwtSecret,
    heartbeatSec: 1,
    offlineSec: 30,
    tickets: new TunnelTicketStore({ ttlMs: options.ttlMs ?? 60_000 }),
    allowBearer: options.allowBearer ?? false,
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

  return {
    db,
    pool,
    app,
    registry,
    session,
    port,
    async close(): Promise<void> {
      await app.close();
      await pool.end().catch(() => undefined);
      await db.drop();
    },
  };
}

/** 发起升级并返回 HTTP 状态码（票据无效时握手会被拒绝）。 */
async function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  const socket = new WebSocket(url, { headers });
  return new Promise<number>((resolve, reject) => {
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    socket.on('open', () => {
      socket.close(1000, 'unexpected-open');
      reject(new Error('连接不应成功'));
    });
    socket.on('error', (error) => {
      // 401 时 ws 会先触发 unexpected-response；其它错误才算失败
      reject(error);
    });
  });
}

async function openWithTicket(ctx: TicketTestContext, ticket: string): Promise<FakeTunnel> {
  const socket = new WebSocket(tunnelSocketUrl(ctx.port, ticket));
  const tunnel = new FakeTunnel(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return tunnel;
}

describe('隧道一次性票据（R06）', () => {
  test('POST /v1/tunnel/ticket 需要登录；签发 tk_ 前缀票据且 expiresIn=60', async () => {
    const ctx = await createTicketContext();
    try {
      const anonymous = await ctx.app.inject({ method: 'POST', url: '/v1/tunnel/ticket' });
      assert.equal(anonymous.statusCode, 401);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/tunnel/ticket',
        headers: authHeader(ctx.session),
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { ticket: string; expiresIn: number };
      assert.match(body.ticket, /^tk_/);
      assert.ok(body.ticket.length > 40);
      assert.equal(body.expiresIn, 60);
    } finally {
      await ctx.close();
    }
  });

  test('无票据升级返回 401；默认配置下旧 Bearer 也被拒绝', async () => {
    const ctx = await createTicketContext();
    try {
      const noTicket = await upgradeStatus(`ws://127.0.0.1:${ctx.port}/v1/tunnel`);
      assert.equal(noTicket, 401);

      const bearer = await upgradeStatus(`ws://127.0.0.1:${ctx.port}/v1/tunnel`, {
        authorization: `Bearer ${ctx.session.accessToken}`,
      });
      assert.equal(bearer, 401);
    } finally {
      await ctx.close();
    }
  });

  test('有效票据可建立隧道并完成 req/res 往返', async () => {
    const ctx = await createTicketContext();
    try {
      const ticket = await issueTunnelTicket(ctx.app, ctx.session);
      const tunnel = await openWithTicket(ctx, ticket);
      tunnel.send({ t: 'register', deviceId: ctx.session.deviceId, protocol: 1 });
      await tunnel.nextFrame((frame) => frame.t === 'registered');
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), true);

      const requestPromise = ctx.registry.request(ctx.session.deviceId, {
        method: 'GET',
        path: '/api/session/list',
        headers: { accept: 'application/json' },
        body: null,
      });
      const req = await tunnel.nextFrame((frame) => frame.t === 'req');
      assert.equal(req['path'], '/api/session/list');
      tunnel.send({
        t: 'res',
        id: req['id'],
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"sessions":[]}').toString('base64'),
        more: false,
      });
      const response = await requestPromise;
      assert.equal(response.status, 200);
      assert.equal(response.body.toString('utf8'), '{"sessions":[]}');
      tunnel.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('同一票据第二次使用返回 401（一次性）', async () => {
    const ctx = await createTicketContext();
    try {
      const ticket = await issueTunnelTicket(ctx.app, ctx.session);
      const tunnel = await openWithTicket(ctx, ticket);
      tunnel.send({ t: 'register', deviceId: ctx.session.deviceId, protocol: 1 });
      await tunnel.nextFrame((frame) => frame.t === 'registered');

      const replay = await upgradeStatus(tunnelSocketUrl(ctx.port, ticket));
      assert.equal(replay, 401);
      tunnel.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('票据过期后升级返回 401', async () => {
    const ctx = await createTicketContext({ ttlMs: 50 });
    try {
      const ticket = await issueTunnelTicket(ctx.app, ctx.session);
      await sleep(120);
      const status = await upgradeStatus(tunnelSocketUrl(ctx.port, ticket));
      assert.equal(status, 401);
    } finally {
      await ctx.close();
    }
  });

  test('票据绑定的会话被撤销后升级返回 401', async () => {
    const ctx = await createTicketContext();
    try {
      const ticket = await issueTunnelTicket(ctx.app, ctx.session);
      await ctx.pool.query('UPDATE sessions SET revoked_at = now() WHERE device_id = $1', [ctx.session.deviceId]);
      const status = await upgradeStatus(tunnelSocketUrl(ctx.port, ticket));
      assert.equal(status, 401);
    } finally {
      await ctx.close();
    }
  });

  test('register 帧 deviceId 与票据不一致时以 4004 关闭', async () => {
    const ctx = await createTicketContext();
    try {
      const other = await loginAccount({ app: ctx.app }, { deviceName: '另一台手机' });
      const ticket = await issueTunnelTicket(ctx.app, ctx.session);
      const tunnel = await openWithTicket(ctx, ticket);
      tunnel.send({ t: 'register', deviceId: other.deviceId, protocol: 1 });
      const closed = await tunnel.waitClose(3000);
      assert.equal(closed.code, 4004);
      assert.equal(ctx.registry.isOnline(other.deviceId), false);
    } finally {
      await ctx.close();
    }
  });

  test('ALLOW_TUNNEL_BEARER 兼容开关打开时 Bearer 仍可升级', async () => {
    const ctx = await createTicketContext({ allowBearer: true });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/v1/tunnel`, {
        headers: { authorization: `Bearer ${ctx.session.accessToken}` },
      });
      const tunnel = new FakeTunnel(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      tunnel.send({ t: 'register', deviceId: ctx.session.deviceId, protocol: 1 });
      await tunnel.nextFrame((frame) => frame.t === 'registered');
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), true);
      socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });
});
