import type { DbPool } from '../../db/pool.js';
import { ApiError } from '../../http/errors.js';

export interface DeviceRow {
  id: string;
  account_id: string;
  kind: 'desktop' | 'mobile';
  name: string;
  platform: string;
  sign_public_key: string;
  ecdh_public_key: string;
  app_version: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

export interface EnsureLoginDeviceInput {
  accountId: string;
  kind: 'desktop' | 'mobile';
  name: string;
  platform: string;
  appVersion: string | null;
  signPublicKey: string;
  ecdhPublicKey: string;
  ip: string | null;
}

async function selectAliveDevice(
  pool: DbPool,
  accountId: string,
  kind: string,
  platform: string,
  name: string,
): Promise<DeviceRow | null> {
  const result = await pool.query<DeviceRow>(
    `SELECT * FROM devices
      WHERE account_id = $1 AND kind = $2 AND platform = $3 AND name = $4 AND revoked_at IS NULL
      LIMIT 1`,
    [accountId, kind, platform, name],
  );
  return result.rows[0] ?? null;
}

/**
 * 登录时登记设备（api.md §1.2）：同名同平台复用已有设备并刷新公钥/最后上线时间，
 * 否则新建设备。完整设备 CRUD 属于 T03。
 */
export async function ensureLoginDevice(pool: DbPool, input: EnsureLoginDeviceInput): Promise<DeviceRow> {
  const existing = await selectAliveDevice(pool, input.accountId, input.kind, input.platform, input.name);
  if (existing) {
    const updated = await pool.query<DeviceRow>(
      `UPDATE devices
          SET sign_public_key = $2,
              ecdh_public_key = $3,
              app_version = COALESCE($4, app_version),
              last_seen_at = now(),
              last_ip = $5
        WHERE id = $1
        RETURNING *`,
      [existing.id, input.signPublicKey, input.ecdhPublicKey, input.appVersion, input.ip],
    );
    return updated.rows[0] as DeviceRow;
  }

  // 登录/网页登录可能创建新设备：按账号配额校验，避免绕过 devices/register 的限制
  const limits = await pool.query<{ desktop_device_limit: number; mobile_device_limit: number }>(
    'SELECT desktop_device_limit, mobile_device_limit FROM accounts WHERE id = $1',
    [input.accountId],
  );
  const accountLimits = limits.rows[0];
  const limit = input.kind === 'desktop'
    ? (accountLimits?.desktop_device_limit ?? 2)
    : (accountLimits?.mobile_device_limit ?? 3);
  const counted = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM devices WHERE account_id = $1 AND kind = $2 AND revoked_at IS NULL',
    [input.accountId, input.kind],
  );
  if (Number(counted.rows[0]?.count ?? '0') >= limit) {
    throw new ApiError(403, 'authz.device_quota_exceeded', `设备数量已达上限（${limit} 台）`);
  }

  try {
    const inserted = await pool.query<DeviceRow>(
      `INSERT INTO devices
         (account_id, kind, name, platform, sign_public_key, ecdh_public_key, app_version, last_seen_at, last_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       RETURNING *`,
      [
        input.accountId,
        input.kind,
        input.name,
        input.platform,
        input.signPublicKey,
        input.ecdhPublicKey,
        input.appVersion,
        input.ip,
      ],
    );
    return inserted.rows[0] as DeviceRow;
  } catch (error) {
    // 并发下同名设备唯一索引冲突：回退到复用
    if ((error as { code?: string }).code === '23505') {
      const raced = await selectAliveDevice(pool, input.accountId, input.kind, input.platform, input.name);
      if (raced) return raced;
    }
    throw error;
  }
}
