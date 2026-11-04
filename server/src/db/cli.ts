import { loadDatabaseConfig } from '../config.js';
import { readSchemaState, runMigrations } from './migrate.js';
import { createPool } from './pool.js';

const command = process.argv[2];

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const pool = createPool({ databaseUrl: config.databaseUrl });

  try {
    if (command === 'migrate') {
      const result = await runMigrations(pool, config.migrationsDir);
      const applied = result.applied.join(', ') || '-';
      const skipped = result.skipped.join(', ') || '-';
      console.log(`迁移完成：applied=[${applied}] skipped=[${skipped}] current=${result.currentVersion}`);
      return;
    }

    if (command === 'version') {
      const state = await readSchemaState(pool, config.migrationsDir);
      console.log(
        `结构版本：current=${state.currentVersion ?? 'none'} expected=${state.expectedVersion ?? 'none'} ok=${state.ok}`,
      );
      if (!state.ok) {
        console.error(state.reason);
        process.exitCode = 1;
      }
      return;
    }

    console.error('用法：tsx src/db/cli.ts <migrate|version>');
    process.exitCode = 2;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
