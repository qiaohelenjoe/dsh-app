import { z } from 'zod';

export const devicePlatformField = z.enum(['win32', 'darwin', 'linux', 'android', 'ios', 'harmony']);

export const registerDeviceSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: devicePlatformField,
  appVersion: z.string().max(64).optional(),
  signPublicKey: z.string().min(1).max(2048),
  ecdhPublicKey: z.string().min(1).max(2048),
  /** 计算机名称（PC-XXXX-XXXX）：设备稳定身份；老客户端不传。 */
  machineName: z.string().trim().min(1).max(64).optional(),
});

/** 计算机名称格式由服务端统一校验（大写、PC-XXXX-XXXX）。 */
export const machineNameSchema = z.object({
  machineName: z.string().trim().min(1).max(64),
});

export const renameDeviceSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

export const deviceIdParamsSchema = z.object({
  id: z.string().uuid('设备 ID 必须是 UUID'),
});
