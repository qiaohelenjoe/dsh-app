import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbPool } from '../db/pool.js';
import { findDeviceById } from '../devices/repositories.js';
import type { TunnelRegistry } from '../tunnel/registry.js';
import { requireIdentity, type createAuthGuard } from './auth-guard.js';
import { ApiError } from './errors.js';

export interface TunnelTicketRouteDeps {
  registry: TunnelRegistry;
  guard: ReturnType<typeof createAuthGuard>;
  pool: DbPool;
}

const ticketBodySchema = z
  .object({ deviceId: z.string().min(1).optional() })
  .nullish();

/**
 * `POST /v1/tunnel/ticket`（Bearer access token）签发一次性隧道票据（规格 §11 / R06）。
 * 票据绑定 accountId + sessionId + deviceId，默认 60 秒有效、消费即失效。
 *
 * 两种会话：
 * - 设备会话（device-code 登录）：票据绑定会话自身的设备，行为不变；
 * - 网页会话（面板登录，无设备）：允许在请求体里带 `deviceId`，校验设备属于本账号后签发票据。
 *   这样「面板登录后自动登记本机」也能建立隧道，而网页会话本身仍未获得超出账号范围的能力。
 */
export function registerTunnelTicketRoutes(app: FastifyInstance, deps: TunnelTicketRouteDeps): void {
  app.post('/v1/tunnel/ticket', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const parsed = ticketBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'invalid.body', '请求体非法');
    }
    const requestedDeviceId = parsed.data?.deviceId;
    let deviceId = identity.deviceId;

    if (deviceId) {
      if (requestedDeviceId && requestedDeviceId !== deviceId) {
        throw new ApiError(403, 'authz.forbidden', '会话绑定的设备与请求的设备不一致');
      }
    } else {
      if (!requestedDeviceId) {
        throw new ApiError(403, 'authz.forbidden', '网页会话签发隧道票据需要 deviceId');
      }
      const device = await findDeviceById(deps.pool, requestedDeviceId);
      if (!device || device.account_id !== identity.accountId || device.revoked_at !== null) {
        throw new ApiError(403, 'authz.forbidden', '设备不属于当前账号');
      }
      deviceId = requestedDeviceId;
    }

    const issued = deps.registry.issueTunnelTicket({ ...identity, deviceId });
    return reply.code(200).send(issued);
  });
}
