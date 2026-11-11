import type { DbPool } from '../db/pool.js';
import { writeAudit } from '../auth/repositories/audit.js';
import { ApiError } from '../http/errors.js';
import { RateLimiter } from '../security/rate-limit.js';
import {
  bindMachineName,
  countAliveDevices,
  DeviceNameTakenError,
  findAliveDeviceByMachineName,
  findDeviceById,
  findMachineNameOwner,
  findOldestUnboundDesktopDevice,
  insertDevice,
  listAliveDevices,
  renameDevice,
  revokeDevice,
  touchDeviceForReuse,
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
  /** 计算机名称（如 DESKTOP-LFJSTDL）：设备身份的匹配键；老客户端不传，走兼容路径。 */
  machineName?: string | undefined;
}

const REGISTER_LIMIT_PER_HOUR = 20;

/** 计算机名称格式：字母数字与 . _ -，长度 1–64。 */
const MACHINE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeMachineName(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!MACHINE_NAME_PATTERN.test(code)) {
    throw new ApiError(400, 'request.invalid', '计算机名称格式不正确（应形如 PC-3F7A-91C2）');
  }
  return code;
}

function toView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    platform: row.platform,
    online: row.online,
    machineName: row.machine_name,
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

  /** 登记设备：按计算机名称优先复用；否则查配额（403）→ 注册频率（429）→ 插入并处理同名冲突（409）。 */
  async register(
    accountId: string,
    input: RegisterDeviceInput,
    context: RequestContext,
  ): Promise<DeviceView> {
    const kind: DeviceKind = inferDeviceKind(input.platform);
    const machineName = input.machineName ? normalizeMachineName(input.machineName) : null;

    // 身份优先：这台机器（按短码）已登记过就复用——不新建、不占名额、与设备名称无关
    if (machineName) {
      const existing = await findAliveDeviceByMachineName(this.pool, accountId, kind, machineName);
      if (existing) {
        const touched = await touchDeviceForReuse(this.pool, {
          deviceId: existing.id,
          appVersion: input.appVersion ?? null,
          signPublicKey: input.signPublicKey,
          ecdhPublicKey: input.ecdhPublicKey,
          ip: context.ip,
          machineName,
        });
        const row = touched ?? existing;
        await this.auditRegister(accountId, row.id, kind, input, 'reused-by-machine-code');
        return toView(row);
      }
    }

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
      machineName,
    });
    if (upgraded) {
      await this.auditRegister(accountId, upgraded.id, kind, input);
      return toView(upgraded);
    }

    const alive = await countAliveDevices(this.pool, accountId, kind);
    if (alive >= DEVICE_QUOTAS[kind]) {
      // 名额已满但本机是新出现的计算机名称：把账号下"还没有计算机名称、最久未连接"的老桌面设备自动接管给本机。
      // 身份仍由短码决定，名称不参与；接管动作写审计，用户无需任何手工操作。
      if (machineName && kind === 'desktop') {
        const adoptable = await findOldestUnboundDesktopDevice(this.pool, accountId);
        if (adoptable) {
          const touched = await touchDeviceForReuse(this.pool, {
            deviceId: adoptable.id,
            appVersion: input.appVersion ?? null,
            signPublicKey: input.signPublicKey,
            ecdhPublicKey: input.ecdhPublicKey,
            ip: context.ip,
            machineName,
          });
          if (touched) {
            await this.auditRegister(accountId, touched.id, kind, input, 'adopted-legacy-device');
            return { ...toView(touched), adoptedFrom: adoptable.name };
          }
        }
      }
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
        machineName,
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

  /**
   * 老设备补名：已用设备会话连上来的设备，把自己的计算机名称补绑到本行。
   * 只在自己那台设备上没有码（或码相同）时生效，别人改不动。
   */
  async bindOwnMachineName(deviceId: string, accountId: string, rawCode: string): Promise<DeviceView> {
    const machineName = normalizeMachineName(rawCode);
    const owner = await findMachineNameOwner(this.pool, accountId, machineName);
    if (owner && owner.id !== deviceId) {
      throw new ApiError(409, 'conflict.machine_name_taken', `该计算机名称已绑定在「${owner.name}」上`);
    }
    const bound = await bindMachineName(this.pool, deviceId, accountId, machineName);
    if (!bound) {
      const current = await findDeviceById(this.pool, deviceId);
      if (!current || current.revoked_at !== null || current.account_id !== accountId) {
        throw new ApiError(404, 'not_found.device', '设备不存在');
      }
      throw new ApiError(409, 'conflict.machine_name_taken', '该设备已绑定其他计算机名称');
    }
    return toView(bound);
  }

  /**
   * 一次性认领：把一台"从没记过机器码"的历史设备认成当前这台机器。
   * 校验归属、未撤销、该行没有码、码未被别的活跃设备占用；成功后写码（不新建、不占名额）。
   */
  async claimMachineCode(
    accountId: string,
    deviceId: string,
    rawCode: string,
    context: RequestContext,
  ): Promise<DeviceView> {
    const machineName = normalizeMachineName(rawCode);
    const device = await this.loadOwnedDevice(accountId, deviceId);
    if (device.machine_name) {
      throw new ApiError(409, 'conflict.machine_name_bound', '该设备已绑定计算机名称，无需认领');
    }
    const owner = await findMachineNameOwner(this.pool, accountId, machineName);
    if (owner) {
      throw new ApiError(409, 'conflict.machine_name_taken', `该计算机名称已绑定在「${owner.name}」上`);
    }
    const bound = await bindMachineName(this.pool, device.id, accountId, machineName);
    if (!bound) throw new ApiError(409, 'conflict.machine_name_taken', '认领失败：设备状态已变化');
    try {
      await writeAudit(this.pool, {
        accountId,
        deviceId: device.id,
        action: 'device.claim',
        result: 'ok',
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { machineName },
      });
    } catch (error) {
      console.warn(`[devices] 写 device.claim 审计失败：${(error as Error).message}`);
    }
    return toView(bound);
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
    outcome = 'created',
  ): Promise<void> {
    try {
      await writeAudit(this.pool, {
        accountId,
        deviceId,
        action: 'device.register',
        result: 'ok',
        detail: { kind, platform: input.platform, name: input.name, outcome, machineName: input.machineName ?? null },
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
