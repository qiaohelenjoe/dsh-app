import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  authHeader,
  createAuthTestContext,
  loginAccount,
  registerAccount,
  type AccountSession,
} from './helpers/auth.js';

interface AccountBody {
  account: {
    id: string;
    email: string;
    displayName: string | null;
    emailVerified: boolean;
    createdAt: string;
    limits: { desktopDevices: number; mobileDevices: number };
  };
  usage: { desktopDevices: number; mobileDevices: number };
}

async function getAccount(
  ctx: Awaited<ReturnType<typeof createAuthTestContext>>,
  session: AccountSession,
): Promise<Awaited<ReturnType<typeof ctx.app.inject>>> {
  return ctx.app.inject({ method: 'GET', url: '/v1/account', headers: authHeader(session) });
}

function registerDevicePayload(name: string, platform: string): Record<string, unknown> {
  return {
    name,
    platform,
    appVersion: '1.0.0',
    signPublicKey: 'sign-key',
    ecdhPublicKey: 'ecdh-key',
  };
}

describe('账号信息 GET /v1/account（R01）', () => {
  test('登录后返回账号信息与配额上限（2/3）', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx, 'me@example.com');
      const session = await loginAccount(ctx, { email: 'me@example.com' });

      const response = await getAccount(ctx, session);
      assert.equal(response.statusCode, 200);
      const body = response.json() as AccountBody;

      assert.equal(body.account.id, session.accountId);
      assert.equal(body.account.email, 'me@example.com');
      assert.equal(body.account.displayName, null);
      assert.equal(body.account.emailVerified, false);
      assert.equal(typeof body.account.createdAt, 'string');
      assert.equal(new Date(body.account.createdAt).toISOString(), body.account.createdAt);
      assert.deepEqual(body.account.limits, { desktopDevices: 2, mobileDevices: 2 });
      // 登录本身会登记 1 台移动设备
      assert.deepEqual(body.usage, { desktopDevices: 0, mobileDevices: 1 });
    } finally {
      await ctx.close();
    }
  });

  test('无 token 返回 401 auth.token_invalid', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      const missing = await ctx.app.inject({ method: 'GET', url: '/v1/account' });
      assert.equal(missing.statusCode, 401);
      assert.equal((missing.json() as { error: { code: string } }).error.code, 'auth.token_invalid');

      const invalid = await ctx.app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      assert.equal(invalid.statusCode, 401);
      assert.equal((invalid.json() as { error: { code: string } }).error.code, 'auth.token_invalid');
      assert.ok(session.accessToken);
    } finally {
      await ctx.close();
    }
  });

  test('跨账号隔离：A 的令牌只能看到 A 的账号与用量', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx, 'a@example.com');
      await registerAccount(ctx, 'b@example.com');
      const sessionA = await loginAccount(ctx, { email: 'a@example.com', deviceName: 'A 的手机', platform: 'ios' });
      const sessionB = await loginAccount(ctx, { email: 'b@example.com', deviceName: 'B 的手机', platform: 'ios' });

      const responseA = await getAccount(ctx, sessionA);
      const bodyA = responseA.json() as AccountBody;
      assert.equal(bodyA.account.id, sessionA.accountId);
      assert.equal(bodyA.account.email, 'a@example.com');
      // 登录本身会登记 1 台移动设备
      assert.deepEqual(bodyA.usage, { desktopDevices: 0, mobileDevices: 1 });

      const responseB = await getAccount(ctx, sessionB);
      const bodyB = responseB.json() as AccountBody;
      assert.equal(bodyB.account.id, sessionB.accountId);
      assert.equal(bodyB.account.email, 'b@example.com');
      assert.notEqual(bodyA.account.id, bodyB.account.id);
    } finally {
      await ctx.close();
    }
  });

  test('注册 1 台桌面设备后 usage.desktopDevices=1', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(session),
        payload: registerDevicePayload('我的电脑', 'win32'),
      });
      assert.equal(created.statusCode, 201);

      const response = await getAccount(ctx, session);
      assert.equal(response.statusCode, 200);
      const body = response.json() as AccountBody;
      assert.deepEqual(body.usage, { desktopDevices: 1, mobileDevices: 1 });
    } finally {
      await ctx.close();
    }
  });

  test('撤销设备后 usage 同步减少', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(session),
        payload: registerDevicePayload('要被撤销的PC', 'win32'),
      });
      assert.equal(created.statusCode, 201);
      const deviceId = (created.json() as { device: { id: string } }).device.id;

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${deviceId}`,
        headers: authHeader(session),
      });
      assert.equal(removed.statusCode, 204);

      const body = (await getAccount(ctx, session)).json() as AccountBody;
      assert.deepEqual(body.usage, { desktopDevices: 0, mobileDevices: 1 });
    } finally {
      await ctx.close();
    }
  });
});
