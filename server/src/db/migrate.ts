import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { DbPool } from './pool.js';

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/i;
const MIGRATION_LOCK_KEY = 7_234_100_001;

export interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
}

export interface SchemaState {
  ok: boolean;
  currentVersion: string | null;
  expectedVersion: string | null;
  missing: string[];
  extra: string[];
  reason?: string;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
  currentVersion: string;
}

/** 数据库结构与代码期望的迁移集合不一致。 */
export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/** 读取迁移目录，返回按版本号升序排列的迁移文件。 */
export async function listMigrationFiles(dir: string = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match === null) continue;

    const version = match[1] as string;
    const name = match[2] as string;
    if (seen.has(version)) {
      throw new SchemaVersionError(`迁移目录 ${dir} 中存在重复版本 ${version}`);
    }
    seen.add(version);
    files.push({ version, name, filePath: path.join(dir, entry.name) });
  }

  if (files.length === 0) {
    throw new SchemaVersionError(`迁移目录 ${dir} 中没有迁移文件`);
  }
  files.sort((a, b) => a.version.localeCompare(b.version));
  return files;
}

async function readAppliedVersions(client: PoolClient | DbPool): Promise<string[]> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (exists.rows[0]?.present !== true) return [];

  const applied = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
  return applied.rows.map((row) => row.version);
}

function buildSchemaState(files: MigrationFile[], applied: string[]): SchemaState {
  const expected = files.map((file) => file.version);
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const missing = expected.filter((version) => !appliedSet.has(version));
  const extra = applied.filter((version) => !expectedSet.has(version));
  const currentVersion = applied.length > 0 ? (applied[applied.length - 1] as string) : null;
  const expectedVersion = expected[expected.length - 1] ?? null;

  if (missing.length === 0 && extra.length === 0) {
    return { ok: true, currentVersion, expectedVersion, missing, extra };
  }
  const reason =
    missing.length > 0
      ? `数据库结构落后：缺少迁移 ${missing.join(', ')}，请执行 npm run migrate`
      : `数据库结构超前：存在未知迁移 ${extra.join(', ')}`;
  return { ok: false, currentVersion, expectedVersion, missing, extra, reason };
}

/** 读取当前数据库的结构版本状态，不抛错；供 /healthz 与启动校验共用。 */
export async function readSchemaState(pool: DbPool, dir: string = defaultMigrationsDir()): Promise<SchemaState> {
  const files = await listMigrationFiles(dir);
  const applied = await readAppliedVersions(pool);
  return buildSchemaState(files, applied);
}

/** 启动时校验：数据库必须与代码的迁移集合完全一致，否则抛出 SchemaVersionError。 */
export async function assertSchemaVersion(pool: DbPool, dir: string = defaultMigrationsDir()): Promise<SchemaState> {
  const state = await readSchemaState(pool, dir);
  if (!state.ok) throw new SchemaVersionError(state.reason ?? '数据库结构版本不匹配');
  return state;
}

/**
 * 执行未应用的迁移。
 * - 幂等：已应用的版本跳过，重复调用不会重复执行 DDL
 * - 串行：通过 advisory lock 防止多实例同时迁移
 * - 原子：每个迁移文件在一个事务内执行，失败回滚
 */
export async function runMigrations(
  pool: DbPool,
  dir: string = defaultMigrationsDir(),
): Promise<MigrationRunResult> {
  const files = await listMigrationFiles(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const alreadyApplied = new Set(await readAppliedVersions(client));
    for (const file of files) {
      if (alreadyApplied.has(file.version)) {
        skipped.push(file.version);
        continue;
      }

      const sql = await readFile(file.filePath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          file.version,
          file.name,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`迁移 ${file.version}_${file.name} 执行失败：${(error as Error).message}`, {
          cause: error,
        });
      }
      alreadyApplied.add(file.version);
      applied.push(file.version);
    }

    const state = buildSchemaState(files, [...alreadyApplied].sort());
    if (!state.ok) throw new SchemaVersionError(state.reason ?? '数据库结构版本不匹配');

    return { applied, skipped, currentVersion: state.currentVersion as string };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
