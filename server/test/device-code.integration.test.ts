import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  authHeader,
  createAuthTestContext,
  loginAccount,
  registerAccount,
  type AccountSession,
  type AuthTestContext,
} from './helpers/auth.js';

interface ErrorBody {
  error: { code: string; message: string };
}
interface DeviceCodeBody {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}
interface TokenBody {
  account: { id: string; email: string };
  device: { id: string; name: string; kind: string; platform: string };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function requestCode(
  ctx: AuthTestContext,
  deviceName = '我的电脑',
  platform = 'win32',
): Promise<Awaited<ReturnType<AuthTestContext['app']['inject']>>> {
  return ctx.app.inject({ method: 'POST', url: '/v1/auth/device-code', payload: { deviceName, platform } });
}

async function poll(
  ctx: AuthTestContext,
  deviceCode: string,
): Promise<Awaited<ReturnType<AuthTestContext['app']['inject']>>> {
  return ctx.app.inject({ method: 'POST', url: '/v1/auth/device-token', payload: { deviceCode } });
}

async function approve(
  ctx: AuthTestContext,
  session: AccountSession,
  userCode: string,
  decision: 'approve' | 'deny' = 'approve',
): Promise<Awaited<ReturnType<AuthTestContext['app']['inject']>>> {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/device-code/approve',
    headers: authHeader(session),
    payload: { userCode, decision },
  });
}

