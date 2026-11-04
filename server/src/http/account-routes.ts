import type { FastifyInstance } from 'fastify';
import { findAccountById } from '../auth/repositories/accounts.js';
import type { DbPool } from '../db/pool.js';
import { requireIdentity, type createAuthGuard } from './auth-guard.js';
import { ApiError } from './errors.js';

export interface AccountRouteDeps {
  pool: DbPool;
  guard: ReturnType<typeof createAuthGuard>;
}

export interface AccountUsage {
  desktopDevices: number;
  mobileDevices: number;
}

/** 按 kind 统计未撤销设备数量（api.md §6 usage）。 */
async function countUsage(pool: DbPool, accountId: string): Promise<AccountUsage> {
  const result = await pool.query<{ kind: string; count: string }>(
    `SELECT kind, count(*)::text AS count
       FROM devices
      WHERE account_id = $1 AND revoked_at IS NULL
      GROUP BY kind`,
    [accountId],
  );
  const usage: AccountUsage = { desktopDevices: 0, mobileDevices: 0 };
  for (const row of result.rows) {
    if (row.kind === 'desktop') usage.desktopDevices = Number(row.count);
    if (row.kind === 'mobile') usage.mobileDevices = Number(row.count);
  }
  return usage;
}

/** 账号信息端点（api.md §6）。只返回当前登录账号及其配额用量。 */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  app.get('/v1/account', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const account = await findAccountById(deps.pool, identity.accountId);
    if (!account || account.status === 'deleted') {
      throw new ApiError(401, 'auth.token_invalid', '账号不存在或已注销');
    }
    const usage = await countUsage(deps.pool, identity.accountId);
    return reply.code(200).send({
      account: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
        emailVerified: account.email_verified,
        createdAt: account.created_at.toISOString(),
        limits: {
          desktopDevices: account.desktop_device_limit,
          mobileDevices: account.mobile_device_limit,
        },
      },
      usage,
    });
  });
}
