import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.js';
import { PENDING_DEVICE_KEY } from '../src/devices/types.js';
import { TunnelRegistry } from '../src/tunnel/registry.js';
import { createTempDatabase, type TempDatabase } from './helpers/db.js';
import {
  authHeader,
  loginAccount,
  makeTestAuthConfig,
  registerAccount,
  type AccountSession,
} from './helpers/auth.js';
import { issueTunnelTicket, tunnelSocketUrl } from './helpers/tunnel.js';

interface AuditRow {
  account_id: string | null;
  device_id: string | null;
  action: string;
  result: string;
  detail: Record<string, unknown>;
}

interface Context {
  db: TempDatabase;
  pool: ReturnType<typeof createPool>;
  app: ReturnType<typeof buildApp>;
  registry: TunnelRegistry;
  session: AccountSession;
  port: number;
  close(): Promise<void>;
}

async function createContext(options: { withTunnel?: boolean } = {}): Promise<Context> {
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

  if (options.withTunnel !== false) {
    const ticket = await issueTunnelTicket(app, session);
    const socket = new WebSocket(tunnelSocketUrl(port, ticket));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame['t'] === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ t: 'register', deviceId: session.deviceId, protocol: 1 }));
    for (let attempt = 0; attempt < 100 && !registry.isOnline(session.deviceId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

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

async function audits(pool: ReturnType<typeof createPool>, action: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT account_id, device_id, action, result, detail FROM audit_logs WHERE action = $1 ORDER BY id`,
    [action],
  );
  return result.rows;
}

function cookieHeader(session: AccountSession): Record<string, string> {
  return { cookie: `dsh_access=${encodeURIComponent(session.accessToken)}` };
}

describe('审计补齐：device.register 与 proxy.denied（R02）', () => {
  test('POST /v1/devices 成功后写 device.register（含 kind/platform/name）', async () => {
    const ctx = await createContext({ withTunnel: false });
    try {
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(ctx.session),
        payload: { name: '审计PC', platform: 'win32', appVersion: '1.0.0', signPublicKey: 's', ecdhPublicKey: 'e' },
      });
      assert.equal(created.statusCode, 201);
      const deviceId = (created.json() as { device: { id: string } }).device.id;

      const rows = await audits(ctx.pool, 'device.register');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.result, 'ok');
      assert.equal(rows[0]?.account_id, ctx.session.accountId);
      assert.equal(rows[0]?.device_id, deviceId);
      assert.deepEqual(rows[0]?.detail, { kind: 'desktop', platform: 'win32', name: '审计PC' });
    } finally {
      await ctx.close();
    }
  });

  test('设备码占位设备升级（upgradePendingDevice 分支）同样写 device.register', async () => {
    const ctx = await createContext({ withTunnel: false });
    try {
      await ctx.pool.query(
        `INSERT INTO devices (account_id, kind, name, platform, sign_public_key, ecdh_public_key)
         VALUES ($1, 'desktop', '待升级PC', 'win32', $2, 'pending-ecdh')`,
        [ctx.session.accountId, PENDING_DEVICE_KEY],
      );

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(ctx.session),
        payload: { name: '待升级PC', platform: 'win32', appVersion: '1.0.0', signPublicKey: 'real-sign', ecdhPublicKey: 'real-ecdh' },
      });
      assert.equal(created.statusCode, 201);

      const rows = await audits(ctx.pool, 'device.register');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.device_id, (created.json() as { device: { id: string } }).device.id);
      assert.equal((rows[0]?.detail as { name?: string }).name, '待升级PC');
    } finally {
      await ctx.close();
    }
  });

  test('未登录访问代理写 proxy.denied（reason=unauthenticated），且不含令牌', async () => {
    const ctx = await createContext({ withTunnel: false });
    try {
      const secret = 'super-secret-token-value';
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/api/session/list?token=${secret}`,
        headers: { accept: 'application/json' },
      });
      assert.equal(response.statusCode, 401);

      const rows = await audits(ctx.pool, 'proxy.denied');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.result, 'denied');
      assert.equal(rows[0]?.account_id, null);
      assert.equal(rows[0]?.device_id, null);
      assert.deepEqual(rows[0]?.detail, {
        reason: 'unauthenticated',
        method: 'GET',
        path: `/t/${ctx.session.deviceId}/api/session/list`,
      });
      assert.ok(!JSON.stringify(rows[0]?.detail).includes(secret), '审计不得含令牌');
    } finally {
      await ctx.close();
    }
  });

  test('跨账号访问写 proxy.denied（reason=cross_account）', async () => {
    const ctx = await createContext({ withTunnel: false });
    try {
      await registerAccount({ app: ctx.app }, 'other@example.com');
      const other = await loginAccount({ app: ctx.app }, { email: 'other@example.com' });

      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${other.deviceId}/api/session/list`,
        headers: { ...cookieHeader(ctx.session), accept: 'application/json' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'authz.forbidden');

      const rows = await audits(ctx.pool, 'proxy.denied');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.account_id, ctx.session.accountId);
      assert.equal(rows[0]?.device_id, other.deviceId);
      assert.equal((rows[0]?.detail as { reason?: string }).reason, 'cross_account');
    } finally {
      await ctx.close();
    }
  });

  test('设备离线 503 写 proxy.denied（reason=tunnel_offline）', async () => {
    const ctx = await createContext({ withTunnel: false });
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/t/${ctx.session.deviceId}/api/session/list`,
        headers: { ...cookieHeader(ctx.session), accept: 'application/json' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'tunnel.device_offline');

      const rows = await audits(ctx.pool, 'proxy.denied');
      assert.equal(rows.length, 1);
      assert.equal((rows[0]?.detail as { reason?: string }).reason, 'tunnel_offline');
      assert.equal(rows[0]?.device_id, ctx.session.deviceId);
    } finally {
      await ctx.close();
    }
  });

  test('路径不在白名单 403 写 proxy.denied（reason=path_denied）', async () => {
    const ctx = await createContext();
    try {
      const response = await ctx.app.inject({
        method: 'DELETE',
        url: `/t/${ctx.session.deviceId}/api/pair/abc`,
        headers: { ...cookieHeader(ctx.session), accept: 'application/json' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'tunnel.path_denied');

      const rows = await audits(ctx.pool, 'proxy.denied');
      assert.equal(rows.length, 1);
      assert.equal((rows[0]?.detail as { reason?: string }).reason, 'path_denied');
      assert.equal((rows[0]?.detail as { method?: string }).method, 'DELETE');
      assert.equal((rows[0]?.detail as { path?: string }).path, `/t/${ctx.session.deviceId}/api/pair/abc`);
    } finally {
      await ctx.close();
    }
  });
});
