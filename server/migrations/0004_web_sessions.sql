-- 0004_web_sessions.sql · PC 账号面板的“网页会话”不绑定设备
--
-- 背景：PC 端「移动端」面板只需要读账号信息和设备列表，不应该因为看一眼账号
-- 就登记一台设备（占设备名额、还会出现在手机端设备列表里）。
-- 网页会话因此允许 device_id 为空；其它客户端（手机/桌面隧道）的会话仍然绑定设备。
--
-- 幂等：列已经可空时重复执行无副作用。
ALTER TABLE sessions ALTER COLUMN device_id DROP NOT NULL;
