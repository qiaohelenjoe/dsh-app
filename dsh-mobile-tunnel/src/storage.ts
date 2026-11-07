import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredCredentials {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  signPublicKey: string;
  ecdhPublicKey: string;
  signPrivateKeyPem: string;
  ecdhPrivateKeyPem: string;
  accountEmail?: string;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials | null>;
  save(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

/**
 * 文件凭据存储（默认实现）。
 * 生产环境建议替换为系统凭据管理器（Windows Credential Manager / Keychain / Secret Service）；
 * 接口保持不变，替换实现即可。
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredCredentials | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as StoredCredentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private value: StoredCredentials | null = null;

  async load(): Promise<StoredCredentials | null> {
    return this.value;
  }

  async save(credentials: StoredCredentials): Promise<void> {
    this.value = credentials;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}
