import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DbPool } from '../db/pool.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { requireIdentity, type createAuthGuard } from './auth-guard.js';
import { ApiError } from './errors.js';

export interface ClientLogRouteDeps {
  pool: DbPool;
  guard: ReturnType<typeof createAuthGuard>;
  limiter: RateLimiter;
}

const ENTRY_MAX = 100;
const MESSAGE_MAX = 2048;
const CONTEXT_MAX = 4096;

const entrySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  event: z.string().max(64).optional(),
  message: z.string().min(1).max(MESSAGE_MAX),
  requestId: z.string().max(128).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const bodySchema = z.object({
  appVersion: z.string().max(64).optional(),
  platform: z.string().max(32).optional(),
  entries: z.array(entrySchema).min(1).max(ENTRY_MAX),
});

const SENSITIVE_KEY = /token|cookie|authorization|password|secret|signkey|ecdh|private/i;

/** 去掉 URL 中可能携带的 token/access_token 查询参数。 */
export function redactText(value: string): string {
  return value
    .replace(/([?&](?:token|access_token|refresh_token|cookie|password)=)[^&\s]*/gi, '$1***')
    .replace(/\b(token|cookie|authorization|password|secret)\s*[:=]\s*\S+/gi, '$1=***')
    .slice(0, MESSAGE_MAX);
}

/** 只保留浅层、无敏感键的 JSON，字符串截断，整体不超过 CONTEXT_MAX。 */
export function sanitizeContext(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
    } else if (typeof value === 'string') {
      output[key] = redactText(value).slice(0, 512);
    } else if (Array.isArray(value)) {
      output[key] = value
        .slice(0, 20)
        .map((item) => (typeof item === 'string' ? redactText(item).slice(0, 512) : typeof item === 'number' ? item : null));
    } else if (typeof value === 'object') {
      const nested: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(childKey)) continue;
        if (typeof childValue === 'string') nested[childKey] = redactText(childValue).slice(0, 512);
        else if (childValue === null || typeof childValue === 'number' || typeof childValue === 'boolean') nested[childKey] = childValue;
      }
      output[key] = nested;
    }
  }
  let serialized = JSON.stringify(output);
  if (serialized.length <= CONTEXT_MAX) return output;
  serialized = serialized.slice(0, CONTEXT_MAX);
  return { truncated: true, preview: serialized };
}

export function registerClientLogRoutes(app: FastifyInstance, deps: ClientLogRouteDeps): void {
  app.post('/v1/client-logs', { preHandler: deps.guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const decision = deps.limiter.consume(`client-logs:${identity.accountId}`, 120, 60_000);
    if (!decision.allowed) {
      throw new ApiError(429, 'rate_limit.exceeded', '日志上报过于频繁，请稍后再试', {
        'Retry-After': String(decision.retryAfterSec),
      });
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, 'validation.failed', '日志格式不正确');
    }
    const { appVersion, platform, entries } = parsed.data;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    entries.forEach((entry, index) => {
      const base = index * 9;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9})`,
      );
      values.push(
        identity.accountId,
        identity.deviceId,
        appVersion ?? null,
        platform ?? null,
        entry.level,
        entry.event ?? null,
        redactText(entry.message),
        JSON.stringify(sanitizeContext(entry.context)),
        entry.requestId ?? null,
      );
    });

    await deps.pool.query(
      `INSERT INTO client_logs
         (account_id, device_id, app_version, platform, level, event, message, context, request_id)
       VALUES ${placeholders.join(', ')}`,
      values,
    );

    return reply.code(202).send({ accepted: entries.length });
  });
}
