import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { createProduct, createUser, ledgerMismatches, resetDb, startServer, stockOf, unitsSold } from './helpers.js';

/**
 * These tests fire many purchases at the same products at the same moment,
 * through the real HTTP API and a real PostgreSQL database, and check that
 * stock is never oversold, carts are all-or-nothing, and nothing deadlocks.
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

type Line = { productId: number; quantity: number };
const buy = (token: string, items: Line[], headers?: Record<string, string>) =>
  api.call('POST', '/orders', { token, body: { items }, headers });

const statusCounts = (results: { status: number }[]) =>
  results.reduce<Record<number, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});

describe('POST /api/orders under concurrency', () => {
  // Whatever each test did, the inventory ledger must still balance:
  // every product's stock equals the sum of its recorded movements.
  afterEach(async () => {
    expect(await ledgerMismatches()).toEqual([]);
  });

  it('sells exactly the available stock when 100 buyers race for 10 units', async () => {
    const productId = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 100 }, () => createUser()));

    const results = await Promise.all(buyers.map((b) => buy(b.token, [{ productId, quantity: 1 }])));

    expect(statusCounts(results)).toEqual({ 201: 10, 409: 90 });
    expect(await stockOf(productId)).toBe(0);
    expect(await unitsSold(productId)).toBe(10);
  });

  it('never oversells with multi-unit purchases (30 buyers x 3 units vs 10 in stock)', async () => {
    const productId = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 30 }, () => createUser()));

    const results = await Promise.all(buyers.map((b) => buy(b.token, [{ productId, quantity: 3 }])));

    // 3 + 3 + 3 = 9 units sold; the 1 unit left can't satisfy a 3-unit order.
    expect(statusCounts(results)).toEqual({ 201: 3, 409: 27 });
    expect(await stockOf(productId)).toBe(1);
    expect(await unitsSold(productId)).toBe(9);
  });

  it('keeps carts all-or-nothing under contention (50 carts of A+B; A has 30, B has 10)', async () => {
    const a = await createProduct(30);
    const b = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 50 }, () => createUser()));

    const results = await Promise.all(
      buyers.map((u) => buy(u.token, [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }])),
    );

    // B runs out after 10 carts. No buyer may end up with A but not B:
    // the 40 failed carts must have given their unit of A back.
    expect(statusCounts(results)).toEqual({ 201: 10, 409: 40 });
    expect(await unitsSold(a)).toBe(10);
    expect(await unitsSold(b)).toBe(10);
    expect(await stockOf(a)).toBe(20);
    expect(await stockOf(b)).toBe(0);
  });

  it('does not deadlock when carts list the same products in opposite orders', async () => {
    const a = await createProduct(100);
    const b = await createProduct(100);
    const buyers = await Promise.all(Array.from({ length: 40 }, () => createUser()));

    // Half the carts say [A, B], the other half [B, A]. Without a fixed lock
    // order these would deadlock (see the control experiment below).
    const results = await Promise.all(
      buyers.map((u, i) =>
        buy(
          u.token,
          i % 2 === 0
            ? [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }]
            : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }],
        ),
      ),
    );

    expect(statusCounts(results)).toEqual({ 201: 40 });
    expect(await stockOf(a)).toBe(60);
    expect(await stockOf(b)).toBe(60);
  });

  it('keeps stock + sold constant while purchases race with admin restocks', async () => {
    const productId = await createProduct(5);
    const admin = await createUser('admin');
    const buyers = await Promise.all(Array.from({ length: 50 }, () => createUser()));

    const purchases = buyers.map((u) => buy(u.token, [{ productId, quantity: 1 }]));
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

    // The ledger tells the same story, movement by movement: each one's
    // stock_after equals the previous stock_after plus its delta. A gap would
    // mean two writers interleaved without the row lock serialising them.
    const { rows } = await pool.query<{ delta: number; stock_after: number; reason: string }>(
      'SELECT delta, stock_after, reason FROM stock_movements WHERE product_id = $1 ORDER BY id',
      [productId],
    );
    let running = 0;
    for (const m of rows) {
      running += m.delta;
      expect(m.stock_after).toBe(running);
    }
    expect(rows.filter((m) => m.reason === 'purchase')).toHaveLength(sold);
    expect(rows.filter((m) => m.reason === 'restock')).toHaveLength(10);
  });

  it('creates exactly one order when the same request is retried concurrently (idempotency)', async () => {
    const a = await createProduct(10);
    const b = await createProduct(10);
    const buyer = await createUser();
    const headers = { 'Idempotency-Key': 'checkout-attempt-0001' };
    const cart = [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }];

    const results = await Promise.all(Array.from({ length: 20 }, () => buy(buyer.token, cart, headers)));

    expect(statusCounts(results)).toEqual({ 201: 1, 200: 19 });
    // Every response refers to the same single order.
    expect(new Set(results.map((r) => r.body.order.id)).size).toBe(1);
    expect(await stockOf(a)).toBe(8);
    expect(await stockOf(b)).toBe(9);
  });
});

/**
 * Control experiments: the same races against deliberately broken versions.
 * They show the tests above are capable of catching each bug, and that the
 * real implementation's design is what prevents it.
 */
describe('control experiments', () => {
  it('a naive read-then-write purchase oversells', async () => {
    const productId = await createProduct(10);
    const buyers = await Promise.all(Array.from({ length: 20 }, () => createUser()));

    async function naivePurchase(userId: number) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ stock: number; price_cents: number }>(
          'SELECT stock, price_cents FROM products WHERE id = $1',
          [productId],
        );
        if (rows[0].stock < 1) return client.query('ROLLBACK');
        // Real request handling takes time between the read and the write.
        await new Promise((r) => setTimeout(r, 5));
        await client.query('UPDATE products SET stock = $2 WHERE id = $1', [productId, rows[0].stock - 1]);
        const order = await client.query<{ id: number }>(
          'INSERT INTO orders (user_id, total_cents) VALUES ($1, $2) RETURNING id',
          [userId, rows[0].price_cents],
        );
        await client.query(
          'INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, line_total_cents) VALUES ($1, $2, 1, $3, $4)',
          [order.rows[0].id, productId, rows[0].price_cents, rows[0].price_cents],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    await Promise.all(buyers.map((b) => naivePurchase(b.id)));

    // More than 10 units sold from a stock of 10: every buyer read
    // stock = 10 before anyone wrote.
    expect(await unitsSold(productId)).toBeGreaterThan(10);
  });

  it('locking products in request order (instead of by id) deadlocks', async () => {
    const a = await createProduct(10);
    const b = await createProduct(10);

    // Lock rows in the order given, pausing between locks so the two
    // transactions overlap: one holds A and wants B, the other holds B and
    // wants A. PostgreSQL detects the cycle and aborts one of them.
    async function lockInGivenOrder(first: number, second: number) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [first]);
        await client.query('SELECT pg_sleep(0.2)');
        await client.query('UPDATE products SET stock = stock - 1 WHERE id = $1', [second]);
        await client.query('ROLLBACK');
        return 'ok';
      } catch (err) {
        await client.query('ROLLBACK');
        return (err as { code?: string }).code;
      } finally {
        client.release();
      }
    }

    const outcomes = await Promise.all([lockInGivenOrder(a, b), lockInGivenOrder(b, a)]);

    // 40P01 = deadlock_detected
    expect(outcomes).toContain('40P01');
  });
});
