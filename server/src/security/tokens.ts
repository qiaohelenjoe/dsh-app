import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

export class AccessTokenExpiredError extends Error {
  constructor() {
    super('access token expired');
    this.name = 'AccessTokenExpiredError';
  }
}

export class AccessTokenInvalidError extends Error {
  constructor() {
    super('access token invalid');
    this.name = 'AccessTokenInvalidError';
  }
}

export interface AccessTokenClaims {
  accountId: string;
  sessionId: string;
}

const encoder = new TextEncoder();

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.accountId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(encoder.encode(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, encoder.encode(secret), { algorithms: ['HS256'] });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw new AccessTokenExpiredError();
    throw new AccessTokenInvalidError();
  }

  const accountId = payload['sub'];
  const sessionId = payload['sid'];
  if (typeof accountId !== 'string' || typeof sessionId !== 'string') {
    throw new AccessTokenInvalidError();
  }
  return { accountId, sessionId };
}

export interface ParsedRefreshToken {
  sessionId: string;
  secret: string;
}

const REFRESH_TOKEN_PATTERN = /^rt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/;

/** 生成 refresh token：`rt_<sessionId>_<secret>`，sessionId 用于服务端定位会话并检测复用。 */
export function generateRefreshToken(sessionId: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `rt_${sessionId}_${secret}`, secret };
}

export function parseRefreshToken(token: string): ParsedRefreshToken | null {
  const match = REFRESH_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  return { sessionId: match[1] as string, secret: match[2] as string };
}

/** refresh token 只存 SHA-256(secret + pepper) 的二进制哈希。 */
export function hashRefreshSecret(secret: string, pepper: string): Buffer {
  return createHash('sha256').update(`${secret}${pepper}`, 'utf8').digest();
}

export function hashOpaqueToken(token: string, pepper: string): Buffer {
  return createHash('sha256').update(`${token}${pepper}`, 'utf8').digest();
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function randomUuid(): string {
  return crypto.randomUUID();
}

export function buffersEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function refreshTokenExpiry(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
