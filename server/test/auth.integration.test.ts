import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SignJWT } from 'jose';
import { hashRefreshSecret } from '../src/security/tokens.js';
import {
  createAuthTestContext,
  makeTestAuthConfig,
  TEST_NEW_PASSWORD,
  TEST_PASSWORD,
  type AuthTestContext,
} from './helpers/auth.js';

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}
interface LoginBody {
  account: { id: string; email: string };
  device: { id: string; name: string; kind: string; platform: string };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const REGISTER_BODY = { email: 'user@example.com', password: TEST_PASSWORD, displayName: '测试用户' };

function loginPayload(
  email = 'user@example.com',
  password = TEST_PASSWORD,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email,
    password,
    clientType: 'mobile',
    device: {
      name: 'iPhone 15',
      platform: 'ios',
      appVersion: '1.0.0',
      signPublicKey: 'sign-public-key',
      ecdhPublicKey: 'ecdh-public-key',
    },
    ...overrides,
  };
}

async function register(
  ctx: AuthTestContext,
  body: Record<string, unknown> = REGISTER_BODY,
): Promise<Awaited<ReturnType<AuthTestContext['app']['inject']>>> {
  return ctx.app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
}

async function login(
  ctx: AuthTestContext,
  body: Record<string, unknown> = loginPayload(),
): Promise<Awaited<ReturnType<AuthTestContext['app']['inject']>>> {
  return ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: body });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1] as string;
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('认证 API（T02）', () => {
  test('注册成功 201；重复邮箱（大小写不敏感）返回 409 conflict.email_taken', async () => {
    const ctx = await createAuthTestContext();
    try {
      const first = await register(ctx);
      assert.equal(first.statusCode, 201);
      const created = first.json() as { account: { id: string; email: string }; verificationRequired: boolean };
      assert.equal(created.account.email, 'user@example.com');
      assert.equal(created.verificationRequired, false);

      const duplicate = await register(ctx, { email: 'USER@Example.com', password: TEST_PASSWORD });
      assert.equal(duplicate.statusCode, 409);
      assert.equal((duplicate.json() as ErrorBody).error.code, 'conflict.email_taken');
    } finally {
      await ctx.close();
    }
  });

  test('弱口令：不足 10 位或命中前 10 万弱口令列表返回 400 request.weak_password', async () => {
    const ctx = await createAuthTestContext();
    try {
      const tooShort = await register(ctx, { email: 'a@example.com', password: 'short' });
      assert.equal(tooShort.statusCode, 400);
      assert.equal((tooShort.json() as ErrorBody).error.code, 'request.weak_password');

      const blacklisted = await register(ctx, { email: 'b@example.com', password: '1234567890' });
      assert.equal(blacklisted.statusCode, 400);
      assert.equal((blacklisted.json() as ErrorBody).error.code, 'request.weak_password');
    } finally {
      await ctx.close();
    }
  });

  test('登录成功返回 access/refresh/device；错误凭据统一 401 且不区分原因', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);

      const ok = await login(ctx);
      assert.equal(ok.statusCode, 200);
      const body = ok.json() as LoginBody;
      assert.ok(body.accessToken.length > 20);
      assert.ok(body.refreshToken.startsWith('rt_'));
      assert.equal(body.expiresIn, 900);
      assert.equal(body.device.kind, 'mobile');
      assert.equal(body.device.platform, 'ios');

      const wrongPassword = await login(ctx, loginPayload('user@example.com', 'Wrong-Passw0rd-2026'));
      assert.equal(wrongPassword.statusCode, 401);
      const wrongBody = wrongPassword.json() as ErrorBody;
      assert.equal(wrongBody.error.code, 'auth.invalid_credentials');

      const unknownEmail = await login(ctx, loginPayload('nobody@example.com', TEST_PASSWORD));
      assert.equal(unknownEmail.statusCode, 401);
      const unknownBody = unknownEmail.json() as ErrorBody;
      assert.equal(unknownBody.error.code, wrongBody.error.code);
      assert.equal(unknownBody.error.message, wrongBody.error.message);
    } finally {
      await ctx.close();
    }
  });

  test('同设备再次登录复用已有设备记录', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const first = (await login(ctx)).json() as LoginBody;
      const second = (await login(ctx)).json() as LoginBody;
      assert.equal(second.device.id, first.device.id);
    } finally {
      await ctx.close();
    }
  });

  test('refresh 不轮换：同一枚 refresh 可反复使用，不撤销会话', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const loginBody = (await login(ctx)).json() as LoginBody;

      const first = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: loginBody.refreshToken },
      });
      assert.equal(first.statusCode, 200);
      const firstBody = first.json() as { accessToken: string; refreshToken: string };
      assert.equal(firstBody.refreshToken, loginBody.refreshToken, '刷新令牌保持不变');

      // 同一枚令牌反复刷新（并发/多页面场景）不应被判定为盗用
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: loginBody.refreshToken },
      });
      assert.equal(second.statusCode, 200);
      const secondBody = second.json() as { accessToken: string };
      assert.equal((second.json() as { refreshToken: string }).refreshToken, loginBody.refreshToken);

      // 会话仍然有效
      const account = await ctx.app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: { authorization: `Bearer ${secondBody.accessToken}` },
      });
      assert.equal(account.statusCode, 200);
    } finally {
      await ctx.close();
    }
  });

  test('并发刷新同一令牌：两次都返回 200，不撤销会话', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const loginBody = (await login(ctx)).json() as LoginBody;

      const [a, b] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: { refreshToken: loginBody.refreshToken },
        }),
        ctx.app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: { refreshToken: loginBody.refreshToken },
        }),
      ]);
      assert.equal(a.statusCode, 200);
      assert.equal(b.statusCode, 200);

      // 会话没有被撤销：再刷新一次仍然成功
      const again = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: loginBody.refreshToken },
      });
      assert.equal(again.statusCode, 200);
    } finally {
      await ctx.close();
    }
  });

  test('上一代 refresh 令牌（历史轮换遗留）仍可换 access token，不撤销会话', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const loginBody = (await login(ctx)).json() as LoginBody;
      const sessionId = decodeJwtPayload(loginBody.accessToken)['sid'] as string;

      // 模拟历史轮换留下的上一代令牌：prev 哈希指向它，当前哈希仍是登录时那枚
      const oldSecret = 'legacy-secret-from-old-rotation';
      const oldToken = `rt_${sessionId}_${oldSecret}`;
      await ctx.pool.query(
        'UPDATE sessions SET prev_refresh_token_hash = $1, prev_refresh_used_at = now() WHERE id = $2',
        [hashRefreshSecret(oldSecret, makeTestAuthConfig().refreshPepper), sessionId],
      );

      const refreshed = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: oldToken },
      });
      assert.equal(refreshed.statusCode, 200);
      const body = refreshed.json() as { accessToken: string; refreshToken: string };
      assert.equal(body.refreshToken, oldToken, '原样返回，不轮换');

      const account = await ctx.app.inject({
        method: 'GET',
        url: '/v1/account',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      assert.equal(account.statusCode, 200);

      // 当前令牌仍然可用（会话未被撤销/未被替换）
      const current = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: loginBody.refreshToken },
      });
      assert.equal(current.statusCode, 200);
    } finally {
      await ctx.close();
    }
  });

  test('access token 过期返回 401 auth.token_expired', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const loginBody = (await login(ctx)).json() as LoginBody;
      const payload = decodeJwtPayload(loginBody.accessToken);
      const sessionId = payload['sid'] as string;
      const accountId = payload['sub'] as string;

      const now = Math.floor(Date.now() / 1000);
      const expired = await new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(accountId)
        .setIssuedAt(now - 3600)
        .setExpirationTime(now - 1800)
        .sign(new TextEncoder().encode(makeTestAuthConfig().jwtSecret));

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/change-password',
        headers: { authorization: `Bearer ${expired}` },
        payload: { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD },
      });
      assert.equal(response.statusCode, 401);
      assert.equal((response.json() as ErrorBody).error.code, 'auth.token_expired');
    } finally {
      await ctx.close();
    }
  });

  test('改密成功后除当前会话外全部会话失效', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const sessionA = (await login(ctx)).json() as LoginBody;
      const sessionB = (
        await login(
          ctx,
          loginPayload('user@example.com', TEST_PASSWORD, {
            device: {
              name: 'Pixel 9',
              platform: 'android',
              signPublicKey: 'sign-public-key-b',
              ecdhPublicKey: 'ecdh-public-key-b',
            },
          }),
        )
      ).json() as LoginBody;

      const changed = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/change-password',
        headers: { authorization: `Bearer ${sessionA.accessToken}` },
        payload: { currentPassword: TEST_PASSWORD, newPassword: TEST_NEW_PASSWORD },
      });
      assert.equal(changed.statusCode, 204);

      const otherSession = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: sessionB.refreshToken },
      });
      assert.equal(otherSession.statusCode, 401);

      const currentSession = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: sessionA.refreshToken },
      });
      assert.equal(currentSession.statusCode, 200);

      // 新密码可登录，旧密码不可
      assert.equal((await login(ctx, loginPayload('user@example.com', TEST_NEW_PASSWORD))).statusCode, 200);
      assert.equal((await login(ctx, loginPayload('user@example.com', TEST_PASSWORD))).statusCode, 401);
    } finally {
      await ctx.close();
    }
  });

  test('忘记密码恒返回 202；重置后全部会话失效', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const session = (await login(ctx)).json() as LoginBody;

      const existing = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/forgot-password',
        payload: { email: 'user@example.com' },
      });
      assert.equal(existing.statusCode, 202);
      assert.equal(ctx.mails.length, 1);

      const unknown = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/forgot-password',
        payload: { email: 'nobody@example.com' },
      });
      assert.equal(unknown.statusCode, 202);
      assert.equal(ctx.mails.length, 1, '不存在的邮箱不应产生邮件');

      const mail = ctx.mails[0];
      assert.ok(mail);
      const reset = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/reset-password',
        payload: { token: mail.token, newPassword: TEST_NEW_PASSWORD },
      });
      assert.equal(reset.statusCode, 204);

      const oldSession = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: session.refreshToken },
      });
      assert.equal(oldSession.statusCode, 401);

      assert.equal((await login(ctx, loginPayload('user@example.com', TEST_NEW_PASSWORD))).statusCode, 200);
    } finally {
      await ctx.close();
    }
  });

  test('登录第 6 次/分钟触发 429 并带 Retry-After', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const badLogin = loginPayload('user@example.com', 'Wrong-Passw0rd-2026');
      for (let i = 0; i < 5; i += 1) {
        const response = await login(ctx, badLogin);
        assert.equal(response.statusCode, 401);
      }
      const limited = await login(ctx, badLogin);
      assert.equal(limited.statusCode, 429);
      assert.equal((limited.json() as ErrorBody).error.code, 'rate_limit.exceeded');
      const retryAfter = limited.headers['retry-after'];
      assert.ok(retryAfter !== undefined && Number(retryAfter) > 0);
    } finally {
      await ctx.close();
    }
  });

  test('密码只以 argon2id 哈希入库（无明文）', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const result = await ctx.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM accounts WHERE email = $1',
        ['user@example.com'],
      );
      const hash = result.rows[0]?.password_hash ?? '';
      assert.ok(hash.startsWith('$argon2id$'), `实际哈希前缀: ${hash.slice(0, 12)}`);
      assert.match(hash, /m=65536,t=3,p=4/);
      assert.notEqual(hash, TEST_PASSWORD);
      assert.ok(!hash.includes(TEST_PASSWORD));
    } finally {
      await ctx.close();
    }
  });

  test('全部端点有 zod 入参校验，非法参数返回 400 request.invalid', async () => {
    const ctx = await createAuthTestContext();
    try {
      const badRegister = await register(ctx, { email: 'not-an-email', password: TEST_PASSWORD });
      assert.equal(badRegister.statusCode, 400);
      assert.equal((badRegister.json() as ErrorBody).error.code, 'request.invalid');

      const missingDevice = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'user@example.com', password: TEST_PASSWORD },
      });
      assert.equal(missingDevice.statusCode, 400);
      assert.equal((missingDevice.json() as ErrorBody).error.code, 'request.invalid');

      const badRefresh = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {},
      });
      assert.equal(badRefresh.statusCode, 400);
      assert.equal((badRefresh.json() as ErrorBody).error.code, 'request.invalid');
    } finally {
      await ctx.close();
    }
  });

  test('登出只撤销当前会话', async () => {
    const ctx = await createAuthTestContext();
    try {
      await register(ctx);
      const sessionA = (await login(ctx)).json() as LoginBody;
      const sessionB = (
        await login(
          ctx,
          loginPayload('user@example.com', TEST_PASSWORD, {
            device: {
              name: 'Pixel 9',
              platform: 'android',
              signPublicKey: 'sign-public-key-b',
              ecdhPublicKey: 'ecdh-public-key-b',
            },
          }),
        )
      ).json() as LoginBody;

      const logout = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken: sessionA.refreshToken },
      });
      assert.equal(logout.statusCode, 204);

      const revoked = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: sessionA.refreshToken },
      });
      assert.equal(revoked.statusCode, 401);

      const stillAlive = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: sessionB.refreshToken },
      });
      assert.equal(stillAlive.statusCode, 200);
    } finally {
      await ctx.close();
    }
  });
});
