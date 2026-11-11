import { z } from 'zod';

const emailField = z.string().trim().toLowerCase().email('邮箱格式不正确').max(254);
const passwordField = z.string().min(1, '密码不能为空').max(200);
const displayNameField = z.string().trim().min(1).max(64);
const opaqueTokenField = z.string().min(10).max(512);

const platformField = z.enum(['win32', 'darwin', 'linux', 'android', 'ios', 'harmony']);

export const loginDeviceSchema = z.object({
  name: z.string().trim().min(1).max(64),
  platform: platformField,
  appVersion: z.string().max(64).optional(),
  signPublicKey: z.string().min(1).max(2048),
  ecdhPublicKey: z.string().min(1).max(2048),
});

export const registerSchema = z.object({
  email: emailField,
  password: passwordField,
  displayName: displayNameField.optional(),
});

export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
  clientType: z.enum(['mobile', 'desktop']),
  device: loginDeviceSchema,
});

/** 网页会话登录（PC 账号面板）：邮箱+密码，不登记设备。 */
export const webLoginSchema = z.object({
  email: emailField,
  password: passwordField,
});

export const refreshSchema = z.object({
  refreshToken: opaqueTokenField,
});

export const logoutSchema = z.object({
  refreshToken: opaqueTokenField,
});

export const changePasswordSchema = z.object({
  currentPassword: passwordField,
  newPassword: passwordField,
});

export const forgotPasswordSchema = z.object({
  email: emailField,
});

export const verifyResetCodeSchema = z.object({
  email: emailField,
  code: z.string().trim().regex(/^\d{6}$/, '验证码应为 6 位数字'),
});

export const resetPasswordSchema = z
  .object({
    newPassword: passwordField,
    /** 旧流程：邮件里的链接令牌。 */
    token: opaqueTokenField.optional(),
    /** 新流程：验证码校验通过后拿到的短时重置令牌。 */
    resetToken: opaqueTokenField.optional(),
  })
  .refine((value) => Boolean(value.token || value.resetToken), { message: '缺少重置令牌', path: ['token'] });
