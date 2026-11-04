import { randomBytes } from 'node:crypto';
import type { AuthConfig } from '../config.js';
import type { DbPool } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { hashRefreshSecret, randomUuid, refreshTokenExpiry, signAccessToken } from '../security/tokens.js';
import { findAccountById, type AccountRow } from './repositories/accounts.js';
import { writeAudit } from './repositories/audit.js';
import { createSession } from './repositories/sessions.js';
import { inferDeviceKind, PENDING_DEVICE_KEY } from '../devices/types.js';

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;

export interface DeviceCodeRow {
  id: string;
  device_code: string;
  user_code: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  account_id: string | null;
  device_name: string | null;
  platform: string | null;
  expires_at: Date;
  created_at: Date;
  approved_at: Date | null;
  consumed_at: Date | null;
  ip: string | null;
}

export interface DeviceCodeRequestInput {
  deviceName: string;
  platform: string;
}

export interface DeviceTokenResult {
  account: { id: string; email: string; displayName: string | null; emailVerified: boolean };
  device: { id: string; name: string; kind: string; platform: string };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomUserCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += USER_CODE_ALPHABET[(bytes[index] as number) % USER_CODE_ALPHABET.length];
    if (index === 3) code += '-';
  }
  return code;
}

function normalizeUserCode(input: string): string {
  const compact = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : input.trim().toUpperCase();
}

