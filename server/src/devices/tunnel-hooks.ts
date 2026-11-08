/**
 * 撤销设备时通知隧道层断开该设备的连接。
 * T03 只定义接口 + 空实现；T05（隧道服务）提供真实实现并在 buildApp 注入。
 */
export interface TunnelControl {
  disconnectDevice(deviceId: string, reason: string): void | Promise<void>;
  /** 该设备此刻是否有活跃隧道会话（在线真值；缺省实现返回 false）。 */
  isOnline?(deviceId: string): boolean;
}

export const noopTunnelControl: TunnelControl = {
  disconnectDevice(): void {
    // 隧道服务尚未接入（T05）；撤销行为已由数据库会话级联保证
  },
  isOnline(): boolean {
    return false;
  },
};
