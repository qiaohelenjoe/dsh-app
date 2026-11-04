import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import type { PasswordResetMail } from '../../src/auth/mailer.js';
import type { AuthConfig } from '../../src/config.js';
import type { TunnelControl } from '../../src/devices/tunnel-hooks.js';
import { defaultMigrationsDir, runMigrations } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { createTempDatabase, type TempDatabase } from './db.js';

export const TEST_PASSWORD = 'Str0ng-Passw0rd-2026';
export const TEST_NEW_PASSWORD = 'An0ther-Str0ng-Pass-2026';

export function makeTestAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtSecret: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    refreshPepper: 'test-refresh-pepper-0123456789',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: 30,
    emailVerificationEnabled: false,
    weakPasswordListPath: fileURLToPath(new URL('../../data/weak-passwords.txt', import.meta.url)),
    publicBaseUrl: 'http://web.test.local',
    deviceCodePollIntervalSeconds: 0.2,
    ...overrides,
  };
}

export interface AuthTestOptions {
  tunnel?: TunnelControl;
}

export interface AuthTestContext {
  db: TempDatabase;
  pool: pg.Pool;
  app: FastifyInstance;
  mails: PasswordResetMail[];
  close(): Promise<void>;
}

/** 一次性数据库 + 真 Postgres 迁移 + 带测试配置的 app（含捕获型 mailer）。 */
export async function createAuthTestContext(
  config: Partial<AuthConfig> = {},
  options: AuthTestOptions = {},
): Promise<AuthTestContext> {
  const db = await createTempDatabase();
  const pool = createPool({ databaseUrl: db.url });
  await runMigrations(pool);
  const mails: PasswordResetMail[] = [];
  const app = buildApp({
    pool,
    migrationsDir: defaultMigrationsDir(),
    authConfig: makeTestAuthConfig(config),
    mailer: {
      async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
        mails.push(mail);
      },
    },
    ...(options.tunnel ? { tunnel: options.tunnel } : {}),
  });
  return {
    db,
    pool,
    app,
    mails,
    async close(): Promise<void> {
      await app.close();
      await pool.end().catch(() => undefined);
      await db.drop();
    },
  };
}

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  accountId: string;
  email: string;
}

export function authHeader(session: AccountSession): { authorization: string } {
  return { authorization: `Bearer ${session.accessToken}` };
}

const DEVICE_KEYS = { signPublicKey: 'sign-public-key', ecdhPublicKey: 'ecdh-public-key' };

/** 只需要 Fastify 实例的轻量上下文（隧道测试等复用登录辅助）。 */
export interface AppHolder {
  app: FastifyInstance;
}

export async function registerAccount(
  ctx: AppHolder,
  email = 'user@example.com',
  password = TEST_PASSWORD,
): Promise<void> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password },
  });
  if (response.statusCode !== 201) {
    throw new Error(`注册失败（${response.statusCode}）：${response.body}`);
  }
}

export interface LoginOptions {
  email?: string;
  password?: string;
  deviceName?: string;
  platform?: string;
  clientType?: 'mobile' | 'desktop';
}

/** 登录并返回会话令牌（设备名/平台不同即建立不同设备）。 */
export async function loginAccount(ctx: AppHolder, options: LoginOptions = {}): Promise<AccountSession> {
  const email = options.email ?? 'user@example.com';
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      email,
      password: options.password ?? TEST_PASSWORD,
      clientType: options.clientType ?? 'mobile',
      device: {
        name: options.deviceName ?? 'iPhone 15',
        platform: options.platform ?? 'ios',
        appVersion: '1.0.0',
        ...DEVICE_KEYS,
      },
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`登录失败（${response.statusCode}）：${response.body}`);
  }
  const body = response.json() as {
    account: { id: string };
    device: { id: string };
    accessToken: string;
    refreshToken: string;
  };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    deviceId: body.device.id,
    accountId: body.account.id,
    email,
  };
}
