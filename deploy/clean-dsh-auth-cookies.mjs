#!/usr/bin/env node
/**
 * 清理 DSH 桌面端累积的 dsh-auth-* cookie。
 *
 * 背景：桌面端每次启动都会在 Chromium 的 cookie 库里新增一条
 * `dsh-auth-<random>`（host_key=127.0.0.1），且从不回收。累积到约 60 余条时，
 * Cookie 请求头会超过 Node 默认的 16 KB `maxHeaderSize`，宿主返回 431，
 * 桌面壳报 "desktop welcome: Web authentication failed" 并退出。
 *
 * 用法（实际清理前请先完全退出 DeepSeek Harness，含托盘图标）：
 *   node deploy/clean-dsh-auth-cookies.mjs --dry-run   # 只统计，不修改
 *   node deploy/clean-dsh-auth-cookies.mjs             # 备份后清理并 VACUUM
 *
 * 说明：只在 127.0.0.1 作用域下删除 name 以 dsh-auth- 开头的记录，
 * 其他站点与其他 cookie 一律不动。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const cookiesPath = join(
  process.env.APPDATA ?? '',
  '@deepseek-ai',
  'dsh-desktop',
  'Network',
  'Cookies',
);

if (!existsSync(cookiesPath)) {
  console.error(`找不到 cookie 库：${cookiesPath}`);
  process.exit(1);
}

// Chromium 在宿主运行期间独占该库（连只读打开都会失败），所以所有模式都要求先退出。
try {
  const list = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', {
    encoding: 'utf8',
  });
  if (list.includes('DeepSeek Harness.exe')) {
    console.error('DeepSeek Harness 仍在运行：cookie 库被 Chromium 独占，请先完全退出（含托盘图标）再执行。');
    process.exit(2);
  }
} catch {
  // tasklist 不可用时交给数据库锁判断
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(cookiesPath, { readOnly: dryRun });

const total = db.prepare('SELECT count(*) AS n FROM cookies').get();
const stale = db
  .prepare("SELECT count(*) AS n FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'")
  .get();

console.log(`cookie 库：${cookiesPath}`);
console.log(`cookie 总数：${total.n}`);
console.log(`127.0.0.1 下的 dsh-auth-*：${stale.n} 条`);

if (dryRun) {
  db.close();
  console.log('--dry-run：未做修改。');
  process.exit(0);
}

if (stale.n === 0) {
  db.close();
  console.log('无需清理。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${cookiesPath}.bak-${stamp}`;
copyFileSync(cookiesPath, backup);
console.log(`已备份：${backup}`);

db.exec("DELETE FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'");
db.exec('VACUUM');
const after = db
  .prepare("SELECT count(*) AS n FROM cookies WHERE host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'")
  .get();
db.close();
console.log(`清理完成，剩余 dsh-auth-*：${after.n} 条；当前库 ${statSync(cookiesPath).size} 字节。`);
