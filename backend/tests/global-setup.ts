import { readFile } from 'node:fs/promises';
import pg from 'pg';

/** Rebuilds the test database schema from scratch once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/store_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS orders, products, users CASCADE;
      DROP TYPE IF EXISTS user_role, order_status;
    `);
    await client.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  } finally {
    await client.end();
  }
}
