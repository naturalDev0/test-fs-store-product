import pg from 'pg';
import { config } from './config.js';

// BIGINT ids come back as strings by default (they can exceed JS's safe
// integer range). Our ids stay far below 2^53, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
});

export type Db = pg.Pool | pg.PoolClient;

/**
 * Runs `fn` inside a transaction on a dedicated connection.
 * Commits if `fn` resolves, rolls back if it throws.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
