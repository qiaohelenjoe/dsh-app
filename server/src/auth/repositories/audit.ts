import type { DbPool } from '../../db/pool.js';

export type AuditResult = 'ok' | 'denied' | 'error';

export interface AuditEntry {
  accountId?: string | null;
  deviceId?: string | null;
  action: string;
  result: AuditResult;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
}

export async function writeAudit(pool: DbPool, entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (account_id, device_id, action, result, ip, user_agent, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      entry.accountId ?? null,
      entry.deviceId ?? null,
      entry.action,
      entry.result,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
