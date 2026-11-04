import pg from 'pg';

/**
 * 测试用管理员连接串：需要一个能 CREATE DATABASE 的角色。
 * 默认指向本地 docker 测试容器（端口 55432，见 server/README.md）。
 */
export const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:55432/postgres';

export interface TempDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建一个一次性数据库，供集成测试使用；测试结束必须调用 drop()。 */
export async function createTempDatabase(prefix = 'dsh_test'): Promise<TempDatabase> {
  const name = `${prefix}_${randomSuffix()}`;
  const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;

  return {
    name,
    url: url.toString(),
    async drop(): Promise<void> {
      const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
