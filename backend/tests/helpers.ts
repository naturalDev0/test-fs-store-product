import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { signToken, type Role } from '../src/auth/tokens.js';

// Tests create users directly with a fixed hash: hashing a password per user
// would make creating 100 concurrent buyers needlessly slow.
const FIXED_HASH = '$2b$04$abcdefghijklmnopqrstuuK8V6Qx3XyQ6m9K3m0o6fB4oZ5h5Qa1e';

export async function resetDb() {
  await pool.query('TRUNCATE orders, products, users RESTART IDENTITY CASCADE');
}

export async function createUser(role: Role = 'customer') {
  const email = `${role}-${crypto.randomUUID()}@test.local`;
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [email, FIXED_HASH, role],
  );
  const id = rows[0].id;
  return { id, email, token: signToken(id, role) };
}

export async function createProduct(stock: number, priceCents = 1000) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO products (sku, name, price_cents, stock) VALUES ($1, 'Test product', $2, $3) RETURNING id`,
    [`SKU-${crypto.randomUUID()}`, priceCents, stock],
  );
  return rows[0].id;
}

export async function stockOf(productId: number): Promise<number> {
  const { rows } = await pool.query<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [productId]);
  return rows[0].stock;
}

export async function unitsSold(productId: number): Promise<number> {
  const { rows } = await pool.query<{ sold: number }>(
    'SELECT COALESCE(SUM(quantity), 0)::int AS sold FROM orders WHERE product_id = $1',
    [productId],
  );
  return rows[0].sold;
}

/**
 * Starts the app on a random port and returns a small fetch-based client.
 * A real HTTP server (rather than calling handlers directly) means concurrent
 * requests really do run concurrently through Express and the DB pool.
 */
export async function startServer() {
  const server: Server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  return {
    call,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
