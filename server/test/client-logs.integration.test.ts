import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { authHeader, createAuthTestContext, loginAccount, registerAccount } from './helpers/auth.js';

interface UploadBody {
  accepted: number;
}

describe('客户端日志上传', () => {
  test('登录后可批量上传，敏感字段被脱敏', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/client-logs',
        headers: authHeader(session),
        payload: {
          appVersion: '0.1.12',
          platform: 'android',
          entries: [
            {
              level: 'error',
              event: 'api_error',
              message: 'POST /api/session/list?token=secret-token -> 504',
              requestId: 'req-abc',
              context: {
                token: 'secret-token',
                status: 504,
                ms: 60001,
                url: '/api/session/list?access_token=secret-token',
              },
            },
          ],
        },
      });

      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), { accepted: 1 } satisfies UploadBody);

      const rows = await ctx.pool.query('SELECT * FROM client_logs');
      assert.equal(rows.rowCount, 1);
      const row = rows.rows[0] as {
        level: string;
        message: string;
        context: Record<string, unknown>;
        request_id: string | null;
        device_id: string | null;
      };
      assert.equal(row.level, 'error');
      assert.equal(row.request_id, 'req-abc');
      assert.equal(row.device_id, session.deviceId);
      assert.ok(!JSON.stringify(row).includes('secret-token'), '日志中不应出现 token 明文');
      assert.ok(!('token' in row.context));
      assert.equal(row.context.status, 504);
    } finally {
      await ctx.close();
    }
  });

  test('未携带访问令牌返回 401', async () => {
    const ctx = await createAuthTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/client-logs',
        payload: {
          entries: [{ level: 'info', message: 'hello' }],
        },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await ctx.close();
    }
  });

  test('空批次或非法级别返回 400', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);
      const empty = await ctx.app.inject({
        method: 'POST',
        url: '/v1/client-logs',
        headers: authHeader(session),
        payload: { entries: [] },
      });
      assert.equal(empty.statusCode, 400);
      const invalid = await ctx.app.inject({
        method: 'POST',
        url: '/v1/client-logs',
        headers: authHeader(session),
        payload: { entries: [{ level: 'fatal', message: 'x' }] },
      });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await ctx.close();
    }
  });
});
