import type { DbPool } from '../db/pool.js';

export interface TunnelDeviceRow {
  id: string;
  account_id: string;
  revoked_at: Date | null;
}

export async function findDeviceForTunnel(pool: DbPool, deviceId: string): Promise<TunnelDeviceRow | null> {
  const result = await pool.query<TunnelDeviceRow>(
    'SELECT id, account_id, revoked_at FROM devices WHERE id = $1 LIMIT 1',
    [deviceId],
  );
  return result.rows[0] ?? null;
}

export async function markDeviceSeen(pool: DbPool, deviceId: string, remoteAddress: string | null): Promise<void> {
  await pool.query('UPDATE devices SET last_seen_at = now(), last_ip = $2 WHERE id = $1', [deviceId, remoteAddress]);
}

/** 断连/心跳超时后立刻视为离线（在线判定窗口 90 秒，这里直接推到窗口外）。 */
export async function markDeviceOffline(pool: DbPool, deviceId: string): Promise<void> {
  await pool.query(
    `UPDATE devices SET last_seen_at = now() - interval '2 minutes'
      WHERE id = $1 AND revoked_at IS NULL`,
    [deviceId],
  );
}

export interface TunnelAuditEntry {
  accountId: string | null;
  deviceId: string;
  action: string;
  result: 'ok' | 'denied' | 'error';
  detail?: Record<string, unknown>;
}

export async function auditTunnelEvent(pool: DbPool, entry: TunnelAuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (account_id, device_id, action, result, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [entry.accountId, entry.deviceId, entry.action, entry.result, JSON.stringify(entry.detail ?? {})],
  );
}

export async function auditTunnelDenied(
  pool: DbPool,
  entry: { accountId: string | null; deviceId: string; detail: Record<string, unknown> },
): Promise<void> {
  await auditTunnelEvent(pool, {
    accountId: entry.accountId,
    deviceId: entry.deviceId,
    action: 'tunnel.path_denied',
    result: 'denied',
    detail: entry.detail,
  });
}
