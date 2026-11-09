-- 移动端默认配额：3 台 → 2 台（新账号默认值；已有账号的当前值保持不变）
ALTER TABLE accounts ALTER COLUMN mobile_device_limit SET DEFAULT 2;
