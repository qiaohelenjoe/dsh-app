import type { AuthConfig } from '../config.js';
import type { DbPool } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { randomInt } from 'node:crypto';
import { hashPassword, isWeakPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../security/passwords.js';
import {
  buffersEqual,
  generateOpaqueToken,
  generateRefreshToken,
  hashOpaqueToken,
  hashRefreshSecret,
  parseRefreshToken,
  randomUuid,
  refreshTokenExpiry,
  signAccessToken,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from '../security/tokens.js';
import { writeAudit } from './repositories/audit.js';
import {
  createAccount,
  EmailTakenError,
  findAccountByEmail,
  findAccountById,
  markAccountLogin,
  updateAccountPassword,
  type AccountRow,
} from './repositories/accounts.js';
import { consumeEmailToken, createEmailToken } from './repositories/email-tokens.js';
import { ensureLoginDevice, type DeviceRow } from './repositories/login-devices.js';
import {
  createSession,
  findSessionById,
  markSessionUsed,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  rotateSessionRefresh,
} from './repositories/sessions.js';
import type { Mailer } from './mailer.js';
import { findDeviceById } from '../devices/repositories.js';

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
/** 邮箱验证码有效期：10 分钟。 */
const PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;
/** 验证码校验通过后签发的重置令牌有效期：10 分钟。 */
const PASSWORD_RESET_TOKEN_TTL_SEC = 10 * 60;

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface PublicAccount {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export interface PublicDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'mobile';
  platform: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string | undefined;
}

export interface LoginInput {
  email: string;
  password: string;
  clientType: 'mobile' | 'desktop';
  device: {
    name: string;
    platform: string;
    appVersion?: string | undefined;
    signPublicKey: string;
    ecdhPublicKey: string;
  };
}

export interface LoginResult {
  account: PublicAccount;
  device: PublicDevice;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 网页会话登录（PC 端账号面板）：只建会话，不登记设备、不占设备名额。 */
export interface WebLoginInput {
  email: string;
  password: string;
}

export interface WebLoginResult {
  account: PublicAccount;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthenticatedIdentity {
  accountId: string;
  sessionId: string;
  /** 网页会话没有设备，故可空。 */
  deviceId: string | null;
}

export interface AuthServiceDeps {
  pool: DbPool;
  config: AuthConfig;
  mailer: Mailer;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublicAccount(row: AccountRow): PublicAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: row.email_verified,
  };
}

function toPublicDevice(row: DeviceRow): PublicDevice {
  return { id: row.id, name: row.name, kind: row.kind, platform: row.platform };
}

export class AuthService {
  private readonly dummyHash: Promise<string>;

  constructor(private readonly deps: AuthServiceDeps) {
    // 账号不存在时也跑一次 argon2 校验，避免通过响应时间枚举邮箱
    this.dummyHash = hashPassword(generateOpaqueToken());
  }

  private get pool(): DbPool {
    return this.deps.pool;
  }

  private get config(): AuthConfig {
    return this.deps.config;
  }

  private assertStrongPassword(password: string): void {
    if (isWeakPassword(password, this.config.weakPasswordListPath)) {
      throw new ApiError(
        400,
        'request.weak_password',
        `密码强度不足：至少 ${MIN_PASSWORD_LENGTH} 位，且不能是常见弱口令`,
      );
    }
  }

  async register(
    input: RegisterInput,
    context: RequestContext,
  ): Promise<{ account: PublicAccount; verificationRequired: boolean }> {
    const email = normalizeEmail(input.email);
    this.assertStrongPassword(input.password);
    const passwordHash = await hashPassword(input.password);

    try {
      const account = await createAccount(this.pool, {
        email,
        passwordHash,
        displayName: input.displayName ?? null,
      });
      await writeAudit(this.pool, {
        accountId: account.id,
        action: 'auth.register.success',
        result: 'ok',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      return {
        account: toPublicAccount(account),
        verificationRequired: this.config.emailVerificationEnabled,
      };
    } catch (error) {
      if (error instanceof EmailTakenError) {
        throw new ApiError(409, 'conflict.email_taken', '该邮箱已注册');
      }
      throw error;
    }
  }

  async login(input: LoginInput, context: RequestContext): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const account = await findAccountByEmail(this.pool, email);
    const passwordHash = account?.password_hash ?? (await this.dummyHash);
    const passwordOk = await verifyPassword(passwordHash, input.password);

    if (!account || !passwordOk) {
      await writeAudit(this.pool, {
        accountId: account?.id ?? null,
        action: 'auth.login.failed',
        result: 'denied',
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { email },
      });
      throw new ApiError(401, 'auth.invalid_credentials', '邮箱或密码不正确');
    }
    if (account.status !== 'active') {
      throw new ApiError(403, 'authz.account_suspended', '账号已停用');
    }

    const kind = input.clientType === 'mobile' ? 'mobile' : 'desktop';
    const device = await ensureLoginDevice(this.pool, {
      accountId: account.id,
      kind,
      name: input.device.name,
      platform: input.device.platform,
      appVersion: input.device.appVersion ?? null,
      signPublicKey: input.device.signPublicKey,
      ecdhPublicKey: input.device.ecdhPublicKey,
      ip: context.ip,
    });

    const sessionId = randomUuid();
    const nextRefresh = generateRefreshToken(sessionId);
    await createSession(this.pool, {
      id: sessionId,
      accountId: account.id,
      deviceId: device.id,
      refreshTokenHash: hashRefreshSecret(nextRefresh.secret, this.config.refreshPepper),
      expiresAt: refreshTokenExpiry(this.config.refreshTokenTtlDays),
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const accessToken = await signAccessToken(
      { accountId: account.id, sessionId },
      this.config.jwtSecret,
      this.config.accessTokenTtlSeconds,
    );
    await markAccountLogin(this.pool, account.id);
    await writeAudit(this.pool, {
      accountId: account.id,
      deviceId: device.id,
      action: 'auth.login.success',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { sessionId },
    });

    return {
      account: toPublicAccount(account),
      device: toPublicDevice(device),
      accessToken,
      refreshToken: nextRefresh.token,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  /**
   * 网页会话登录：PC 端账号面板用。
   *
   * 与 `login` 的区别是不登记设备——面板只需要读账号信息/设备列表，
   * 不应该因为“看一眼账号”就占掉一台设备名额、也不该出现在设备列表里。
   */
  async loginWeb(input: WebLoginInput, context: RequestContext): Promise<WebLoginResult> {
    const email = normalizeEmail(input.email);
    const account = await findAccountByEmail(this.pool, email);
    const passwordHash = account?.password_hash ?? (await this.dummyHash);
    const passwordOk = await verifyPassword(passwordHash, input.password);

    if (!account || !passwordOk) {
      await writeAudit(this.pool, {
        accountId: account?.id ?? null,
        action: 'auth.login.failed',
        result: 'denied',
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { email, mode: 'web' },
      });
      throw new ApiError(401, 'auth.invalid_credentials', '邮箱或密码不正确');
    }
    if (account.status !== 'active') {
      throw new ApiError(403, 'authz.account_suspended', '账号已停用');
    }

    const sessionId = randomUuid();
    const nextRefresh = generateRefreshToken(sessionId);
    await createSession(this.pool, {
      id: sessionId,
      accountId: account.id,
      deviceId: null,
      refreshTokenHash: hashRefreshSecret(nextRefresh.secret, this.config.refreshPepper),
      expiresAt: refreshTokenExpiry(this.config.refreshTokenTtlDays),
      ip: context.ip,
      userAgent: context.userAgent,
    });

    const accessToken = await signAccessToken(
      { accountId: account.id, sessionId },
      this.config.jwtSecret,
      this.config.accessTokenTtlSeconds,
    );
    await markAccountLogin(this.pool, account.id);
    await writeAudit(this.pool, {
      accountId: account.id,
      action: 'auth.login.success',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { sessionId, mode: 'web' },
    });

    return {
      account: toPublicAccount(account),
      accessToken,
      refreshToken: nextRefresh.token,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  /**
   * 用账号级会话（网页/面板登录）为**本账号的一台设备**签发设备会话。
   *
   * 用途：面板登录本身不绑定设备，但插件把本机登记成设备后需要一条设备会话才能
   * 申请隧道票据、建立隧道。这里校验设备归属后签发，网页会话本身权限不外溢。
   */
  async issueDeviceSession(
    identity: { accountId: string; sessionId: string },
    deviceId: string,
    context: RequestContext,
  ): Promise<TokenPair & { deviceId: string }> {
    const device = await findDeviceById(this.pool, deviceId);
    if (!device || device.account_id !== identity.accountId || device.revoked_at !== null) {
      throw new ApiError(403, 'authz.forbidden', '设备不属于当前账号');
    }
    const account = await findAccountById(this.pool, identity.accountId);
    if (!account || account.status !== 'active') {
      throw new ApiError(403, 'authz.account_suspended', '账号已停用');
    }

    const sessionId = randomUuid();
    const nextRefresh = generateRefreshToken(sessionId);
    await createSession(this.pool, {
      id: sessionId,
      accountId: identity.accountId,
      deviceId,
      refreshTokenHash: hashRefreshSecret(nextRefresh.secret, this.config.refreshPepper),
      expiresAt: refreshTokenExpiry(this.config.refreshTokenTtlDays),
      ip: context.ip,
      userAgent: context.userAgent,
    });
    const accessToken = await signAccessToken(
      { accountId: identity.accountId, sessionId },
      this.config.jwtSecret,
      this.config.accessTokenTtlSeconds,
    );
    await writeAudit(this.pool, {
      accountId: identity.accountId,
      deviceId,
      action: 'auth.device_session.success',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { sessionId, via: 'panel' },
    });
    return {
      accessToken,
      refreshToken: nextRefresh.token,
      expiresIn: this.config.accessTokenTtlSeconds,
      deviceId,
    };
  }

  async refresh(refreshToken: string, context: RequestContext): Promise<TokenPair> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new ApiError(401, 'auth.token_invalid', '刷新令牌无效');

    const session = await findSessionById(this.pool, parsed.sessionId);
    if (!session) throw new ApiError(401, 'auth.token_invalid', '刷新令牌无效');

    const presentedHash = hashRefreshSecret(parsed.secret, this.config.refreshPepper);
    if (!buffersEqual(session.refresh_token_hash, presentedHash)) {
      // 复用已被轮换的旧令牌：撤销该会话全部令牌并审计
      await revokeSession(this.pool, session.id);
      await writeAudit(this.pool, {
        accountId: session.account_id,
        deviceId: session.device_id,
        action: 'auth.token.reuse',
        result: 'denied',
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { sessionId: session.id },
      });
      throw new ApiError(401, 'auth.token_reuse', '刷新令牌已被使用，请重新登录');
    }

    if (session.revoked_at !== null) {
      throw new ApiError(401, 'auth.token_invalid', '会话已失效，请重新登录');
    }
    if (session.expires_at.getTime() <= Date.now()) {
      throw new ApiError(401, 'auth.token_expired', '刷新令牌已过期，请重新登录');
    }

    const account = await findAccountById(this.pool, session.account_id);
    if (!account || account.status !== 'active') {
      throw new ApiError(403, 'authz.account_suspended', '账号已停用');
    }

    const nextRefresh = generateRefreshToken(session.id);
    const rotated = await rotateSessionRefresh(
      this.pool,
      session.id,
      hashRefreshSecret(nextRefresh.secret, this.config.refreshPepper),
      refreshTokenExpiry(this.config.refreshTokenTtlDays),
    );
    if (!rotated) {
      await revokeSession(this.pool, session.id);
      throw new ApiError(401, 'auth.token_reuse', '刷新令牌已被并发使用，请重新登录');
    }

    const accessToken = await signAccessToken(
      { accountId: account.id, sessionId: session.id },
      this.config.jwtSecret,
      this.config.accessTokenTtlSeconds,
    );
    await markSessionUsed(this.pool, session.id);
    await writeAudit(this.pool, {
      accountId: account.id,
      deviceId: session.device_id,
      action: 'auth.refresh.success',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { sessionId: session.id },
    });

    return {
      accessToken,
      refreshToken: nextRefresh.token,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  /**
   * 用 refresh token 换一个网页会话（7 天 Cookie 用），**不轮换** refresh token。
   * 轮换只发生在 /v1/auth/refresh：如果 WebView 也走轮换，App 手里同一个 refresh
   * 就会被判定为“重用”而整会话撤销，表现为两处登录互相踢下线。
   */
  async createWebSession(
    refreshToken: string,
    context: RequestContext,
  ): Promise<{ accessToken: string; accountId: string; sessionId: string; expiresIn: number }> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new ApiError(401, 'auth.token_invalid', '刷新令牌无效');

    const session = await findSessionById(this.pool, parsed.sessionId);
    if (!session) throw new ApiError(401, 'auth.token_invalid', '刷新令牌无效');

    const presentedHash = hashRefreshSecret(parsed.secret, this.config.refreshPepper);
    if (!buffersEqual(session.refresh_token_hash, presentedHash)) {
      throw new ApiError(401, 'auth.token_invalid', '刷新令牌无效');
    }
    if (session.revoked_at !== null) {
      throw new ApiError(401, 'auth.token_invalid', '会话已失效，请重新登录');
    }
    if (session.expires_at.getTime() <= Date.now()) {
      throw new ApiError(401, 'auth.token_expired', '刷新令牌已过期，请重新登录');
    }

    const account = await findAccountById(this.pool, session.account_id);
    if (!account || account.status !== 'active') {
      throw new ApiError(403, 'authz.account_suspended', '账号已停用');
    }

    const accessToken = await signAccessToken(
      { accountId: account.id, sessionId: session.id },
      this.config.jwtSecret,
      this.config.accessTokenTtlSeconds,
    );
    await markSessionUsed(this.pool, session.id);
    await writeAudit(this.pool, {
      accountId: account.id,
      deviceId: session.device_id,
      action: 'auth.web_session.success',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { sessionId: session.id },
    });
    return {
      accessToken,
      accountId: account.id,
      sessionId: session.id,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }
  async logout(refreshToken: string, context: RequestContext): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return; // 幂等：无效令牌同样返回成功

    const session = await findSessionById(this.pool, parsed.sessionId);
    if (!session) return;

    const presentedHash = hashRefreshSecret(parsed.secret, this.config.refreshPepper);
    if (!buffersEqual(session.refresh_token_hash, presentedHash)) return;

    await revokeSession(this.pool, session.id);
    await writeAudit(this.pool, {
      accountId: session.account_id,
      deviceId: session.device_id,
      action: 'auth.logout',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { sessionId: session.id },
    });
  }

  async changePassword(
    identity: AuthenticatedIdentity,
    input: { currentPassword: string; newPassword: string },
    context: RequestContext,
  ): Promise<void> {
    const account = await findAccountById(this.pool, identity.accountId);
    if (!account) throw new ApiError(401, 'auth.token_invalid', '账号不存在');

    const currentOk = await verifyPassword(account.password_hash, input.currentPassword);
    if (!currentOk) throw new ApiError(401, 'auth.invalid_credentials', '当前密码不正确');

    this.assertStrongPassword(input.newPassword);
    const newHash = await hashPassword(input.newPassword);
    await updateAccountPassword(this.pool, account.id, newHash);
    const revoked = await revokeOtherSessions(this.pool, account.id, identity.sessionId);
    await writeAudit(this.pool, {
      accountId: account.id,
      deviceId: identity.deviceId,
      action: 'auth.password.change',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { revokedSessions: revoked },
    });
  }

  async forgotPassword(email: string, context: RequestContext): Promise<void> {
    const normalized = normalizeEmail(email);
    const account = await findAccountByEmail(this.pool, normalized);

    // 防用户枚举：无论邮箱是否存在都返回 202，且不透露任何差异
    if (!account || account.status !== 'active') return;

    // 6 位数字验证码（10 分钟有效、一次使用）；库里只存哈希
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_CODE_TTL_MS);
    const token = generateOpaqueToken();
    await createEmailToken(this.pool, {
      accountId: account.id,
      purpose: 'reset_password',
      tokenHash: hashOpaqueToken(code, this.config.refreshPepper),
      expiresAt,
    });

    try {
      await this.deps.mailer.sendPasswordReset({
        email: account.email,
        code,
        token,
        expiresAt,
        resetUrl: `${this.config.publicBaseUrl}/reset?t=${encodeURIComponent(token)}`,
      });
    } catch (error) {
      console.error('[auth] 重置邮件发送失败（不影响 202 响应）', error);
    }

    await writeAudit(this.pool, {
      accountId: account.id,
      action: 'auth.password.reset.request',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /** 第二步：校验邮箱验证码，通过后签发 10 分钟有效的一次性重置令牌。 */
  async verifyResetCode(email: string, code: string, context: RequestContext): Promise<{ resetToken: string }> {
    const normalized = normalizeEmail(email);
    const account = await findAccountByEmail(this.pool, normalized);
    const invalid = () => new ApiError(400, 'request.invalid', '验证码不正确或已过期');
    if (!account || account.status !== 'active') throw invalid();
    const consumed = await consumeEmailToken(
      this.pool,
      hashOpaqueToken(code.trim(), this.config.refreshPepper),
      'reset_password',
    );
    if (!consumed || consumed.accountId !== account.id) throw invalid();
    const resetToken = await signPasswordResetToken(account.id, this.config.jwtSecret, PASSWORD_RESET_TOKEN_TTL_SEC);
    await writeAudit(this.pool, {
      accountId: account.id,
      action: 'auth.password.reset.verify',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { resetToken };
  }

  /** 第三步：用重置令牌（或旧的一键链接令牌）设置新密码，并撤销该账号全部会话。 */
  async resetPassword(
    input: { token?: string; resetToken?: string; newPassword: string },
    context: RequestContext,
  ): Promise<void> {
    this.assertStrongPassword(input.newPassword);

    let accountId: string | null = null;
    if (input.resetToken) {
      try {
        accountId = (await verifyPasswordResetToken(input.resetToken, this.config.jwtSecret)).accountId;
      } catch {
        throw new ApiError(400, 'request.invalid', '重置令牌无效或已过期');
      }
    } else if (input.token) {
      const consumed = await consumeEmailToken(
        this.pool,
        hashOpaqueToken(input.token, this.config.refreshPepper),
        'reset_password',
      );
      if (!consumed) throw new ApiError(400, 'request.invalid', '重置令牌无效或已过期');
      accountId = consumed.accountId;
    } else {
      throw new ApiError(400, 'request.invalid', '缺少重置令牌');
    }

    if (!accountId) throw new ApiError(400, 'request.invalid', '缺少重置令牌');
    const targetAccountId = accountId;
    const newHash = await hashPassword(input.newPassword);
    await updateAccountPassword(this.pool, targetAccountId, newHash);
    const revoked = await revokeAllSessions(this.pool, targetAccountId);
    await writeAudit(this.pool, {
      accountId: targetAccountId,
      action: 'auth.password.reset',
      result: 'ok',
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { revokedSessions: revoked },
    });
  }
}
