import type { DbPool } from '../db/pool.js';
import { PENDING_DEVICE_KEY, type DeviceKind } from './types.js';

export interface DeviceRow {
  id: string;
  account_id: string;
  kind: DeviceKind;
  name: string;
  platform: string;
  sign_public_key: string;
  ecdh_public_key: string;
  app_version: string | null;
  last_seen_at: Date | null;
  last_ip: string | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  online: boolean;
}

const DEVICE_COLUMNS = `
  d.id, d.account_id, d.kind, d.name, d.platform,
  d.sign_public_key, d.ecdh_public_key, d.app_version,
  d.last_seen_at, d.last_ip, d.revoked_at, d.created_at, d.updated_at,
  (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '90 seconds') AS online
`;

export class DeviceNameTakenError extends Error {
  constructor() {
    super('device name taken');
    this.name = 'DeviceNameTakenError';
  }
}

export async function listAliveDevices(pool: DbPool, accountId: string): Promise<DeviceRow[]> {
  const result = await pool.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS}
       FROM devices d
      WHERE d.account_id = $1 AND d.revoked_at IS NULL
      ORDER BY online DESC, d.last_seen_at DESC NULLS LAST, d.created_at DESC`,
    [accountId],
  );
  return result.rows;
}

export async function findDeviceById(pool: DbPool, deviceId: string): Promise<DeviceRow | null> {
  const result = await pool.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM devices d WHERE d.id = $1 LIMIT 1`,
    [deviceId],
  );
  return result.rows[0] ?? null;
}

export async function countAliveDevices(pool: DbPool, accountId: string, kind: DeviceKind): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM devices
      WHERE account_id = $1 AND kind = $2 AND revoked_at IS NULL`,
    [accountId, kind],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export interface InsertDeviceInput {
  accountId: string;
  kind: DeviceKind;
  name: string;
  platform: string;
  appVersion: string | null;
  signPublicKey: string;
  ecdhPublicKey: string;
  ip: string | null;
}

export async function insertDevice(pool: DbPool, input: InsertDeviceInput): Promise<DeviceRow> {
  try {
    const result = await pool.query<DeviceRow>(
      `INSERT INTO devices
         (account_id, kind, name, platform, sign_public_key, ecdh_public_key, app_version, last_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *, false AS online`,
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
    return result.rows[0] as DeviceRow;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new DeviceNameTakenError();
    throw error;
  }
}

export interface UpgradePendingDeviceInput {
  accountId: string;
  kind: DeviceKind;
  name: string;
  platform: string;
  appVersion: string | null;
  signPublicKey: string;
  ecdhPublicKey: string;
  ip: string | null;
}

/**
 * 设备码流程创建的占位设备（公钥为 PENDING_DEVICE_KEY）在插件登记真实公钥时升级。
 * 返回 null 表示不存在占位设备（走正常新建/同名冲突路径）。
 */
export async function upgradePendingDevice(
  pool: DbPool,
  input: UpgradePendingDeviceInput,
): Promise<DeviceRow | null> {
  const result = await pool.query<DeviceRow>(
    `UPDATE devices d
        SET sign_public_key = $5,
            ecdh_public_key = $6,
            app_version = COALESCE($7, d.app_version),
            last_seen_at = now(),
            last_ip = $8
      WHERE d.account_id = $1 AND d.kind = $2 AND d.platform = $3 AND d.name = $4
        AND d.revoked_at IS NULL AND d.sign_public_key = $9
      RETURNING d.*, (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '90 seconds') AS online`,
    [
      input.accountId,
      input.kind,
      input.platform,
      input.name,
      input.signPublicKey,
      input.ecdhPublicKey,
      input.appVersion,
      input.ip,
      PENDING_DEVICE_KEY,
    ],
  );
  return result.rows[0] ?? null;
}

export async function renameDevice(pool: DbPool, deviceId: string, name: string): Promise<DeviceRow | null> {  try {
    const result = await pool.query<DeviceRow>(
      `UPDATE devices d SET name = $2
        WHERE d.id = $1 AND d.revoked_at IS NULL
        RETURNING d.*, (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '90 seconds') AS online`,
      [deviceId, name],
    );
    return result.rows[0] ?? null;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new DeviceNameTakenError();
    throw error;
  }
}

export interface RevokeDeviceInput {
  accountId: string;
  deviceId: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * 撤销设备（单事务）：设备软删 → 该设备全部会话撤销 → 写 device.revoke 审计。
 * 返回被撤销的设备行；设备不存在或已撤销返回 null。
 */
export async function revokeDevice(pool: DbPool, input: RevokeDeviceInput): Promise<DeviceRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const revoked = await client.query<DeviceRow>(
      `UPDATE devices
          SET revoked_at = now()
        WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
        RETURNING *, false AS online`,
      [input.deviceId, input.accountId],
    );
    const device = revoked.rows[0];
    if (!device) {
      await client.query('ROLLBACK');
      return null;
    }

    const sessions = await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE device_id = $1 AND revoked_at IS NULL`,
      [input.deviceId],
    );

    await client.query(
      `INSERT INTO audit_logs (account_id, device_id, action, result, ip, user_agent, detail)
       VALUES ($1, $2, 'device.revoke', 'ok', $3, $4, $5::jsonb)`,
      [
        input.accountId,
        input.deviceId,
        input.ip,
        input.userAgent,
        JSON.stringify({ revokedSessions: sessions.rowCount ?? 0 }),
      ],
    );

    await client.query('COMMIT');
    return device;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
