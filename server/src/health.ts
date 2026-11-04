import type { FastifyInstance } from 'fastify';
import { readSchemaState } from './db/migrate.js';
import type { DbPool } from './db/pool.js';

export interface HealthDeps {
  pool: DbPool;
  migrationsDir: string;
}

interface HealthBody {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  schemaVersion?: string | null;
  expectedVersion?: string | null;
  reason?: string;
}

/**
 * GET /healthz
 * - 数据库可连且结构版本与代码一致：200
 * - 数据库不可连：503，reason 为连接错误
 * - 数据库可连但结构版本不一致：503，reason 说明落后/超前
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
    } catch (error) {
      const body: HealthBody = {
        status: 'error',
        db: 'down',
        reason: `数据库连接失败：${(error as Error).message}`,
      };
      return reply.code(503).send(body);
    }

    try {
      const state = await readSchemaState(deps.pool, deps.migrationsDir);
      if (!state.ok) {
        const body: HealthBody = {
          status: 'error',
          db: 'up',
          schemaVersion: state.currentVersion,
          expectedVersion: state.expectedVersion,
          reason: state.reason ?? '数据库结构版本不匹配',
        };
        return reply.code(503).send(body);
      }
      const body: HealthBody = {
        status: 'ok',
        db: 'up',
        schemaVersion: state.currentVersion,
        expectedVersion: state.expectedVersion,
      };
      return reply.code(200).send(body);
    } catch (error) {
      const body: HealthBody = {
        status: 'error',
        db: 'up',
        reason: `结构版本检查失败：${(error as Error).message}`,
      };
      return reply.code(503).send(body);
    }
  });
}
