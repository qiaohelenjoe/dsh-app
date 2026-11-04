export interface PasswordResetMail {
  email: string;
  token: string;
  expiresAt: Date;
  resetUrl: string;
}

/** 邮件端口：v1 默认写日志，部署时替换为真实 SMTP 实现（T12）。 */
export interface Mailer {
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
}

export const consoleMailer: Mailer = {
  async sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    console.log(`[mailer] 密码重置链接（开发模式）→ ${mail.email}: ${mail.resetUrl}`);
  },
};
