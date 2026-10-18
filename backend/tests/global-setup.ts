import pg from 'pg';
import { runMigrations } from '../scripts/migrate.js';

/** Rebuilds the test database from scratch, through the real migrations, once per test run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/store_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(client);
  } finally {
    await client.end();
  }
}
