import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';

/** Applies db/schema.sql. The file is idempotent, so this is safe to re-run. */
export async function migrate() {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => console.log('Schema applied.'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
