import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import pg from 'pg';
import {
  assertSchemaVersion,
  defaultMigrationsDir,
  readSchemaState,
  runMigrations,
  SchemaVersionError,
} from '../src/db/migrate.js';
import { createTempDatabase, type TempDatabase } from './helpers/db.js';

const MIGRATIONS_DIR = defaultMigrationsDir();
const MIGRATION_VERSIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.slice(0, 4))
  .sort();

async function withDatabase(run: (pool: pg.Pool, db: TempDatabase) => Promise<void>): Promise<void> {
  const db = await createTempDatabase();
  const pool = new pg.Pool({ connectionString: db.url });
  try {
    await run(pool, db);
  } finally {
    await pool.end().catch(() => undefined);
    await db.drop();
  }
}

describe('数据层与迁移（T01）', () => {
  test('空库迁移后得到全部表、视图与清理函数', async () => {
    await withDatabase(async (pool) => {
      const result = await runMigrations(pool, MIGRATIONS_DIR);
      assert.deepEqual(result.applied, MIGRATION_VERSIONS);

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );
      const names = tables.rows.map((row) => row.table_name);
      for (const expected of ['accounts', 'audit_logs', 'device_codes', 'devices', 'email_tokens', 'sessions']) {
        assert.ok(names.includes(expected), `缺少表 ${expected}，实际: ${names.join(',')}`);
      }

      const view = await pool.query('SELECT * FROM v_active_devices');
      assert.ok(Array.isArray(view.rows));

      const purge = await pool.query('SELECT purge_expired()');
      assert.equal(purge.rowCount, 1);
    });
  });

  test('迁移重复执行幂等，schema_migrations 只记录一次', async () => {
    await withDatabase(async (pool) => {
      const first = await runMigrations(pool, MIGRATIONS_DIR);
      const second = await runMigrations(pool, MIGRATIONS_DIR);

      assert.deepEqual(first.applied, MIGRATION_VERSIONS);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, MIGRATION_VERSIONS);

      const tracked = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
      assert.deepEqual(
        tracked.rows.map((row) => row.version),
        MIGRATION_VERSIONS,
      );
    });
  });

  test('原始 DDL 可重复执行（psql 两次场景）', async () => {
    const db = await createTempDatabase();
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const sql = await readFile(path.join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
      await client.query(sql);
      await client.query(sql);

      const tables = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      assert.ok(Number(tables.rows[0]?.count ?? '0') >= 6);
    } finally {
      await client.end();
      await db.drop();
    }
  });

  test('accounts 支持增删查、citext 大小写不敏感唯一、updated_at 自动刷新', async () => {
    await withDatabase(async (pool) => {
      await runMigrations(pool, MIGRATIONS_DIR);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO accounts (email, password_hash) VALUES ($1, $2) RETURNING id`,
        ['Alice@Example.com', 'argon2id$placeholder'],
      );
      const accountId = inserted.rows[0]?.id;
      assert.ok(accountId);

      const selected = await pool.query<{ email: string }>('SELECT email FROM accounts WHERE email = $1', [
        'alice@example.com',
      ]);
      assert.equal(selected.rowCount, 1);

      await assert.rejects(
        () =>
          pool.query(`INSERT INTO accounts (email, password_hash) VALUES ('ALICE@example.com', 'argon2id$x')`),
        /duplicate key/i,
      );

      // 先把 updated_at 推回过去，再用普通 UPDATE 验证触发器会把它刷新
      await pool.query(`UPDATE accounts SET updated_at = now() - interval '1 day' WHERE id = $1`, [accountId]);
      await pool.query(`UPDATE accounts SET display_name = '爱丽丝' WHERE id = $1`, [accountId]);
      const touched = await pool.query<{ fresh: boolean }>(
        `SELECT updated_at > now() - interval '1 minute' AS fresh FROM accounts WHERE id = $1`,
        [accountId],
      );
      assert.equal(touched.rows[0]?.fresh, true);

      await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
      const remaining = await pool.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
      assert.equal(remaining.rowCount, 0);
    });
  });

  test('v_active_devices 依据 last_seen_at 判定在线', async () => {
    await withDatabase(async (pool) => {
      await runMigrations(pool, MIGRATIONS_DIR);
      const account = await pool.query<{ id: string }>(
        `INSERT INTO accounts (email, password_hash) VALUES ('devices@example.com', 'argon2id$x') RETURNING id`,
      );
      const accountId = account.rows[0]?.id;
      assert.ok(accountId);

      const insertDevice = async (name: string, lastSeen: string | null): Promise<void> => {
        await pool.query(
          `INSERT INTO devices (account_id, kind, name, platform, sign_public_key, ecdh_public_key, last_seen_at)
           VALUES ($1, 'desktop', $2, 'win32', 'sign-key', 'ecdh-key', $3)`,
          [accountId, name, lastSeen],
        );
      };
      await insertDevice('online-pc', new Date().toISOString());
      await insertDevice('offline-pc', new Date(Date.now() - 10 * 60_000).toISOString());

      const rows = await pool.query<{ name: string; online: boolean }>(
        'SELECT name, online FROM v_active_devices WHERE account_id = $1 ORDER BY name',
        [accountId],
      );
      assert.deepEqual(
        rows.rows.map((row) => ({ name: row.name, online: row.online })),
        [
          { name: 'offline-pc', online: false },
          { name: 'online-pc', online: true },
        ],
      );
    });
  });

  test('purge_expired 清理过期设备码与邮箱令牌', async () => {
    await withDatabase(async (pool) => {
      await runMigrations(pool, MIGRATIONS_DIR);
      const account = await pool.query<{ id: string }>(
        `INSERT INTO accounts (email, password_hash) VALUES ('purge@example.com', 'argon2id$x') RETURNING id`,
      );
      const accountId = account.rows[0]?.id;
      assert.ok(accountId);

      await pool.query(
        `INSERT INTO device_codes (device_code, user_code, expires_at)
         VALUES ('expired-code', 'ABCD1234', now() - interval '2 days')`,
      );
      await pool.query(
        `INSERT INTO email_tokens (account_id, purpose, token_hash, expires_at)
         VALUES ($1, 'reset_password', decode('00', 'hex'), now() - interval '2 days')`,
        [accountId],
      );

      await pool.query('SELECT purge_expired()');

      const codes = await pool.query(`SELECT 1 FROM device_codes WHERE device_code = 'expired-code'`);
      assert.equal(codes.rowCount, 0);
      const tokens = await pool.query('SELECT 1 FROM email_tokens WHERE account_id = $1', [accountId]);
      assert.equal(tokens.rowCount, 0);
    });
  });

  test('启动校验：空库判定结构落后，迁移后通过', async () => {
    await withDatabase(async (pool) => {
      const behind = await readSchemaState(pool, MIGRATIONS_DIR);
      assert.equal(behind.ok, false);
      assert.deepEqual(behind.missing, MIGRATION_VERSIONS);

      await assert.rejects(
        () => assertSchemaVersion(pool, MIGRATIONS_DIR),
        (error: unknown) => error instanceof SchemaVersionError && /落后/.test(error.message),
      );

      await runMigrations(pool, MIGRATIONS_DIR);
      const state = await assertSchemaVersion(pool, MIGRATIONS_DIR);
      assert.equal(state.ok, true);
      assert.equal(state.currentVersion, '0003');
    });
  });
});
