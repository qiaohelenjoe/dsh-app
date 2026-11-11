import Fastify, { type FastifyInstance } from 'fastify';
import { buildMailer, type Mailer } from './auth/mailer.js';
import { DeviceCodeService } from './auth/device-code.js';
import { AuthService } from './auth/service.js';
import type { AuthConfig } from './config.js';
import type { DbPool } from './db/pool.js';
import { DeviceService } from './devices/service.js';
import type { TunnelControl } from './devices/tunnel-hooks.js';
import { registerAccountRoutes } from './http/account-routes.js';
import { registerClientLogRoutes } from './http/client-log-routes.js';
import { createAuthGuard } from './http/auth-guard.js';
import { registerAuthRoutes } from './http/auth-routes.js';
import { registerDeviceCodeRoutes } from './http/device-code-routes.js';
import { registerDeviceRoutes } from './http/device-routes.js';
import { registerDownloadRoutes } from './http/download-routes.js';
import { registerWebLoginRoutes } from './http/web-login-routes.js';
import { registerErrorHandler } from './http/errors.js';
import { registerHealthRoutes } from './health.js';
import { registerProxyRoutes } from './http/proxy.js';
import { registerTunnelTicketRoutes } from './http/tunnel-ticket-routes.js';
import { RateLimiter } from './security/rate-limit.js';
import { TunnelRegistry, type TunnelRegistryOptions } from './tunnel/registry.js';
import { TunnelTicketStore } from './tunnel/tickets.js';
import { WsProxyServer } from './tunnel/ws-proxy.js';

export interface BuildAppOptions {
  pool: DbPool;
  migrationsDir: string;
  authConfig: AuthConfig;
  mailer?: Mailer;
  /** 覆盖设备撤销时的隧道钩子（缺省使用 TunnelRegistry）。 */
  tunnel?: TunnelControl;
  /** 复用外部创建的隧道注册表（测试用）；缺省由 buildApp 创建。 */
  tunnelRegistry?: TunnelRegistry;
  tunnelOptions?: Omit<TunnelRegistryOptions, 'pool' | 'jwtSecret'>;
  /** 一次性隧道票据存储（测试可注入缩短 TTL 的实例）；缺省新建或复用 registry 内的实例。 */
  tunnelTickets?: TunnelTicketStore;
  /** 手机 App 安装包目录（下载页）；缺省 /app/apk（容器挂载）。 */
  apkDir?: string;
  /** 兼容开关：允许旧版 Bearer 直接升级隧道（默认 false，生产用 ALLOW_TUNNEL_BEARER 打开）。 */
  allowTunnelBearer?: boolean;
  logger?: boolean;
}

/** 组装 Fastify 应用（不监听端口，便于测试用 app.inject）。 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);
  // 代理需要原样转发非 JSON 请求体（multipart/表单/二进制）
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  // 移动端账号面板运行在 DSH Web UI（127.0.0.1 动态端口），需要用 Bearer 直连 /v1 API。
  // 只对 /v1/* 开放 CORS；鉴权仍靠 Authorization 头，不依赖 Cookie。
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'authorization,content-type');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('access-control-max-age', '86400');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });

  const limiter = new RateLimiter();
  const guard = createAuthGuard({ pool: options.pool, jwtSecret: options.authConfig.jwtSecret });
  // 票据存储与 registry 共享：外部注入 registry 时复用它内部的实例，保证签发与消费一致
  const tunnelTickets = options.tunnelTickets ?? options.tunnelRegistry?.tickets ?? new TunnelTicketStore();
  const tunnelRegistry =
    options.tunnelRegistry ??
    new TunnelRegistry({
      pool: options.pool,
      jwtSecret: options.authConfig.jwtSecret,
      ...options.tunnelOptions,
      tickets: tunnelTickets,
      allowBearer: options.allowTunnelBearer ?? false,
    });
  tunnelRegistry.attach(app);
  const wsProxy = new WsProxyServer({
    pool: options.pool,
    jwtSecret: options.authConfig.jwtSecret,
    registry: tunnelRegistry,
  });
  app.addHook('preClose', async () => {
    wsProxy.close();
  });

  // 统一的 WebSocket 升级分发：/v1/tunnel（桌面端）与 /t/:deviceId/*（客户端 WS 代理）
  app.server.on('upgrade', (request, socket, head) => {
    const cookieHeader = request.headers.cookie ?? '';
    const pathname0 = new URL(request.url ?? '/', 'http://localhost').pathname;
    console.log('[ws-upgrade]', pathname0, 'ua=' + String(request.headers['user-agent'] ?? '').slice(0, 90), 'device-cookie=' + cookieHeader.includes('dsh_device='), 'access-cookie=' + cookieHeader.includes('dsh_access='));

    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/v1/tunnel') {
      void tunnelRegistry.handleUpgrade(request, socket, head);
      return;
    }
    if (pathname.startsWith('/t/') || (request.headers.cookie ?? '').includes('dsh_device=')) {
      void wsProxy.handleUpgrade(request, socket, head);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });

  const authService = new AuthService({
    pool: options.pool,
    config: options.authConfig,
    mailer: options.mailer ?? buildMailer(),
  });
  const deviceService = new DeviceService({
    pool: options.pool,
    tunnel: options.tunnel ?? tunnelRegistry,
    limiter: new RateLimiter(),
  });
  const deviceCodeService = new DeviceCodeService({ pool: options.pool, config: options.authConfig });

  registerHealthRoutes(app, { pool: options.pool, migrationsDir: options.migrationsDir });
  registerProxyRoutes(app, {
    pool: options.pool,
    jwtSecret: options.authConfig.jwtSecret,
    registry: tunnelRegistry,
  });
  registerAuthRoutes(app, { auth: authService, limiter, guard });
  registerWebLoginRoutes(app, { auth: authService, limiter, jwtSecret: options.authConfig.jwtSecret });
  registerTunnelTicketRoutes(app, { registry: tunnelRegistry, guard, pool: options.pool });
  registerAccountRoutes(app, { pool: options.pool, guard });
  registerClientLogRoutes(app, { pool: options.pool, guard, limiter });
  registerDownloadRoutes(app, { apkDir: options.apkDir ?? '/app/apk' });

  const clientLogCleanup = setInterval(() => {
    options.pool
      .query("DELETE FROM client_logs WHERE created_at < now() - interval '30 days'")
      .catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
  clientLogCleanup.unref?.();
  app.addHook('onClose', async () => clearInterval(clientLogCleanup));
  registerDeviceRoutes(app, { devices: deviceService, guard, auth: authService });
  registerDeviceCodeRoutes(app, {
    deviceCode: deviceCodeService,
    guard,
    config: options.authConfig,
  });

  return app;
}
