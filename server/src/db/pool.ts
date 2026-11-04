import pg from 'pg';

export type DbPool = pg.Pool;

export interface PoolOptions {
  databaseUrl: string;
  maxConnections?: number;
  /** 空闲连接异常回调；默认写日志，不抛出（避免未处理 'error' 事件杀死进程）。 */
  onIdleError?: (error: Error) => void;
}

/**
 * 建立进程级连接池；连接串来自配置文件/环境变量，不在此处读取环境。
 *
 * 必须监听 pool 的 'error' 事件：数据库重启/网络中断时 pg 会在空闲连接上
 * 触发 'error'，没有监听器时 Node 会以未处理错误终止进程（T01 实测崩溃）。
 */
export function createPool(options: PoolOptions): DbPool {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const onIdleError =
    options.onIdleError ?? ((error: Error) => console.error(`[db] 空闲连接异常：${error.message}`));
  pool.on('error', onIdleError);

  return pool;
}
