import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { createProduct, createUser, resetDb, startServer, stockOf, unitsSold } from './helpers.js';

/**
 * These tests fire many purchases at the SAME product at the same moment,
 * through the real HTTP API and a real PostgreSQL database, and check that
 * stock is never oversold.
 */
let api: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  api = await startServer();
});
beforeEach(resetDb);
afterAll(async () => {
  await api.close();
  await pool.end();
});

const statusCounts = (results: { status: number }[]) =>
  results.reduce<Record<number, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});

describe('POST /api/orders under concurrency', () => {
  it('sells exactly the available stock when 100 buyers race for 10 units', async () => {
    const productId = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 100 }, () => createUser()));

    const results = await Promise.all(
      buyers.map((b) => api.call('POST', '/orders', { token: b.token, body: { productId, quantity: 1 } })),
    );

    expect(statusCounts(results)).toEqual({ 201: 10, 409: 90 });
    expect(await stockOf(productId)).toBe(0);
    expect(await unitsSold(productId)).toBe(10);
  });

  it('never oversells with multi-unit purchases (30 buyers x 3 units vs 10 in stock)', async () => {
    const productId = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 30 }, () => createUser()));

    const results = await Promise.all(
      buyers.map((b) => api.call('POST', '/orders', { token: b.token, body: { productId, quantity: 3 } })),
    );

    // 3 + 3 + 3 = 9 units sold; the 1 unit left can't satisfy a 3-unit order.
    expect(statusCounts(results)).toEqual({ 201: 3, 409: 27 });
    expect(await stockOf(productId)).toBe(1);
    expect(await unitsSold(productId)).toBe(9);
  });

  it('keeps stock + sold constant while purchases race with admin restocks', async () => {
    const productId = await createProduct(5);
    const admin = await createUser('admin');
    const buyers = await Promise.all(Array.from({ length: 50 }, () => createUser()));

    const purchases = buyers.map((b) =>
      api.call('POST', '/orders', { token: b.token, body: { productId, quantity: 1 } }),
    );
    const restocks = Array.from({ length: 10 }, () =>
      api.call('POST', `/admin/products/${productId}/stock-adjustments`, { token: admin.token, body: { delta: 2 } }),
    );
    const [purchaseResults, restockResults] = await Promise.all([Promise.all(purchases), Promise.all(restocks)]);

    expect(restockResults.every((r) => r.status === 200)).toBe(true);
    const sold = purchaseResults.filter((r) => r.status === 201).length;
    // Conservation: initial 5 + restocked 20 = units still in stock + units sold.
    expect((await stockOf(productId)) + sold).toBe(5 + 20);
    expect(await unitsSold(productId)).toBe(sold);
    expect(sold).toBeLessThanOrEqual(25);
  });

  it('creates exactly one order when the same request is retried concurrently (idempotency)', async () => {
    const productId = await createProduct(10);
    const buyer = await createUser();
    const headers = { 'Idempotency-Key': 'checkout-attempt-0001' };

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api.call('POST', '/orders', { token: buyer.token, headers, body: { productId, quantity: 2 } }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(19);
    // Every response refers to the same single order.
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(await stockOf(productId)).toBe(8);
    expect(await unitsSold(productId)).toBe(2);
  });

  it('rejects purchases of deactivated products', async () => {
    const productId = await createProduct(10);
    await pool.query('UPDATE products SET is_active = FALSE WHERE id = $1', [productId]);
    const buyer = await createUser();

    const res = await api.call('POST', '/orders', { token: buyer.token, body: { productId, quantity: 1 } });

    expect(res.status).toBe(404);
    expect(await stockOf(productId)).toBe(10);
  });
});

/**
 * A control experiment: the same race against a deliberately naive
 * "read stock, check in JavaScript, write new value" implementation.
 * It oversells, which shows the tests above are capable of catching the bug,
 * and that the atomic UPDATE is what prevents it.
 */
describe('control: naive read-then-write implementation', () => {
  async function naivePurchase(userId: number, productId: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ stock: number; price_cents: number }>(
        'SELECT stock, price_cents FROM products WHERE id = $1',
        [productId],
      );
      if (rows[0].stock < 1) {
        await client.query('ROLLBACK');
        return false;
      }
      // Real request handling (validation, logging, calls to other services)
      // takes time between the read and the write. Simulate a few ms of it.
      await new Promise((r) => setTimeout(r, 5));
      await client.query('UPDATE products SET stock = $2 WHERE id = $1', [productId, rows[0].stock - 1]);
      await client.query(
        'INSERT INTO orders (user_id, product_id, quantity, unit_price_cents, total_cents) VALUES ($1, $2, 1, $3, $3)',
        [userId, productId, rows[0].price_cents],
      );
      await client.query('COMMIT');
      return true;
    } finally {
      client.release();
    }
  }

  it('oversells: more orders are created than there were units in stock', async () => {
    const productId = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 20 }, () => createUser()));

    await Promise.all(buyers.map((b) => naivePurchase(b.id, productId)));

    // 20 orders for 10 units: every buyer read stock = 10 before anyone wrote.
    expect(await unitsSold(productId)).toBeGreaterThan(10);
  });
});
