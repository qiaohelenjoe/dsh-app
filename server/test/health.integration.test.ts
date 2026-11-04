import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createTempDatabase } from './helpers/db.js';
import { makeTestAuthConfig } from './helpers/auth.js';

const MIGRATIONS_DIR = defaultMigrationsDir();
const LATEST_SCHEMA_VERSION = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.slice(0, 4))
  .sort()
  .at(-1);

interface HealthBody {
  status: string;
  db: string;
  schemaVersion?: string | null;
  reason?: string;
}

describe('/healthz（T01）', () => {
  test('数据库可用时返回 200 与结构版本', async () => {
    const db = await createTempDatabase();
    const pool = createPool({ databaseUrl: db.url });
    try {
      await runMigrations(pool, MIGRATIONS_DIR);
      const app = buildApp({ pool, migrationsDir: MIGRATIONS_DIR, authConfig: makeTestAuthConfig() });
      try {
        const response = await app.inject({ method: 'GET', url: '/healthz' });
        assert.equal(response.statusCode, 200);
        const body = response.json<HealthBody>();
        assert.equal(body.status, 'ok');
        assert.equal(body.db, 'up');
        assert.equal(body.schemaVersion, LATEST_SCHEMA_VERSION);
      } finally {
        await app.close();
      }
    } finally {
      await pool.end().catch(() => undefined);
      await db.drop();
    }
  });

  test('数据库不可用时返回 503 且带原因', async () => {
    const pool = createPool({ databaseUrl: 'postgres://postgres:postgres@127.0.0.1:1/postgres' });
    const app = buildApp({ pool, migrationsDir: MIGRATIONS_DIR, authConfig: makeTestAuthConfig() });
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(response.statusCode, 503);
      const body = response.json<HealthBody>();
      assert.equal(body.status, 'error');
      assert.equal(body.db, 'down');
      assert.ok(typeof body.reason === 'string' && body.reason.length > 0);
    } finally {
      await app.close();
      await pool.end().catch(() => undefined);
    }
  });

  test('连接池空闲连接异常不会以未处理错误杀死进程', () => {
    const errors: Error[] = [];
    const pool = createPool({
      databaseUrl: 'postgres://postgres:postgres@127.0.0.1:55432/postgres',
      onIdleError: (error) => errors.push(error),
    });
    try {
      // 数据库重启/断网时 pg 会在空闲连接上 emit('error')；没有监听器时这里会抛异常
      assert.doesNotThrow(() => pool.emit('error', new Error('simulated idle connection failure')));
      assert.equal(errors.length, 1);
    } finally {
      void pool.end();
    }
  });

  test('结构版本不匹配时返回 503 并说明落后', async () => {
    const db = await createTempDatabase();
    const pool = createPool({ databaseUrl: db.url });
    const app = buildApp({ pool, migrationsDir: MIGRATIONS_DIR, authConfig: makeTestAuthConfig() });
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(response.statusCode, 503);
      const body = response.json<HealthBody>();
      assert.equal(body.db, 'up');
      assert.match(body.reason ?? '', /落后/);
    } finally {
      await app.close();
      await pool.end().catch(() => undefined);
      await db.drop();
    }
  });
});
