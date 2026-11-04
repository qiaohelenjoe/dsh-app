export function resolveDefaultCredentialPath(env = process.env) {
    const home = env.DSH_HOME?.trim();
    if (home)
        return `${home.replace(/[\\/]+$/, '')}/mobile-tunnel.json`;
    const userProfile = env.USERPROFILE ?? env.HOME ?? '.';
    return `${userProfile.replace(/[\\/]+$/, '')}/.dsh/mobile-tunnel.json`;
}
/** 面板会话文件：和凭据放同一目录，便于一起备份/迁移。 */
export function resolveDefaultPanelSessionPath(credentialPath) {
    const dir = credentialPath.replace(/[\\/][^\\/]*$/, '');
    return `${dir}/dsh-mobile-account-panel.json`;
}
export function defaultConfig(overrides = {}) {
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
//# sourceMappingURL=config.js.map