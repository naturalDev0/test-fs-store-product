import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = new URL('../db/migrations/', import.meta.url);

// Arbitrary constant: the key for a PostgreSQL advisory lock, so two
// deployments starting at once can't run the same migration twice.
const MIGRATION_LOCK_KEY = 7_428_301;

/**
 * Applies pending migrations from db/migrations, in filename order.
 *
 * Each migration runs in its own transaction together with the insert that
 * records it in schema_migrations, so a migration is either fully applied
 * and recorded, or not applied at all.
 */
export async function runMigrations(client: pg.ClientBase, log: (msg: string) => void = () => {}) {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;

      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      log(`Applied ${version}`);
      count++;
    }
    log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}

// When run directly: `npm run db:migrate`
// pathToFileURL makes the comparison work on Windows too (drive letters, backslashes, spaces).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pool } = await import('../src/db.js');
  const client = await pool.connect();
  try {
    await runMigrations(client, console.log);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
