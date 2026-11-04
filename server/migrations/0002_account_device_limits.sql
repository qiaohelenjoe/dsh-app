-- 按账号设备配额：PC 2 台、移动端 3 台（可在账号上单独调整）
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS desktop_device_limit integer NOT NULL DEFAULT 2;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mobile_device_limit integer NOT NULL DEFAULT 3;