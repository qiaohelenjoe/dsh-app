import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { defaultMigrationsDir } from '../src/db/migrate.js';
import type { DbPool } from '../src/db/pool.js';
import { makeTestAuthConfig } from './helpers/auth.js';

/** 重置密码页不碰数据库，桩一个 pool 即可。 */
function buildResetPageApp() {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as DbPool;
  return buildApp({ pool, migrationsDir: defaultMigrationsDir(), authConfig: makeTestAuthConfig() });
}

test('GET /reset 返回重置密码页面', async () => {
  const app = buildResetPageApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/reset' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type'] ?? ''), /text\/html/);
    // 页面自己调重置接口，并带新密码输入框
    assert.match(response.body, /\/v1\/auth\/reset-password/);
    assert.match(response.body, /id="password"/);
    assert.match(response.body, /id="confirm"/);
  } finally {
    await app.close();
  }
});

test('GET /reset?t=token 也返回同一页面（令牌由页面脚本读取）', async () => {
  const app = buildResetPageApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/reset?t=abc123' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type'] ?? ''), /text\/html/);
  } finally {
    await app.close();
  }
});
