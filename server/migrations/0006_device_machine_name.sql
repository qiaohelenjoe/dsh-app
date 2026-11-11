-- 设备身份：计算机名称（如 DESKTOP-LFJSTDL），由客户端上报。
-- 用途只是"认出这是同一台机器"，界面仍显示用户自己起的设备名。
-- 老数据可空：设备升级连上来后由服务端补写。
ALTER TABLE devices ADD COLUMN IF NOT EXISTS machine_name text;

-- 同一账号下同一台机器（按计算机名）只允许一条活跃设备记录；撤销后可复用
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_account_machine_name
  ON devices (account_id, machine_name)
  WHERE revoked_at IS NULL AND machine_name IS NOT NULL;
