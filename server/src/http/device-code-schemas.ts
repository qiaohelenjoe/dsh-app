import { z } from 'zod';

export const requestDeviceCodeSchema = z.object({
  deviceName: z.string().trim().min(1).max(64),
  platform: z.enum(['win32', 'darwin', 'linux']),
});

export const deviceTokenSchema = z.object({
  deviceCode: z.string().min(20).max(256),
});

export const approveDeviceCodeSchema = z.object({
  userCode: z.string().min(4).max(16),
  decision: z.enum(['approve', 'deny']).default('approve'),
});
