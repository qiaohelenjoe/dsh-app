import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceService, RequestContext } from '../devices/service.js';
import type { createAuthGuard } from './auth-guard.js';
import { requireIdentity } from './auth-guard.js';
import { deviceIdParamsSchema, registerDeviceSchema, renameDeviceSchema } from './device-schemas.js';

export interface DeviceRouteDeps {
  devices: DeviceService;
  guard: ReturnType<typeof createAuthGuard>;
}

function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

/** 设备生命周期四操作（api.md §2）。全部要求登录态。 */
export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceRouteDeps): void {
  app.get('/v1/devices', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const devices = await deps.devices.list(identity.accountId);
    return reply.code(200).send({ devices });
  });

  app.post('/v1/devices', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const body = registerDeviceSchema.parse(request.body);
    const device = await deps.devices.register(identity.accountId, body, requestContext(request));
    return reply.code(201).send({ device });
  });

  app.patch('/v1/devices/:id', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = deviceIdParamsSchema.parse(request.params);
    const body = renameDeviceSchema.parse(request.body);
    const device = await deps.devices.rename(identity.accountId, id, body.name);
    return reply.code(200).send({ device });
  });

  app.delete('/v1/devices/:id', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = deviceIdParamsSchema.parse(request.params);
    await deps.devices.revoke(identity.accountId, id, requestContext(request));
    return reply.code(204).send();
  });
}
