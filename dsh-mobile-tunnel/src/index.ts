import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TunnelAgent } from './agent.js';
import { cleanupAuthCookies } from './auth-cookies.js';
import { defaultConfig, type PluginConfig } from './config.js';
import { getHostService, type DshHostContext } from './host.js';
import { PanelSessionStore } from './panel-session.js';
import { registerPanelSessionRoutes } from './panel-session-routes.js';
import { renderAccountCardHtml } from './settings-card.js';
import { FileCredentialStore } from './storage.js';

export * from './auth.js';
export * from './dsh-credentials.js';
export * from './host.js';
export * from './panel-session.js';
export * from './panel-session-routes.js';
export * from './storage.js';
export * from './settings-card.js';
export * from './tunnel.js';
export { TunnelAgent };

export const name = 'dsh-mobile-tunnel';

/**
 * 注意：`ctx.connection` / `ctx.webServer` / `ctx.settings` / `ctx.ui` 都是宿主服务，
 * 未在插件的 `inject` 中声明时直接访问会抛 `cannot get property "xxx" without inject`。
 * 这些服务都是可选的，因此统一通过 `getHostService(ctx, name)`（免 inject 读取）读取；
 * 读不到时降级。
 */

interface ConnectionService {
  authenticatedUrl?: (base: string) => Promise<string> | string;
}

interface WebServerService {
  getOrigin?: () => string;
  origin?: string;
  protocol?: string;
  host?: string;
  port?: number;
}

interface SettingsService {
  registerCard?: (card: Record<string, unknown>) => unknown;
}

interface UiService {
  registerSlot?: (slot: Record<string, unknown>) => unknown;
}

/** 免 inject 读取宿主服务；不存在或宿主 API 不同都返回 undefined。 */
function log(ctx: DshHostContext, message: string): void {
  const logger = getHostService<(message: string) => void>(ctx, 'logger');
  if (typeof logger === 'function') {
    try {
      logger(message);
      return;
    } catch {
      // 落到 console
    }
  }
  console.log(message);
}

function detectDshBaseUrl(ctx: DshHostContext, fallback: string): string {
  // DSH 启动时会注入 DSH_WEB_URL（如 http://127.0.0.1:53722），最可靠；
  // 插件的 apply 可能早于 webServer 服务就绪，因此环境变量优先。
  const envOrigin = process.env.DSH_WEB_URL?.trim();
  if (envOrigin) return envOrigin.replace(/\/$/, '');
  const webServer = getHostService<WebServerService>(ctx, 'webServer');
  try {
    const origin = webServer?.getOrigin?.();
    if (typeof origin === 'string' && origin.length > 0) return origin;
    if (typeof webServer?.origin === 'string') return webServer.origin;
    if (typeof webServer?.port === 'number') {
      const protocol = webServer.protocol ?? 'http:';
      const host = webServer.host ?? '127.0.0.1';
      return `${protocol}//${host}:${webServer.port}`;
    }
  } catch {
    // 宿主 API 形状不同则回落
  }
  return fallback;
}

/**
 * 尝试从 DSH 宿主拿到一次性启动令牌（用于 /connect 换 Cookie）。
 * 优先使用 connection.authenticatedUrl；否则读取 DSH_LAUNCH_TOKEN 环境变量。
 * 两者都不可用时返回 null，插件会在代理请求时降级为无 Cookie（可能 401）。
 */
function detectLaunchToken(ctx: DshHostContext): () => Promise<string | null> {
  // 惰性获取：apply 执行时 connection 服务可能尚未就绪，每次换 Cookie 时再取。
  return async () => {
    const connection = getHostService<ConnectionService>(ctx, 'connection');
    if (connection?.authenticatedUrl) {
      try {
        const url = await connection.authenticatedUrl('http://127.0.0.1/');
        const token = new URL(url).searchParams.get('token');
        if (token) return token;
      } catch {
        // 继续尝试环境变量
      }
    }
    const envToken = process.env.DSH_LAUNCH_TOKEN?.trim();
    return envToken || null;
  };
}

