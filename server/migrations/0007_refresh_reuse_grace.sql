-- 0007_refresh_reuse_grace.sql · 刷新令牌并发重放宽限
--
-- 背景：refresh token 一次性轮换，且旧令牌重放会撤销整条会话。客户端存在多条
-- 刷新路径（面板/隧道/手机多页面），并发刷新会把彼此误判为"令牌盗用"，导致
-- 用户登录一小段时间后被强制重新登录。
--
-- 方案：保留上一代刷新令牌哈希与最近使用时间，宽限期（REFRESH_REUSE_GRACE_SECONDS，
-- 默认 120 秒）内旧令牌可继续换 access token（不轮换、宽限时间滑动）；超出宽限才
-- 按盗用处理。既保留盗用检测，又消除并发误伤。
--
-- 幂等：列已存在时无副作用；老会话两列为 NULL，行为与修改前一致。
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prev_refresh_token_hash bytea;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prev_refresh_used_at timestamptz;