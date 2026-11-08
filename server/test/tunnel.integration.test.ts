import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/http/errors.js';
import { createPool } from '../src/db/pool.js';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.js';
import { TunnelRegistry } from '../src/tunnel/registry.js';
import { createTempDatabase, type TempDatabase } from './helpers/db.js';
import { makeTestAuthConfig, registerAccount, loginAccount, type AccountSession } from './helpers/auth.js';
import { issueTunnelTicket, tunnelSocketUrl } from './helpers/tunnel.js';

interface TunnelTestContext {
  db: TempDatabase;
  pool: ReturnType<typeof createPool>;
  app: ReturnType<typeof buildApp>;
  registry: TunnelRegistry;
  session: AccountSession;
  port: number;
  close(): Promise<void>;
}

interface Frame {
  t: string;
  [key: string]: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function deviceOnline(ctx: TunnelTestContext, deviceId: string): Promise<boolean> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/v1/devices',
    headers: { authorization: `Bearer ${ctx.session.accessToken}` },
  });
  const body = response.json() as { devices: Array<{ id: string; online: boolean }> };
  return body.devices.find((device) => device.id === deviceId)?.online ?? false;
}

/** 关闭连接后的离线写库是异步的：轮询等待状态收敛（最多 2 秒）。 */
async function waitDeviceOffline(ctx: TunnelTestContext, deviceId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await deviceOnline(ctx, deviceId))) return;
    await sleep(50);
  }
  throw new Error('等待设备离线超时');
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('条件等待超时');
}

/** 测试用假隧道客户端：可等待指定类型帧、按脚本响应 req。 */
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