describe('设备码授权（T04）', () => {
  test('申请设备码返回 8 位 userCode、deviceCode 与 10 分钟有效期', async () => {
    const ctx = await createAuthTestContext();
    try {
      const response = await requestCode(ctx);
      assert.equal(response.statusCode, 200);
      const body = response.json() as DeviceCodeBody;
      assert.match(body.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.ok(body.deviceCode.startsWith('dc_') && body.deviceCode.length > 20);
      assert.equal(body.expiresIn, 600);
      assert.equal(body.verificationUrl, 'http://web.test.local/activate');
      assert.ok(body.interval > 0);
    } finally {
      await ctx.close();
    }
  });

  test('未确认时轮询返回 202 auth.device_code_pending', async () => {
    const ctx = await createAuthTestContext();
    try {
      const code = (await requestCode(ctx)).json() as DeviceCodeBody;
      const response = await poll(ctx, code.deviceCode);
      assert.equal(response.statusCode, 202);
      const body = response.json() as { status: string; error: ErrorBody['error'] };
      assert.equal(body.status, 'pending');
      assert.equal(body.error.code, 'auth.device_code_pending');
    } finally {
      await ctx.close();
    }
  });

  test('批准后轮询拿到令牌，且该令牌可成功登记设备（占位设备被升级）', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const browser = await loginAccount(ctx, { deviceName: '浏览器授权页', platform: 'win32' });
      const code = (await requestCode(ctx)).json() as DeviceCodeBody;
      assert.equal((await poll(ctx, code.deviceCode)).statusCode, 202);

      const approved = await approve(ctx, browser, code.userCode);
      assert.equal(approved.statusCode, 200);
      assert.deepEqual(approved.json(), { status: 'approved' });

      const tokenResponse = await poll(ctx, code.deviceCode);
      assert.equal(tokenResponse.statusCode, 200);
      const tokens = tokenResponse.json() as TokenBody;
      assert.ok(tokens.accessToken.length > 20);
      assert.ok(tokens.refreshToken.startsWith('rt_'));
      assert.equal(tokens.account.email, 'user@example.com');
      assert.equal(tokens.device.kind, 'desktop');

      const registered = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: {
          name: '我的电脑',
          platform: 'win32',
          appVersion: '0.2.1-rc.2',
          signPublicKey: 'sign-real-key',
          ecdhPublicKey: 'ecdh-real-key',
        },
      });
      assert.equal(registered.statusCode, 201, registered.body);

      const stored = await ctx.pool.query<{ sign_public_key: string; app_version: string | null }>(
        'SELECT sign_public_key, app_version FROM devices WHERE id = $1',
        [tokens.device.id],
      );
      assert.equal(stored.rows[0]?.sign_public_key, 'sign-real-key');
      assert.equal(stored.rows[0]?.app_version, '0.2.1-rc.2');

      // 设备码一次性：再次轮询应失败
      const replay = await poll(ctx, code.deviceCode);
      assert.equal(replay.statusCode, 400);
    } finally {
      await ctx.close();
    }
  });

  test('网页端拒绝后轮询返回 403 auth.device_code_denied', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const browser = await loginAccount(ctx, { deviceName: '浏览器授权页', platform: 'win32' });
      const code = (await requestCode(ctx)).json() as DeviceCodeBody;
      const denied = await approve(ctx, browser, code.userCode, 'deny');
      assert.equal(denied.statusCode, 200);
      assert.deepEqual(denied.json(), { status: 'denied' });

      const response = await poll(ctx, code.deviceCode);
      assert.equal(response.statusCode, 403);
      assert.equal((response.json() as ErrorBody).error.code, 'auth.device_code_denied');
    } finally {
      await ctx.close();
    }
  });

  test('超过 10 分钟返回 410 auth.device_code_expired', async () => {
    const ctx = await createAuthTestContext();
    try {
      const code = (await requestCode(ctx)).json() as DeviceCodeBody;
      await ctx.pool.query(
        `UPDATE device_codes SET expires_at = now() - interval '1 minute' WHERE device_code = $1`,
        [code.deviceCode],
      );
      const response = await poll(ctx, code.deviceCode);
      assert.equal(response.statusCode, 410);
      assert.equal((response.json() as ErrorBody).error.code, 'auth.device_code_expired');
    } finally {
      await ctx.close();
    }
  });

  test('重复申请使旧码失效（userCode 仅保留一个 pending）', async () => {
    const ctx = await createAuthTestContext();
    try {
      const first = (await requestCode(ctx)).json() as DeviceCodeBody;
      const second = (await requestCode(ctx)).json() as DeviceCodeBody;
      assert.notEqual(first.deviceCode, second.deviceCode);

      const oldPoll = await poll(ctx, first.deviceCode);
      assert.equal(oldPoll.statusCode, 410);
      assert.equal((oldPoll.json() as ErrorBody).error.code, 'auth.device_code_expired');

      const newPoll = await poll(ctx, second.deviceCode);
      assert.equal(newPoll.statusCode, 202);

      const pending = await ctx.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM device_codes WHERE status = 'pending'`,
      );
      assert.equal(pending.rows[0]?.count, '1');
    } finally {
      await ctx.close();
    }
  });

  test('轮询频率低于 interval 返回 429 并带 Retry-After', async () => {
    const ctx = await createAuthTestContext({ deviceCodePollIntervalSeconds: 0.2 });
    try {
      const code = (await requestCode(ctx)).json() as DeviceCodeBody;
      assert.equal((await poll(ctx, code.deviceCode)).statusCode, 202);

      const tooFast = await poll(ctx, code.deviceCode);
      assert.equal(tooFast.statusCode, 429);
      assert.equal((tooFast.json() as ErrorBody).error.code, 'rate_limit.exceeded');
      assert.ok(tooFast.headers['retry-after'] !== undefined);

      await sleep(250);
      assert.equal((await poll(ctx, code.deviceCode)).statusCode, 202);
    } finally {
      await ctx.close();
    }
  });

  test('确认设备码需要登录态', async () => {
    const ctx = await createAuthTestContext();
    try {
      const code = (await requestCode(ctx)).json() as DeviceCodeBody;
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/device-code/approve',
        payload: { userCode: code.userCode, decision: 'approve' },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await ctx.close();
    }
  });

  test('激活页可访问且返回 HTML', async () => {
    const ctx = await createAuthTestContext();
    try {
      const response = await ctx.app.inject({ method: 'GET', url: '/activate' });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] as string, /text\/html/);
      assert.match(response.body, /激活 DSH 桌面端/);
    } finally {
      await ctx.close();
    }
  });
});
