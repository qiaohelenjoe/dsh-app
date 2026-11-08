import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertSchemaVersion } from './db/migrate.js';
import { createPool } from './db/pool.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ databaseUrl: config.databaseUrl });

  try {
    const state = await assertSchemaVersion(pool, config.migrationsDir);
    console.log(`[startup] 数据库结构校验通过：current=${state.currentVersion} expected=${state.expectedVersion}`);
  } catch (error) {
    console.error(`[startup] 数据库结构校验失败：${(error as Error).message}`);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const app = buildApp({
    pool,
    migrationsDir: config.migrationsDir,
    authConfig: config.auth,
    apkDir: config.apkDir,
    allowTunnelBearer: config.allowTunnelBearer,
    tunnelOptions: {
      heartbeatSec: config.tunnel.heartbeatSec,
      offlineSec: config.tunnel.offlineSec,
      reconnectGraceSec: config.tunnel.reconnectGraceSec,
      seenThrottleSec: config.tunnel.seenThrottleSec,
    },
    logger: true,
  });

  const shutdown = (signal: string): void => {
    console.log(`[shutdown] 收到 ${signal}，正在关闭服务…`);
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('[shutdown] 关闭失败', error);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error('[fatal] 服务启动失败：', error);
  process.exitCode = 1;
});
