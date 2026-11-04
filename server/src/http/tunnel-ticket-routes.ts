import type { FastifyInstance } from 'fastify';
import type { TunnelRegistry } from '../tunnel/registry.js';
import { requireIdentity, type createAuthGuard } from './auth-guard.js';
import { ApiError } from './errors.js';

export interface TunnelTicketRouteDeps {
  registry: TunnelRegistry;
  guard: ReturnType<typeof createAuthGuard>;
}

/**
 * `POST /v1/tunnel/ticket`（Bearer access token）签发一次性隧道票据（规格 §11 / R06）。
 * 票据绑定 accountId + sessionId + deviceId，默认 60 秒有效、消费即失效。
 * 网页会话没有设备，不能申请隧道票据。
 */
export function registerTunnelTicketRoutes(app: FastifyInstance, deps: TunnelTicketRouteDeps): void {
  app.post('/v1/tunnel/ticket', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    if (!identity.deviceId) {
      throw new ApiError(403, 'authz.forbidden', '网页会话不能签发隧道票据');
    }
    const issued = deps.registry.issueTunnelTicket({ ...identity, deviceId: identity.deviceId });
    return reply.code(200).send(issued);
  });
}
