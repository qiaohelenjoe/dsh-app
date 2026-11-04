import { fileURLToPath } from 'node:url';
import { defaultMigrationsDir } from './db/migrate.js';

export interface AuthConfig {
  jwtSecret: string;
  refreshPepper: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  emailVerificationEnabled: boolean;
  weakPasswordListPath: string;
  publicBaseUrl: string;
  /** 设备码轮询最小间隔（秒），0 表示不限速 */
  deviceCodePollIntervalSeconds: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  migrationsDir: string;
  /** 手机 App 安装包目录（下载页 / APK 文件） */
  apkDir: string;
  auth: AuthConfig;
  /** 兼容开关：允许旧版 Bearer 直接升级隧道（默认 false，仅灰度回滚时打开）。 */
  allowTunnelBearer: boolean;
}

export function defaultWeakPasswordListPath(): string {
  return fileURLToPath(new URL('../data/weak-passwords.txt', import.meta.url));
}

export interface DatabaseConfig {
  databaseUrl: string;
  migrationsDir: string;
}

/** 只读取数据库相关配置：迁移 CLI 等工具不需要认证密钥。 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('环境变量 DATABASE_URL 未设置');
  return {
    databaseUrl,
    migrationsDir: env.MIGRATIONS_DIR?.trim() || defaultMigrationsDir(),
  };
}

/** 从环境变量读取服务配置；缺失或非法时直接抛出，避免带病启动。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('环境变量 DATABASE_URL 未设置');

  const jwtSecret = env.AUTH_JWT_SECRET?.trim();
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('环境变量 AUTH_JWT_SECRET 未设置或长度不足 32 位');
  }
  const refreshPepper = env.AUTH_REFRESH_PEPPER?.trim();
  if (!refreshPepper || refreshPepper.length < 16) {
    throw new Error('环境变量 AUTH_REFRESH_PEPPER 未设置或长度不足 16 位');
  }

  const rawPort = env.PORT ?? '8787';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`环境变量 PORT 非法：${rawPort}`);
  }

  const accessTokenTtlSeconds = Number(env.ACCESS_TOKEN_TTL_SECONDS ?? '900');
  if (!Number.isInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds <= 0) {
    throw new Error(`环境变量 ACCESS_TOKEN_TTL_SECONDS 非法：${env.ACCESS_TOKEN_TTL_SECONDS}`);
  }

  const refreshTokenTtlDays = Number(env.REFRESH_TOKEN_TTL_DAYS ?? '30');
  if (!Number.isInteger(refreshTokenTtlDays) || refreshTokenTtlDays <= 0) {
    throw new Error(`环境变量 REFRESH_TOKEN_TTL_DAYS 非法：${env.REFRESH_TOKEN_TTL_DAYS}`);
  }

  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    databaseUrl,
    migrationsDir: env.MIGRATIONS_DIR?.trim() || defaultMigrationsDir(),
    apkDir: env.APK_DIR?.trim() || '/app/apk',
    allowTunnelBearer: env.ALLOW_TUNNEL_BEARER === 'true',
    auth: {
      jwtSecret,
      refreshPepper,
      accessTokenTtlSeconds,
      refreshTokenTtlDays,
      emailVerificationEnabled: env.EMAIL_VERIFICATION_ENABLED === 'true',
      weakPasswordListPath: env.WEAK_PASSWORD_LIST_PATH?.trim() || defaultWeakPasswordListPath(),
      publicBaseUrl: env.PUBLIC_BASE_URL?.trim() || 'http://127.0.0.1:8787',
      deviceCodePollIntervalSeconds: Number(env.DEVICE_CODE_POLL_INTERVAL_SECONDS ?? '2'),
    },
  };
}
