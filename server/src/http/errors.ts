import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** 统一 API 错误：状态码 + 规格 §13 错误码 + 可选响应头（如 Retry-After）。 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export function apiErrorBody(code: string, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, requestId } };
}

/** 统一错误体（api.md §0.1）与 zod 校验错误映射（400 request.invalid）。 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.headers) {
        for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      }
      return reply.code(error.statusCode).send(apiErrorBody(error.code, error.message, request.id));
    }

    if (error instanceof ZodError) {
      const detail = error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return reply.code(400).send(apiErrorBody('request.invalid', `参数校验失败：${detail}`, request.id));
    }

    if (error.statusCode === 413) {
      return reply.code(413).send(apiErrorBody('request.too_large', '请求体过大', request.id));
    }

    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send(apiErrorBody('request.invalid', error.message, request.id));
    }

    request.log.error({ err: error }, '未处理的服务端错误');
    return reply.code(500).send(apiErrorBody('internal.error', '服务端内部错误', request.id));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(apiErrorBody('not_found.route', '接口不存在', request.id)),
  );
}
