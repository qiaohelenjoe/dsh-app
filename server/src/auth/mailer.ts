export interface PasswordResetMail {
  email: string;
  /** 6 位数字验证码：面板/App 第二步输入。 */
  code: string;
  /** 兼容旧的一键重置链接流程（保留但不再作为主流程）。 */
  token: string;
  expiresAt: Date;
  resetUrl: string;
}

/** 邮件端口：未配置 SMTP 时退回控制台日志（本地开发）。 */
export interface Mailer {
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
}

export const consoleMailer: Mailer = {
  async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    console.log(`[mailer] 密码重置验证码（开发模式）→ ${mail.email}: ${mail.code}（链接 ${mail.resetUrl}）`);
  },
};

/**
 * 真实 SMTP 邮件（T12）：配置走环境变量，不硬编码。
 *
 * - `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`
 * - 缺 `SMTP_HOST` 或 `SMTP_FROM` 时退回 consoleMailer，并在启动日志里说明
 */
export function buildMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  if (!host || !from) {
    console.warn('[mailer] 未配置 SMTP_HOST / SMTP_FROM，重置邮件只写日志（不会真的发出）');
    return consoleMailer;
  }
  const port = Number(env.SMTP_PORT?.trim() || '465');
  const secure = (env.SMTP_SECURE?.trim() || (port === 465 ? 'true' : 'false')) === 'true';
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  let transporter: any = null;

  const ensureTransport = async (): Promise<any> => {
    if (transporter) return transporter;
    const imported: any = await import('nodemailer');
    const nodemailer = imported.default ?? imported;
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    return transporter;
  };

  return {
    async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
      const transport = await ensureTransport();
      const text = [
        '你好，',
        '',
        `你正在重置 DSH 账号（${mail.email}）的密码。`,
        `验证码：${mail.code}`,
        '验证码 10 分钟内有效，只能使用一次。',
        '',
        '如果这不是你本人的操作，忽略本邮件即可，密码不会被修改。',
      ].join('\n');
      await transport.sendMail({
        from,
        to: mail.email,
        subject: 'DSH 账号密码重置验证码',
        text,
      });
    },
  };
}
