import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
/**
 * 文件凭据存储（默认实现）。
 * 生产环境建议替换为系统凭据管理器（Windows Credential Manager / Keychain / Secret Service）；
 * 接口保持不变，替换实现即可。
 */
export class FileCredentialStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    async load() {
        try {
            const raw = await readFile(this.filePath, 'utf8');
            return JSON.parse(raw);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    async save(credentials) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 });
        await chmod(this.filePath, 0o600).catch(() => undefined);
    }
    async clear() {
        await rm(this.filePath, { force: true });
    }
}
export class MemoryCredentialStore {
    value = null;
    async load() {
        return this.value;
    }
    async save(credentials) {
        this.value = credentials;
    }
    async clear() {
        this.value = null;
    }
}
//# sourceMappingURL=storage.js.map