function mountSettingsCard(ctx: DshHostContext, agent: TunnelAgent): void {
  const card = {
    id: 'dsh-mobile-account',
    title: '账号',
    render: (): string => renderAccountCardHtml(agent.getState()),
    actions: {
      login: (): Promise<unknown> => agent.login(),
      logout: (): Promise<void> => agent.logout(),
    },
  };
  try {
    const settings = getHostService<SettingsService>(ctx, 'settings');
    if (settings?.registerCard) {
      settings.registerCard(card);
      return;
    }
    const ui = getHostService<UiService>(ctx, 'ui');
    if (ui?.registerSlot) {
      ui.registerSlot({ slot: 'settings.account', ...card });
      return;
    }
  } catch (error) {
    log(ctx, `[dsh-mobile-tunnel] 设置卡片挂载失败：${(error as Error).message}`);
    return;
  }
  log(ctx, '[dsh-mobile-tunnel] 未检测到设置卡片 API；状态卡片暂记日志输出');
}

/**
 * Cordis 插件入口。宿主 API 随 DSH 版本变化，这里全部做特性检测 + 降级，
 * 真实设置页挂载需在真机（T11/交付验证）确认。
 */
export function apply(ctx: DshHostContext, config: Partial<PluginConfig> = {}): TunnelAgent {
  // 清理上一轮启动留下的 dsh-auth-* cookie：host 每次随机端口导致 cookie 名不同、
  // 旧记录永久累积，约 60 余条后撑爆 16 KB 请求头，桌面端报 Web authentication failed。
  // 此刻 Chromium 可能尚未独占 cookie 库；被占用则安静跳过，不阻塞启动。
  void cleanupAuthCookies()
    .then((result) => {
      if (result.status === 'cleaned') {
        log(ctx, `[dsh-mobile-tunnel] 已清理 ${result.removed} 条过期认证 cookie`);
      } else if (result.status === 'skipped') {
        log(ctx, `[dsh-mobile-tunnel] 认证 cookie 清理跳过：${result.reason ?? '未知原因'}`);
      }
    })
    .catch(() => {
      // 清理是尽力而为，失败不影响插件
    });

  const resolved = defaultConfig(config);
  const resolveDshBaseUrl = (): string => detectDshBaseUrl(ctx, resolved.dshBaseUrl);
  const dshBaseUrl = resolveDshBaseUrl();
  log(ctx, `[dsh-mobile-tunnel] 本地 DSH 地址：${dshBaseUrl}`);
  // PC 面板的登录会话落到宿主机文件：浏览器存储按 origin 隔离，而 DSH 每次启动端口随机，
  // 只有宿主机文件能让「同一台电脑登录过就不再登录」真正成立。
  // 面板的服务端地址/下载页地址都由配置下发，市场版换服务器只需改插件配置。
  const panelApiBase = resolved.serverBaseUrl.replace(/\/+$/, '');
  registerPanelSessionRoutes(
    ctx,
    new PanelSessionStore(resolved.panelSessionPath),
    { apiBase: panelApiBase, downloadUrl: `${panelApiBase}/download` },
    (message) => log(ctx, message),
  );
  if (process.env.DSH_MOBILE_TUNNEL_DEBUG === '1') {
    try {
      appendFileSync(
        join(tmpdir(), 'dsh-mobile-tunnel-debug.log'),
        `${new Date().toISOString()} apply: base=${dshBaseUrl} hasConnection=${Boolean(getHostService(ctx, 'connection'))} hasWebServer=${Boolean(getHostService(ctx, 'webServer'))}\n`,
      );
    } catch {
      // 忽略
    }
  }
  const launchToken = detectLaunchToken(ctx);
  const agent = new TunnelAgent(
    { ...resolved, dshBaseUrl, resolveDshBaseUrl, launchToken },
    {
      store: new FileCredentialStore(resolved.credentialPath),
      log: (message) => log(ctx, message),
    },
  );

  try {
    ctx.set?.('mobile-tunnel', agent);
  } catch {
    // 宿主没有 set API / 不允许写属性时忽略
  }
  mountSettingsCard(ctx, agent);
  try {
    ctx.on?.('dispose', () => agent.stop());
  } catch {
    // 忽略
  }
  void agent.autostart().catch((error: unknown) => {
    console.error('[dsh-mobile-tunnel] 自动恢复失败', error);
  });
  return agent;
}
