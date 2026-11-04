import type { FastifyReply, FastifyRequest } from 'fastify';
import { findAccountById } from '../auth/repositories/accounts.js';
import { findSessionById } from '../auth/repositories/sessions.js';
import type { AuthenticatedIdentity } from '../auth/service.js';
import type { DbPool } from '../db/pool.js';
import { AccessTokenExpiredError, verifyAccessToken } from '../security/tokens.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedIdentity | null;
  }
}

export interface AuthGuardDeps {
  pool: DbPool;
  jwtSecret: string;
}

/** Bearer access token 校验：JWT → 会话仍有效 → 账号未停用。 */
export function createAuthGuard(deps: AuthGuardDeps) {
  return async function authGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw new ApiError(401, 'auth.token_invalid', '缺少访问令牌');

    let claims;
    try {
      claims = await verifyAccessToken(token, deps.jwtSecret);
    } catch (error) {
      if (error instanceof AccessTokenExpiredError) {
        throw new ApiError(401, 'auth.token_expired', '访问令牌已过期');
      }
      throw new ApiError(401, 'auth.token_invalid', '访问令牌无效');
    }

    const session = await findSessionById(deps.pool, claims.sessionId);
    if (!session || session.account_id !== claims.accountId || session.revoked_at !== null) {
      throw new ApiError(401, 'auth.token_invalid', '会话已失效，请重新登录');
    }
    if (session.expires_at.getTime() <= Date.now()) {
      throw new ApiError(401, 'auth.token_expired', '会话已过期，请重新登录');
    }

    const account = await findAccountById(deps.pool, claims.accountId);
    if (!account || account.status !== 'active') {
      throw new ApiError(403, 'authz.account_suspended', '账号已停用');
    }

    request.auth = {
      accountId: claims.accountId,
      sessionId: claims.sessionId,
      deviceId: session.device_id,
    };
  };
}

export function requireIdentity(request: FastifyRequest): AuthenticatedIdentity {
  if (!request.auth) throw new ApiError(401, 'auth.token_invalid', '缺少访问令牌');
  return request.auth;
}
