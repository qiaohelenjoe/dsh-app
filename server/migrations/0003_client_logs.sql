-- 移动端日志上传：按账号/设备保存脱敏后的客户端日志
CREATE TABLE IF NOT EXISTS client_logs (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  app_version text,
  platform text,
  level text NOT NULL,
  event text,
  message text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_logs_account_time
  ON client_logs (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_logs_created_at
  ON client_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_logs_request_id
  ON client_logs (request_id)
  WHERE request_id IS NOT NULL;
