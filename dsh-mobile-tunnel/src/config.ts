export interface PluginConfig {
  /** 账号平台服务端地址（https） */
  serverBaseUrl: string;
  /** 本机 DSH Web 服务地址（仅回环） */
  dshBaseUrl: string;
  /** 惰性解析本机 DSH 地址（插件启动后端口可能变化） */
  resolveDshBaseUrl?: () => string;
  /** 登记到账号下的设备名 */
  deviceName: string;
  platform: 'win32' | 'darwin' | 'linux';
  /** 凭据文件路径（默认 $DSH_HOME/mobile-tunnel.json 或 ~/.dsh/mobile-tunnel.json） */
  credentialPath: string;
  /** PC 面板登录会话文件路径（默认与凭据同目录的 dsh-mobile-account-panel.json） */
  panelSessionPath: string;
  /** 本机 DSH 启动令牌提供者（用于 /connect 换取 Cookie） */
  launchToken?: () => Promise<string | null>;
}

export function resolveDefaultCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim();
  if (home) return `${home.replace(/[\\/]+$/, '')}/mobile-tunnel.json`;
  const userProfile = env.USERPROFILE ?? env.HOME ?? '.';
  return `${userProfile.replace(/[\\/]+$/, '')}/.dsh/mobile-tunnel.json`;
}

/** 面板会话文件：和凭据放同一目录，便于一起备份/迁移。 */
export function resolveDefaultPanelSessionPath(credentialPath: string): string {
  const dir = credentialPath.replace(/[\\/][^\\/]*$/, '');
  return `${dir}/dsh-mobile-account-panel.json`;
}

export function defaultConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  const credentialPath = resolveDefaultCredentialPath();
  return {
    serverBaseUrl: 'https://dsh.hbzxht.com',
    dshBaseUrl: 'http://127.0.0.1:59025',
    deviceName: process.env.COMPUTERNAME ?? 'DSH Desktop',
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    credentialPath,
    panelSessionPath: resolveDefaultPanelSessionPath(credentialPath),
    ...overrides,
  };
}
