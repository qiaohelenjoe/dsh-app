import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * PC 端「移动端」面板的登录会话。
 *
 * 面板运行在 DSH Web UI 里，而宿主端口每次启动随机分配（`server.listen(0)`），
 * 浏览器存储（sessionStorage / localStorage / Cookie）都以 origin 为界，
 * 所以会话必须落到宿主机文件里，才能真正做到「同一台电脑登录过就不再登录」。
 */
export interface PanelSession {
  accessToken: string;
  refreshToken: string;
  email: string;
}

export function isPanelSession(value: unknown): value is PanelSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.length > 0 &&
    typeof candidate.email === 'string' &&
    candidate.email.length > 0
  );
}

/** 文件会话存储：0600 权限，与隧道凭据同目录。 */
export class PanelSessionStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<PanelSession | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isPanelSession(parsed) ? parsed : null;
    } catch {
      // 文件不存在、内容损坏或权限不足：都按未登录处理，绝不因此阻塞面板
      return null;
    }
  }

  async save(session: PanelSession): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
