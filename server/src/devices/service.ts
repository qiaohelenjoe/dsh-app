import type { DbPool } from '../db/pool.js';
import { writeAudit } from '../auth/repositories/audit.js';
import { ApiError } from '../http/errors.js';
import { RateLimiter } from '../security/rate-limit.js';
import {
  countAliveDevices,
  DeviceNameTakenError,
  findDeviceById,
  insertDevice,
  listAliveDevices,
  renameDevice,
  revokeDevice,
  upgradePendingDevice,
  type DeviceRow,
} from './repositories.js';
import { findAccountById } from '../auth/repositories/accounts.js';
import { noopTunnelControl, type TunnelControl } from './tunnel-hooks.js';
import { DEVICE_QUOTAS, inferDeviceKind, type DeviceKind, type DeviceView } from './types.js';

export interface DeviceServiceDeps {
  pool: DbPool;
  /** 隧道断开钩子；T05 注入真实实现，缺省为空实现。 */
  tunnel?: TunnelControl;
  limiter?: RateLimiter;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface RegisterDeviceInput {
  name: string;
  platform: string;
  appVersion?: string | undefined;
  signPublicKey: string;
  ecdhPublicKey: string;
}

const REGISTER_LIMIT_PER_HOUR = 20;

function toView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    platform: row.platform,
    online: row.online,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    appVersion: row.app_version,
    createdAt: row.created_at.toISOString(),
  };
}

export class DeviceService {
  private readonly limiter: RateLimiter;

  constructor(private readonly deps: DeviceServiceDeps) {
    this.limiter = deps.limiter ?? new RateLimiter();
  }

  private get pool(): DbPool {
    return this.deps.pool;
  }

  async list(accountId: string): Promise<DeviceView[]> {
    const rows = await listAliveDevices(this.pool, accountId);
    const isOnline = this.deps.tunnel?.isOnline;
    return rows.map((row) => {
      const view = toView(row);
      // 在线真值：有活跃隧道会话即在线；否则退回数据库时间窗判定（服务端重启后的短暂空档）
      const connected = isOnline ? isOnline.call(this.deps.tunnel, row.id) : false;
      return connected ? { ...view, online: true, connected: true } : { ...view, connected: view.online };
    });
  }

  /** 登记设备：先查配额（403），再查注册频率（429），最后插入并处理同名冲突（409）。 */
  async register(
    accountId: string,
    input: RegisterDeviceInput,
    context: RequestContext,
  ): Promise<DeviceView> {
    const kind: DeviceKind = inferDeviceKind(input.platform);

    // 设备码流程创建的占位设备：登记真实公钥即升级，不重复计数、不占用注册频率
    const upgraded = await upgradePendingDevice(this.pool, {
      accountId,
      kind,
      name: input.name,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      signPublicKey: input.signPublicKey,
      ecdhPublicKey: input.ecdhPublicKey,
      ip: context.ip,
    });
    if (upgraded) {
      await this.auditRegister(accountId, upgraded.id, kind, input);
      return toView(upgraded);
    }

    const alive = await countAliveDevices(this.pool, accountId, kind);
    if (alive >= DEVICE_QUOTAS[kind]) {
      throw new ApiError(403, 'authz.device_quota_exceeded', `设备数量已达上限（${DEVICE_QUOTAS[kind]} 台）`);
    }

    const decision = this.limiter.consume(`devices:register:${accountId}`, REGISTER_LIMIT_PER_HOUR, 60 * 60 * 1000);
    if (!decision.allowed) {
      throw new ApiError(429, 'rate_limit.exceeded', '设备注册过于频繁，请稍后再试', {
        'Retry-After': String(decision.retryAfterSec),
      });
    }

    try {
      const row = await insertDevice(this.pool, {
        accountId,
        kind,
        name: input.name,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        signPublicKey: input.signPublicKey,
        ecdhPublicKey: input.ecdhPublicKey,
        ip: context.ip,
      });
      await this.auditRegister(accountId, row.id, kind, input);
      return toView(row);
    } catch (error) {
      if (error instanceof DeviceNameTakenError) {
        throw new ApiError(409, 'conflict.device_name_taken', '同平台下已存在同名设备');
      }
      throw error;
    }
  }

  async rename(accountId: string, deviceId: string, name: string): Promise<DeviceView> {
    const device = await this.loadOwnedDevice(accountId, deviceId);
    try {
      const updated = await renameDevice(this.pool, device.id, name);
      if (!updated) throw new ApiError(404, 'not_found.device', '设备不存在');
      return toView(updated);
    } catch (error) {
      if (error instanceof DeviceNameTakenError) {
        throw new ApiError(409, 'conflict.device_name_taken', '同平台下已存在同名设备');
      }
      throw error;
    }
  }

  /** 撤销设备：数据库级联（设备 + 会话 + 审计）后通知隧道层断开连接。 */
  async revoke(accountId: string, deviceId: string, context: RequestContext): Promise<void> {
    const device = await this.loadOwnedDevice(accountId, deviceId);
    const revoked = await revokeDevice(this.pool, {
      accountId,
      deviceId: device.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    if (!revoked) throw new ApiError(404, 'not_found.device', '设备不存在');

    const tunnel = this.deps.tunnel ?? noopTunnelControl;
    await tunnel.disconnectDevice(device.id, 'device-revoked');
  }

  /** 设备登记审计（规格 §11）：写失败只记录日志，不影响注册主流程。 */
  private async auditRegister(
    accountId: string,
    deviceId: string,
    kind: DeviceKind,
    input: RegisterDeviceInput,
  ): Promise<void> {
    try {
      await writeAudit(this.pool, {
        accountId,
        deviceId,
        action: 'device.register',
        result: 'ok',
        detail: { kind, platform: input.platform, name: input.name },
      });
    } catch (error) {
      console.warn(`[devices] 写 device.register 审计失败（deviceId=${deviceId}）：${(error as Error).message}`);
    }
  }

  /** 跨账号访问：设备不存在 404；存在但不属于当前账号 403。 */
  private async loadOwnedDevice(accountId: string, deviceId: string): Promise<DeviceRow> {
    const device = await findDeviceById(this.pool, deviceId);
    if (!device || device.revoked_at !== null) {
      throw new ApiError(404, 'not_found.device', '设备不存在');
    }
    if (device.account_id !== accountId) {
      throw new ApiError(403, 'authz.forbidden', '无权访问该设备');
    }
    return device;
  }
}