async function createTunnelContext(
  overrides: Partial<ConstructorParameters<typeof TunnelRegistry>[0]> = {},
): Promise<TunnelTestContext> {
  const db = await createTempDatabase();
  const pool = createPool({ databaseUrl: db.url });
  await runMigrations(pool);
  const registry = new TunnelRegistry({
    pool,
    jwtSecret: makeTestAuthConfig().jwtSecret,
    heartbeatSec: 0.3,
    offlineSec: 3,
    requestTimeoutMs: 2000,
    ...overrides,
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

function connect(ctx: TunnelTestContext, ticket: string): WebSocket {
  return new WebSocket(tunnelSocketUrl(ctx.port, ticket));
}

async function openTunnel(ctx: TunnelTestContext): Promise<FakeTunnel> {
  const socket = connect(ctx, await issueTunnelTicket(ctx.app, ctx.session));
  const tunnel = new FakeTunnel(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  tunnel.send({ t: 'register', deviceId: ctx.session.deviceId, protocol: 1 });
  await tunnel.nextFrame((frame) => frame.t === 'registered');
  return tunnel;
}

describe('隧道服务 HTTP（T05）', () => {
  test('无票据 / 无效票据时升级返回 401', async () => {
    const ctx = await createTunnelContext();
    try {
      const missing = new WebSocket(`ws://127.0.0.1:${ctx.port}/v1/tunnel`);
      const missingStatus = await new Promise<number>((resolve, reject) => {
        missing.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        missing.on('error', reject);
      });
      assert.equal(missingStatus, 401);

      const invalid = connect(ctx, 'tk_not-a-real-ticket');
      const invalidStatus = await new Promise<number>((resolve, reject) => {
        invalid.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        invalid.on('error', reject);
      });
      assert.equal(invalidStatus, 401);
    } finally {
      await ctx.close();
    }
  });

  test('register 后设备 online=true；req/res 往返拿到状态码与正文', async () => {
    const ctx = await createTunnelContext();
    try {
      const tunnel = await openTunnel(ctx);
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), true);

      const devices = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices',
        headers: { authorization: `Bearer ${ctx.session.accessToken}` },
      });
      const body = devices.json() as { devices: Array<{ id: string; online: boolean }> };
      const target = body.devices.find((device) => device.id === ctx.session.deviceId);
      assert.equal(target?.online, true);

      const requestPromise = ctx.registry.request(ctx.session.deviceId, {
        method: 'GET',
        path: '/api/session/list',
        headers: { accept: 'application/json' },
        body: null,
      });

      const req = await tunnel.nextFrame((frame) => frame.t === 'req');
      assert.equal(req['method'], 'GET');
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
      assert.equal(response.headers['content-type'], 'application/json');
    } finally {
      await ctx.close();
    }
  });

  test('分块响应（more:true 多次）能正确拼接', async () => {
    const ctx = await createTunnelContext();
    try {
      const tunnel = await openTunnel(ctx);
      const requestPromise = ctx.registry.request(ctx.session.deviceId, {
        method: 'GET',
        path: '/assets/app.css',
        headers: {},
        body: null,
      });
      const req = await tunnel.nextFrame((frame) => frame.t === 'req');
      tunnel.send({ t: 'res', id: req['id'], status: 200, body: Buffer.from('aaa').toString('base64'), more: true });
      tunnel.send({ t: 'res', id: req['id'], status: 200, body: Buffer.from('bbb').toString('base64'), more: true });
      tunnel.send({ t: 'res', id: req['id'], status: 200, body: Buffer.from('ccc').toString('base64'), more: false });

      const response = await requestPromise;
      assert.equal(response.body.toString('utf8'), 'aaabbbccc');
    } finally {
      await ctx.close();
    }
  });

  test('心跳缺失超过 offline 阈值后设备离线且连接关闭', async () => {
    const ctx = await createTunnelContext({ heartbeatSec: 0.2, offlineSec: 0.8 });
    try {
      const tunnel = await openTunnel(ctx);
      const closed = await tunnel.waitClose(3000);
      assert.equal(closed.code, 4005);
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), false);

      await waitDeviceOffline(ctx, ctx.session.deviceId);
      assert.equal(await deviceOnline(ctx, ctx.session.deviceId), false);
    } finally {
      await ctx.close();
    }
  });

  test('断开后在宽限期内重连保持在线，超过宽限才标记离线', async () => {
    const ctx = await createTunnelContext({ heartbeatSec: 0.2, offlineSec: 3, reconnectGraceSec: 0.6 });
    try {
      const first = await openTunnel(ctx);
      first.socket.close(1000, 'bye');
      await sleep(120);
      assert.equal(await deviceOnline(ctx, ctx.session.deviceId), true, '宽限期内不应当立刻离线');

      // 宽限期内重连成功：保持在线，且宽限计时被取消
      const second = await openTunnel(ctx);
      await sleep(900);
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), true);
      assert.equal(await deviceOnline(ctx, ctx.session.deviceId), true, '重连后应保持在线');

      // 再次断开且不再重连：超过宽限后离线
      second.socket.close(1000, 'bye');
      await waitDeviceOffline(ctx, ctx.session.deviceId);
      assert.equal(await deviceOnline(ctx, ctx.session.deviceId), false);
    } finally {
      await ctx.close();
    }
  });

  test('未完成请求超过并发上限时新请求返回 503 tunnel.busy', async () => {
    const ctx = await createTunnelContext({ maxInflight: 2 });
    try {
      const tunnel = await openTunnel(ctx);
      const first = ctx.registry.request(ctx.session.deviceId, { method: 'GET', path: '/api/a', headers: {}, body: null });
      const second = ctx.registry.request(ctx.session.deviceId, { method: 'GET', path: '/api/b', headers: {}, body: null });

      await assert.rejects(
        () => ctx.registry.request(ctx.session.deviceId, { method: 'GET', path: '/api/c', headers: {}, body: null }),
        (error: unknown) => error instanceof ApiError && error.code === 'tunnel.busy',
      );

      const reqA = await tunnel.nextFrame((frame) => frame.t === 'req');
      const reqB = await tunnel.nextFrame((frame) => frame.t === 'req');
      tunnel.send({ t: 'res', id: reqA['id'], status: 200, body: null, more: false });
      tunnel.send({ t: 'res', id: reqB['id'], status: 204, body: null, more: false });
      await Promise.all([first, second]);
    } finally {
      await ctx.close();
    }
  });

  test('路径白名单外返回 403 tunnel.path_denied 并写审计', async () => {
    const ctx = await createTunnelContext();
    try {
      await openTunnel(ctx);
      for (const path of ['/connect', '/api/pair/abc', '/api/plugin-manager/list', '/api/update/check']) {
        await assert.rejects(
          () => ctx.registry.request(ctx.session.deviceId, { method: 'GET', path, headers: {}, body: null }),
          (error: unknown) => error instanceof ApiError && error.code === 'tunnel.path_denied',
          `路径应被拒绝: ${path}`,
        );
      }

      const audits = await ctx.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'tunnel.path_denied' AND result = 'denied'`,
      );
      assert.equal(audits.rows[0]?.count, '4');
    } finally {
      await ctx.close();
    }
  });

  test('单帧超过配置上限时断开连接', async () => {
    const ctx = await createTunnelContext({ maxFrameBytes: 1024 * 1024 });
    try {
      const tunnel = await openTunnel(ctx);
      // 触发 maxPayload：发送超过 1 MiB 的字符串
      tunnel.send({ t: 'ping', payload: 'x'.repeat(1024 * 1024 + 512) });
      const closed = await tunnel.waitClose(3000);
      assert.equal(closed.code, 1009);
      await waitUntil(() => !ctx.registry.isOnline(ctx.session.deviceId));
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), false);
    } finally {
      await ctx.close();
    }
  });

  test('设备被撤销后隧道立即关闭', async () => {
    const ctx = await createTunnelContext();
    try {
      const tunnel = await openTunnel(ctx);
      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${ctx.session.deviceId}`,
        headers: { authorization: `Bearer ${ctx.session.accessToken}` },
      });
      assert.equal(removed.statusCode, 204);
      const closed = await tunnel.waitClose(3000);
      assert.equal(closed.code, 4000);
      assert.equal(ctx.registry.isOnline(ctx.session.deviceId), false);
    } finally {
      await ctx.close();
    }
  });

  test('同一 device 重复连接时旧连接被踢掉', async () => {
    const ctx = await createTunnelContext();
    try {
      const first = await openTunnel(ctx);
      const second = await openTunnel(ctx);
      const closed = await first.waitClose(3000);
      assert.equal(closed.code, 4000);

      // 新连接仍可正常服务
      const requestPromise = ctx.registry.request(ctx.session.deviceId, {
        method: 'GET',
        path: '/api/ping',
        headers: {},
        body: null,
      });
      const req = await second.nextFrame((frame) => frame.t === 'req');
      second.send({ t: 'res', id: req['id'], status: 200, body: null, more: false });
      const response = await requestPromise;
      assert.equal(response.status, 200);
    } finally {
      await ctx.close();
    }
  });

  test('request 发往离线设备返回 503 device_offline', async () => {
    const ctx = await createTunnelContext();
    try {
      await assert.rejects(
        () =>
          ctx.registry.request(ctx.session.deviceId, {
            method: 'GET',
            path: '/api/anything',
            headers: {},
            body: null,
          }),
        (error: unknown) => error instanceof ApiError && error.code === 'tunnel.device_offline',
      );
    } finally {
      await ctx.close();
    }
  });
});
