import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/service.js';
import type { DeviceService, RequestContext } from '../devices/service.js';
import type { createAuthGuard } from './auth-guard.js';
import { requireIdentity } from './auth-guard.js';
import { deviceIdParamsSchema, machineNameSchema, registerDeviceSchema, renameDeviceSchema } from './device-schemas.js';
import { ApiError } from './errors.js';

export interface DeviceRouteDeps {
  devices: DeviceService;
  guard: ReturnType<typeof createAuthGuard>;
  auth: AuthService;
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

  /**
   * 老设备补码：已用设备会话连上来的设备，上报自己的计算机名称（只补不覆盖）。
   * 网页会话没有 deviceId，返回 403。
   */
  app.post('/v1/devices/self/machine-code', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    if (!identity.deviceId) throw new ApiError(403, 'authz.forbidden', '该会话未绑定设备');
    const body = machineNameSchema.parse(request.body);
    const device = await deps.devices.bindOwnMachineName(identity.deviceId, identity.accountId, body.machineName);
    return reply.code(200).send({ device });
  });

  /**
   * 一次性认领历史设备：把"从没记过计算机名称"的旧设备认成当前这台机器。
   * 只写机器码，不新建设备、不消耗名额；设备归属由服务端校验。
   */
  app.post('/v1/devices/:id/claim', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = deviceIdParamsSchema.parse(request.params);
    const body = machineNameSchema.parse(request.body);
    const device = await deps.devices.claimMachineCode(identity.accountId, id, body.machineName, requestContext(request));
    return reply.code(200).send({ device });
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

  /**
   * 用账号会话为本账号的一台设备换取设备会话（面板登录后建立隧道用）。
   * 校验设备归属，签发只绑定该设备的新会话；网页会话本身权限不外溢。
   */
  app.post('/v1/devices/:id/session', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = deviceIdParamsSchema.parse(request.params);
    const result = await deps.auth.issueDeviceSession(identity, id, requestContext(request));
    return reply.code(200).send(result);
  });
}
