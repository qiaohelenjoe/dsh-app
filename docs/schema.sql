-- ============================================================
-- DSH 移动端账号平台 —— 数据库结构 v1.0
-- PostgreSQL 16+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ------------------------------------------------------------
-- 账号
-- ------------------------------------------------------------
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,                    -- argon2id 完整编码串
  display_name   text,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended', 'deleted')),
  email_verified boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE INDEX idx_accounts_created_at ON accounts (created_at DESC);

-- ------------------------------------------------------------
-- 邮箱验证 / 密码重置（统一用一次性令牌表）
-- ------------------------------------------------------------
CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash  bytea NOT NULL,                      -- SHA-256(token)
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_tokens_lookup ON email_tokens (token_hash) WHERE consumed_at IS NULL;
CREATE INDEX idx_email_tokens_account ON email_tokens (account_id, purpose);

-- ------------------------------------------------------------
-- 设备（桌面端 + 手机端）
-- ------------------------------------------------------------
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('desktop', 'mobile')),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  platform      text NOT NULL CHECK (platform IN
                  ('win32','darwin','linux','android','ios','harmony')),
  -- 设备身份公钥（Ed25519，base64）
  sign_public_key  text NOT NULL,
  -- 端到端协商公钥（X25519，base64）
  ecdh_public_key  text NOT NULL,
  app_version   text,
  last_seen_at  timestamptz,
  last_ip       inet,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_account_active
  ON devices (account_id, kind) WHERE revoked_at IS NULL;
CREATE INDEX idx_devices_last_seen
  ON devices (last_seen_at DESC) WHERE revoked_at IS NULL;

-- 同账号下设备名允许重复，但同一账号同一平台同一名称不允许并存（防误注册刷屏）
CREATE UNIQUE INDEX uq_devices_account_name_alive
  ON devices (account_id, kind, platform, name) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------
-- 登录会话（refresh token 只存哈希）
-- ------------------------------------------------------------
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id          uuid REFERENCES devices(id) ON DELETE CASCADE,  -- 网页会话（PC 面板）不绑定设备（migration 0004）
  refresh_token_hash bytea NOT NULL UNIQUE,        -- SHA-256(token + pepper)
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  ip                 inet,
  user_agent         text
);

CREATE INDEX idx_sessions_account ON sessions (account_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_device ON sessions (device_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ------------------------------------------------------------
-- 桌面端设备授权码（Device Code 流程）
-- ------------------------------------------------------------
CREATE TABLE device_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code  text NOT NULL UNIQUE,               -- 高熵随机串（客户端轮询用）
  user_code    text NOT NULL,                      -- 人类输入 8 位
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  account_id   uuid REFERENCES accounts(id) ON DELETE CASCADE,
  device_name  text,
  platform     text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz,
  consumed_at  timestamptz,
  ip           inet
);

CREATE UNIQUE INDEX uq_device_codes_user_code_pending
  ON device_codes (user_code) WHERE status = 'pending';
CREATE INDEX idx_device_codes_expiry ON device_codes (expires_at);

-- ------------------------------------------------------------
-- 审计日志
-- ------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  action      text NOT NULL,        -- auth.login.success / device.revoke / token.reuse ...
  result      text NOT NULL CHECK (result IN ('ok', 'denied', 'error')),
  ip          inet,
  user_agent  text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_account_time ON audit_logs (account_id, created_at DESC);
CREATE INDEX idx_audit_action_time ON audit_logs (action, created_at DESC);

-- ------------------------------------------------------------
-- updated_at 自动维护
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_devices_updated BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 清理过期数据（可由 cron 每日调用）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_expired() RETURNS void AS $$
BEGIN
  DELETE FROM device_codes WHERE expires_at < now() - interval '1 day';
  DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day';
  UPDATE sessions SET revoked_at = now()
    WHERE revoked_at IS NULL AND expires_at < now() - interval '1 day';
  DELETE FROM sessions WHERE revoked_at < now() - interval '30 days';
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 常用视图：账号下的活跃设备（含在线判定位）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_active_devices AS
SELECT d.id, d.account_id, d.kind, d.name, d.platform,
       d.last_seen_at, d.created_at,
       (d.last_seen_at IS NOT NULL
        AND d.last_seen_at > now() - interval '90 seconds') AS online
FROM devices d
WHERE d.revoked_at IS NULL;
