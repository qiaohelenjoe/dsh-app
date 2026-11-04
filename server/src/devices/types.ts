export type DeviceKind = 'desktop' | 'mobile';

/** 规格 D5：单账号 20 桌面 / 10 移动端。 */
export const DEVICE_QUOTAS: Record<DeviceKind, number> = {
  desktop: 2,
  mobile: 3,
};

const MOBILE_PLATFORMS = new Set(['android', 'ios', 'harmony']);

/** 设备类型由平台推断：移动平台 → mobile，其余（win32/darwin/linux）→ desktop。 */
export function inferDeviceKind(platform: string): DeviceKind {
  return MOBILE_PLATFORMS.has(platform) ? 'mobile' : 'desktop';
}

/** 设备码流程创建的占位设备公钥标记；插件登记真实公钥时升级该设备。 */
export const PENDING_DEVICE_KEY = 'device-code-pending';

/** 对外设备视图（api.md §2.1）。 */
export interface DeviceView {
  id: string;
  kind: DeviceKind;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt: string | null;
  appVersion: string | null;
  createdAt: string;
}
