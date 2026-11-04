import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeEmail, type AuthService, type RequestContext } from '../auth/service.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { parseRefreshToken } from '../security/tokens.js';
import { type createAuthGuard, requireIdentity } from './auth-guard.js';
import { ApiError } from './errors.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  webLoginSchema,
} from './schemas.js';

export interface AuthRouteDeps {
  auth: AuthService;
  limiter: RateLimiter;
  guard: ReturnType<typeof createAuthGuard>;
}

function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

function enforceLimit(limiter: RateLimiter, key: string, limit: number, windowMs: number): void {
  const decision = limiter.consume(key, limit, windowMs);
  if (!decision.allowed) {
    throw new ApiError(429, 'rate_limit.exceeded', '请求过于频繁，请稍后再试', {
      'Retry-After': String(decision.retryAfterSec),
    });
  }
}

/** 认证相关 7 个端点（规格 §9 / api.md §1、§5）。 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post('/v1/auth/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    enforceLimit(deps.limiter, `register:ip:${request.ip}`, 3, 60 * 60 * 1000);
    const result = await deps.auth.register(body, requestContext(request));
    return reply.code(201).send(result);
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    enforceLimit(deps.limiter, `login:ip:${request.ip}`, 5, 60 * 1000);
    enforceLimit(deps.limiter, `login:account:${normalizeEmail(body.email)}`, 10, 60 * 60 * 1000);
    const result = await deps.auth.login(body, requestContext(request));
    return reply.code(200).send(result);
  });

  // 网页会话登录：只建会话、不登记设备（PC 端账号面板用）。
  // 注意 `/v1/auth/web-login` 已被“手机浏览器登录”占用，这里用独立路径。
  app.post('/v1/auth/panel-login', async (request, reply) => {
    const body = webLoginSchema.parse(request.body);
    enforceLimit(deps.limiter, `login:ip:${request.ip}`, 5, 60 * 1000);
    enforceLimit(deps.limiter, `login:account:${normalizeEmail(body.email)}`, 10, 60 * 60 * 1000);
    const result = await deps.auth.loginWeb(body, requestContext(request));
    return reply.code(200).send(result);
  });

  app.post('/v1/auth/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const parsed = parseRefreshToken(body.refreshToken);
    if (parsed) enforceLimit(deps.limiter, `refresh:session:${parsed.sessionId}`, 60, 60 * 60 * 1000);
    const result = await deps.auth.refresh(body.refreshToken, requestContext(request));
    return reply.code(200).send(result);
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    await deps.auth.logout(body.refreshToken, requestContext(request));
    return reply.code(204).send();
  });

  app.post('/v1/auth/change-password', { preHandler: deps.guard }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    await deps.auth.changePassword(requireIdentity(request), body, requestContext(request));
    return reply.code(204).send();
  });

  app.post('/v1/auth/forgot-password', async (request, reply) => {
    const body = forgotPasswordSchema.parse(request.body);
    await deps.auth.forgotPassword(body.email, requestContext(request));
    // 防用户枚举：邮箱存在与否恒返回 202
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post('/v1/auth/reset-password', async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);
    await deps.auth.resetPassword(body, requestContext(request));
    return reply.code(204).send();
  });
}
