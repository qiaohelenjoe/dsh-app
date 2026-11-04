import type { DbPool } from '../../db/pool.js';

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export interface CreateEmailTokenInput {
  accountId: string;
  purpose: EmailTokenPurpose;
  tokenHash: Buffer;
  expiresAt: Date;
}

/** 同一账号同一用途只保留最新一个未消费令牌。 */
export async function createEmailToken(pool: DbPool, input: CreateEmailTokenInput): Promise<void> {
  await pool.query(
    `UPDATE email_tokens SET consumed_at = now()
      WHERE account_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [input.accountId, input.purpose],
  );
  await pool.query(
    `INSERT INTO email_tokens (account_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [input.accountId, input.purpose, input.tokenHash, input.expiresAt],
  );
}

/** 原子消费一次性令牌：未过期且未消费才成功。 */
export async function consumeEmailToken(
  pool: DbPool,
  tokenHash: Buffer,
  purpose: EmailTokenPurpose,
): Promise<{ accountId: string } | null> {
  const result = await pool.query<{ account_id: string }>(
    `UPDATE email_tokens SET consumed_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING account_id`,
    [tokenHash, purpose],
  );
  const row = result.rows[0];
  return row ? { accountId: row.account_id } : null;
}
