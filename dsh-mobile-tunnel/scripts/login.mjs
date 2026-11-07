#!/usr/bin/env node
/**
 * 兜底登录脚本：当 DSH 设置页「账号」卡片尚未挂载（宿主 API 未暴露）时，
 * 用插件导出的 TunnelAgent 直接完成设备码登录并把凭据写入 $DSH_HOME/mobile-tunnel.json。
 * 之后 DSH 加载插件时会 autostart 自动恢复隧道。
 *
 * 用法（需先 npm run build）：
 *   node scripts/login.mjs
 *   node scripts/login.mjs --server https://dsh.hbzxht.com --name "我的电脑"
 */
import { TunnelAgent } from '../dist/agent.js';
import { defaultConfig } from '../dist/config.js';
import { FileCredentialStore } from '../dist/storage.js';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const config = defaultConfig({
  serverBaseUrl: arg('--server', 'https://dsh.hbzxht.com'),
  deviceName: arg('--name', process.env.COMPUTERNAME ?? 'DSH Desktop'),
  dshBaseUrl: arg('--dsh', 'http://127.0.0.1:59025'),
});

const agent = new TunnelAgent(config, {
  store: new FileCredentialStore(config.credentialPath),
  log: (message) => console.log(message),
});

try {
  const state = await agent.login();
  console.log('登录完成：', JSON.stringify(state));
  console.log('凭据已写入：', config.credentialPath);
  console.log('可以关闭本窗口并重启 DSH；插件会自动恢复在线。');
} catch (error) {
  console.error('登录失败：', error?.message ?? error);
  process.exitCode = 1;
} finally {
  agent.stop();
}
