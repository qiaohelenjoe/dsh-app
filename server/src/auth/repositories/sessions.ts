import type { DbPool } from '../../db/pool.js';

export interface SessionRow {
  id: string;
  account_id: string;
  /** 网页会话（PC 账号面板）不绑定设备，因此可空。 */
  device_id: string | null;
  refresh_token_hash: Buffer;
  expires_at: Date;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
}

export interface CreateSessionInput {
  id: string;
  accountId: string;
  deviceId: string | null;
  refreshTokenHash: Buffer;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export async function createSession(pool: DbPool, input: CreateSessionInput): Promise<SessionRow> {
  const result = await pool.query<SessionRow>(
    `INSERT INTO sessions (id, account_id, device_id, refresh_token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.id,
      input.accountId,
      input.deviceId,
      input.refreshTokenHash,
      input.expiresAt,
      input.ip,
      input.userAgent,
    ],
  );
  return result.rows[0] as SessionRow;
}

export async function findSessionById(pool: DbPool, sessionId: string): Promise<SessionRow | null> {
  const result = await pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 LIMIT 1', [sessionId]);
  return result.rows[0] ?? null;
}

export async function markSessionUsed(pool: DbPool, sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [sessionId]);
}

/** 轮换 refresh 哈希；仅当会话仍有效时成功。 */
export async function rotateSessionRefresh(
  pool: DbPool,
  sessionId: string,
  newRefreshHash: Buffer,
  newExpiresAt: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions
        SET refresh_token_hash = $2, expires_at = $3, last_used_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id`,
    [sessionId, newRefreshHash, newExpiresAt],
  );
  return result.rowCount === 1;
}

export async function revokeSession(pool: DbPool, sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

/** 改密：除当前会话外全部撤销。 */
export async function revokeOtherSessions(
  pool: DbPool,
  accountId: string,
  keepSessionId: string,
): Promise<number> {
  const result = await pool.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE account_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [accountId, keepSessionId],
  );
  return result.rowCount ?? 0;
}

/** 重置密码：撤销该账号全部会话。 */
export async function revokeAllSessions(pool: DbPool, accountId: string): Promise<number> {
  const result = await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL',
    [accountId],
  );
  return result.rowCount ?? 0;
}
