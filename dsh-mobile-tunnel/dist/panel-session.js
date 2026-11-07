import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
export function isPanelSession(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return (typeof candidate.accessToken === 'string' &&
        candidate.accessToken.length > 0 &&
        typeof candidate.refreshToken === 'string' &&
        candidate.refreshToken.length > 0 &&
        typeof candidate.email === 'string' &&
        candidate.email.length > 0);
}
/** 文件会话存储：0600 权限，与隧道凭据同目录。 */
export class PanelSessionStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    get path() {
        return this.filePath;
    }
    async load() {
        try {
            const raw = await readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return isPanelSession(parsed) ? parsed : null;
        }
        catch {
            // 文件不存在、内容损坏或权限不足：都按未登录处理，绝不因此阻塞面板
            return null;
        }
    }
    async save(session) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
        await chmod(this.filePath, 0o600).catch(() => undefined);
    }
    async clear() {
        await rm(this.filePath, { force: true });
    }
}
//# sourceMappingURL=panel-session.js.map