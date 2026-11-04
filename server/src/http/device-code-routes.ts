import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../config.js';
import type { DeviceCodeService, RequestContext } from '../auth/device-code.js';
import { ApiError } from './errors.js';
import { type createAuthGuard, requireIdentity } from './auth-guard.js';
import { approveDeviceCodeSchema, requestDeviceCodeSchema, deviceTokenSchema } from './device-code-schemas.js';

export interface DeviceCodeRouteDeps {
  deviceCode: DeviceCodeService;
  guard: ReturnType<typeof createAuthGuard>;
  config: AuthConfig;
}

function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

const ACTIVATE_HTML = readFileSync(new URL('../../public/activate.html', import.meta.url), 'utf8');

/** 设备码授权流程（api.md §1.5–1.7）+ 最小确认页。 */
export function registerDeviceCodeRoutes(app: FastifyInstance, deps: DeviceCodeRouteDeps): void {
  app.get('/activate', async (_request, reply) => {
    return reply.code(200).type('text/html; charset=utf-8').send(ACTIVATE_HTML);
  });

  app.post('/v1/auth/device-code', async (request, reply) => {
    const body = requestDeviceCodeSchema.parse(request.body);
    const result = await deps.deviceCode.request(body, requestContext(request));
    return reply.code(200).send(result);
  });

  app.post('/v1/auth/device-token', async (request, reply) => {
    const body = deviceTokenSchema.parse(request.body);
    try {
      const result = await deps.deviceCode.pollToken(body.deviceCode, requestContext(request));
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 202) {
        // 202 同时给出状态与规格错误码（api.md §1.6 + §7）
        return reply.code(202).send({
          status: 'pending',
          error: { code: error.code, message: error.message, requestId: request.id },
        });
      }
      throw error;
    }
  });

  app.post('/v1/auth/device-code/approve', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const body = approveDeviceCodeSchema.parse(request.body);
    const result = await deps.deviceCode.approve(
      body.userCode,
      body.decision,
      identity.accountId,
      requestContext(request),
    );
    return reply.code(200).send(result);
  });
}