export class DeviceCodeService {
  /** deviceCode → 上次轮询时间，用于轮询间隔限速（单实例内存）。 */
  private readonly lastPollAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      pool: DbPool;
      config: AuthConfig;
    },
  ) {}

  private get pool(): DbPool {
    return this.deps.pool;
  }

  /** 申请设备码：同来源的同名设备旧 pending 码立即失效（userCode 唯一 pending）。 */
  async request(input: DeviceCodeRequestInput, context: RequestContext): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  }> {
    await this.pool.query(
      `UPDATE device_codes SET status = 'expired'
        WHERE status = 'pending' AND device_name = $1 AND platform = $2
          AND ip IS NOT DISTINCT FROM $3::inet`,
      [input.deviceName, input.platform, context.ip],
    );

    const deviceCode = `dc_${randomBytes(24).toString('base64url')}`;
    let userCode = randomUserCode();
    const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.pool.query(
          `INSERT INTO device_codes (device_code, user_code, device_name, platform, expires_at, ip)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [deviceCode, userCode, input.deviceName, input.platform, expiresAt, context.ip],
        );
        return {
          deviceCode,
          userCode,
          verificationUrl: `${this.deps.config.publicBaseUrl}/activate`,
          expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
          interval: this.deps.config.deviceCodePollIntervalSeconds,
        };
      } catch (error) {
        // 极小概率 userCode 与现有 pending 冲突：换一个重试
        if ((error as { code?: string }).code === '23505') {
          userCode = randomUserCode();
          continue;
        }
        throw error;
      }
    }
    throw new ApiError(500, 'internal.error', '生成设备码失败，请重试');
  }

  /** 网页端确认/拒绝设备码（需要登录态）。 */
  async approve(
    userCodeInput: string,
    decision: 'approve' | 'deny',
    accountId: string,
    context: RequestContext,
  ): Promise<{ status: 'approved' | 'denied' }> {
    const userCode = normalizeUserCode(userCodeInput);
    const { rows } = await this.pool.query<DeviceCodeRow>(
      `SELECT * FROM device_codes WHERE user_code = $1 AND status = 'pending' LIMIT 1`,
      [userCode],
    );
    const row = rows[0];
    if (!row) throw new ApiError(400, 'request.invalid', '用户码无效或已过期');
    if (row.expires_at.getTime() <= Date.now()) {
      await this.pool.query(`UPDATE device_codes SET status = 'expired' WHERE id = $1`, [row.id]);
      throw new ApiError(410, 'auth.device_code_expired', '设备码已过期');
    }

    const status = decision === 'approve' ? 'approved' : 'denied';
    await this.pool.query(
      `UPDATE device_codes
          SET status = $2, account_id = $3, approved_at = now()
        WHERE id = $1`,
      [row.id, status, accountId],
    );
    await writeAudit(this.pool, {
      accountId,
      action: decision === 'approve' ? 'auth.device_code.approved' : 'auth.device_code.denied',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { userCode },
    });
    return { status };
  }

  /**
   * 桌面端轮询换令牌。
   * - pending：按 interval 限速后返回 202
   * - approved：签发 access/refresh（绑定占位设备），并消费设备码
   * - denied / expired：403 / 410
   */
  async pollToken(deviceCode: string, context: RequestContext): Promise<DeviceTokenResult> {
    const { rows } = await this.pool.query<DeviceCodeRow>(
      `SELECT * FROM device_codes WHERE device_code = $1 LIMIT 1`,
      [deviceCode],
    );
    const row = rows[0];
    if (!row) throw new ApiError(400, 'request.invalid', '设备码无效');
    if (row.consumed_at !== null) throw new ApiError(400, 'request.invalid', '设备码已被使用');
    if (row.expires_at.getTime() <= Date.now()) {
      await this.pool.query(`UPDATE device_codes SET status = 'expired' WHERE id = $1 AND status <> 'expired'`, [
        row.id,
      ]);
      throw new ApiError(410, 'auth.device_code_expired', '设备码已过期');
    }
    if (row.status === 'denied') throw new ApiError(403, 'auth.device_code_denied', '用户拒绝了本次授权');

    if (row.status === 'pending') {
      this.enforcePollInterval(deviceCode);
      throw new ApiError(202, 'auth.device_code_pending', '等待用户在浏览器确认');
    }
    if (row.status === 'expired') throw new ApiError(410, 'auth.device_code_expired', '设备码已过期');

    // approved：签发令牌
    if (!row.account_id) throw new ApiError(400, 'request.invalid', '设备码状态异常');
    const account = await findAccountById(this.pool, row.account_id);
    if (!account) throw new ApiError(400, 'request.invalid', '账号不存在');
    if (account.status !== 'active') throw new ApiError(403, 'authz.account_suspended', '账号已停用');

    const device = await this.ensurePendingDevice(account, row, context);
    const sessionId = randomUuid();
    const refreshSecret = randomBytes(32).toString('base64url');
    const refreshToken = `rt_${sessionId}_${refreshSecret}`;
    await createSession(this.pool, {
      id: sessionId,
      accountId: account.id,
      deviceId: device.id,
      refreshTokenHash: hashRefreshSecret(refreshSecret, this.deps.config.refreshPepper),
      expiresAt: refreshTokenExpiry(this.deps.config.refreshTokenTtlDays),
      ip: context.ip,
      userAgent: context.userAgent,
    });
    const accessToken = await signAccessToken(
      { accountId: account.id, sessionId },
      this.deps.config.jwtSecret,
      this.deps.config.accessTokenTtlSeconds,
    );

    await this.pool.query(`UPDATE device_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
    await writeAudit(this.pool, {
      accountId: account.id,
      deviceId: device.id,
      action: 'auth.device_code.consumed',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { userCode: row.user_code },
    });

    return {
      account: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
        emailVerified: account.email_verified,
      },
      device: { id: device.id, name: device.name, kind: device.kind, platform: device.platform },
      accessToken,
      refreshToken,
      expiresIn: this.deps.config.accessTokenTtlSeconds,
    };
  }

  private enforcePollInterval(deviceCode: string): void {
    const intervalMs = this.deps.config.deviceCodePollIntervalSeconds * 1000;
    if (intervalMs <= 0) return;
    const now = Date.now();
    const last = this.lastPollAt.get(deviceCode);
    if (last !== undefined && now - last < intervalMs) {
      const retryAfter = Math.max(1, Math.ceil((intervalMs - (now - last)) / 1000));
      throw new ApiError(429, 'rate_limit.exceeded', '轮询过于频繁', { 'Retry-After': String(retryAfter) });
    }
    this.lastPollAt.set(deviceCode, now);
    if (this.lastPollAt.size > 1000) {
      for (const [key, at] of this.lastPollAt) {
        if (now - at > DEVICE_CODE_TTL_MS) this.lastPollAt.delete(key);
      }
    }
  }

  /** 设备码流程先建占位设备（公钥待插件登记真实值）；POST /v1/devices 会升级它。 */
  private async ensurePendingDevice(
    account: AccountRow,
    row: DeviceCodeRow,
    context: RequestContext,
  ): Promise<{ id: string; name: string; kind: string; platform: string }> {
    const name = row.device_name ?? '待激活设备';
    const platform = row.platform ?? 'win32';
    const kind = inferDeviceKind(platform);

    const existing = await this.pool.query<{ id: string; name: string; kind: string; platform: string }>(
      `SELECT id, name, kind, platform FROM devices
        WHERE account_id = $1 AND kind = $2 AND platform = $3 AND name = $4 AND revoked_at IS NULL
        LIMIT 1`,
      [account.id, kind, platform, name],
    );
    const device = existing.rows[0];
    if (device) {
      await this.pool.query('UPDATE devices SET last_seen_at = now(), last_ip = $2 WHERE id = $1', [
        device.id,
        context.ip,
      ]);
      return device;
    }

    const inserted = await this.pool.query<{ id: string; name: string; kind: string; platform: string }>(
      `INSERT INTO devices (account_id, kind, name, platform, sign_public_key, ecdh_public_key, last_seen_at, last_ip)
       VALUES ($1, $2, $3, $4, $5, $5, now(), $6)
       RETURNING id, name, kind, platform`,
      [account.id, kind, name, platform, PENDING_DEVICE_KEY, context.ip],
    );
    return inserted.rows[0] as { id: string; name: string; kind: string; platform: string };
  }
}
