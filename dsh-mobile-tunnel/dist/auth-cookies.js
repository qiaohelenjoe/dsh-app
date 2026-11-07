import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
/**
 * DSH 桌面端每次启动都会生成一条新的认证 cookie。
 *
 * cookie 名是 `dsh-auth-<base64url(sha256(authority))>`，而 host 的监听端口是
 * 随机分配的（`server.listen(0)`），所以每次启动 authority 都不同、cookie 名也不同，
 * 旧记录永久留在 Chromium 的 `Network/Cookies` 里。累积到约 60 余条时 Cookie 请求头
 * 超过 Node 默认的 16 KB maxHeaderSize，宿主返回 431，桌面壳报
 * "desktop welcome: Web authentication failed" 并退出。
 *
 * 插件在 host 启动阶段清理这些旧记录：只删 `127.0.0.1` 下 name 以 `dsh-auth-` 开头的
 * 行。若此刻 Chromium 已经独占该库（只读都打不开），就安静跳过，不影响启动。
 */
const COOKIE_DB_SEGMENTS = ['@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies'];
const AUTH_COOKIE_WHERE = "host_key = '127.0.0.1' AND name LIKE 'dsh-auth-%'";
const require = createRequire(import.meta.url);
/** Chromium 的 cookie 库路径；非桌面端或平台不支持时返回 null。 */
export function authCookieDatabasePath() {
    const appdata = process.env.APPDATA;
    if (!appdata)
        return null;
    return join(appdata, ...COOKIE_DB_SEGMENTS);
}
function countRows(db) {
    const row = db.prepare(`SELECT count(*) AS n FROM cookies WHERE ${AUTH_COOKIE_WHERE}`).get();
    return typeof row?.n === 'number' ? row.n : 0;
}
/**
 * 清理累积的 dsh-auth-* cookie。
 * 任何异常都返回 skipped，绝不阻塞插件启动。
 */
export async function cleanupAuthCookies() {
    const path = authCookieDatabasePath();
    if (!path || !existsSync(path)) {
        return { status: 'unsupported', removed: 0, reason: 'cookie 库不存在（非桌面端？）' };
    }
    let db;
    try {
        // node:sqlite 是 Node 内置模块；用 createRequire 避免类型声明缺失时的编译问题。
        const sqlite = require('node:sqlite');
        db = new sqlite.DatabaseSync(path);
        const before = countRows(db);
        if (before === 0) {
            db.close();
            return { status: 'clean', removed: 0 };
        }
        db.exec(`DELETE FROM cookies WHERE ${AUTH_COOKIE_WHERE}`);
        db.exec('VACUUM');
        const after = countRows(db);
        db.close();
        return { status: 'cleaned', removed: before - after };
    }
    catch (error) {
        try {
            db?.close();
        }
        catch {
            // 忽略
        }
        return { status: 'skipped', removed: 0, reason: String(error?.message ?? error) };
    }
}
//# sourceMappingURL=auth-cookies.js.map