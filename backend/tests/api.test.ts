import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { createProduct, createUser, resetDb, startServer, stockOf } from './helpers.js';

let api: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  api = await startServer();
});
beforeEach(resetDb);
afterAll(async () => {
  await api.close();
  await pool.end();
});

const newProduct = { sku: 'SKU-1', name: 'Widget', description: 'A widget', priceCents: 1999, stock: 5 };

describe('authentication', () => {
  it('registers a customer and logs in', async () => {
    const reg = await api.call('POST', '/auth/register', { body: { email: 'A@Example.com', password: 'password123' } });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ email: 'a@example.com', role: 'customer' });

    const login = await api.call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'password123' } });
    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));
  });

  it('rejects a duplicate email regardless of case', async () => {
    await api.call('POST', '/auth/register', { body: { email: 'dup@example.com', password: 'password123' } });
    const res = await api.call('POST', '/auth/register', { body: { email: 'DUP@example.com', password: 'password123' } });
    expect(res.status).toBe(409);
  });

  it('rejects a wrong password with a generic message', async () => {
    await api.call('POST', '/auth/register', { body: { email: 'b@example.com', password: 'password123' } });
    const res = await api.call('POST', '/auth/login', { body: { email: 'b@example.com', password: 'wrong-password' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects requests with a missing or tampered token', async () => {
    expect((await api.call('GET', '/auth/me')).status).toBe(401);
    expect((await api.call('GET', '/auth/me', { token: 'not.a.token' })).status).toBe(401);
  });

  it('applies a role change immediately, without waiting for the token to expire', async () => {
    const admin = await createUser('admin');
    expect((await api.call('GET', '/admin/products', { token: admin.token })).status).toBe(200);

    await pool.query(`UPDATE users SET role = 'customer' WHERE id = $1`, [admin.id]);
    expect((await api.call('GET', '/admin/products', { token: admin.token })).status).toBe(403);
  });
});

describe('role-based access control', () => {
  it('blocks anonymous users and customers from admin endpoints', async () => {
    const customer = await createUser('customer');
    const anon = await api.call('POST', '/admin/products', { body: newProduct });
    const cust = await api.call('POST', '/admin/products', { token: customer.token, body: newProduct });
    expect(anon.status).toBe(401);
    expect(cust.status).toBe(403);
  });

  it('only lets customers buy', async () => {
    const admin = await createUser('admin');
    const productId = await createProduct(5);
    const res = await api.call('POST', '/orders', { token: admin.token, body: { items: [{ productId, quantity: 1 }] } });
    expect(res.status).toBe(403);
    expect(await stockOf(productId)).toBe(5);
  });
});

describe('admin product CRUD', () => {
  it('creates, reads, updates and soft-deletes a product', async () => {
    const { token } = await createUser('admin');

    const created = await api.call('POST', '/admin/products', { token, body: newProduct });
    expect(created.status).toBe(201);
    const { id, version } = created.body.product;

    const updated = await api.call('PATCH', `/admin/products/${id}`, { token, body: { version, priceCents: 2499 } });
    expect(updated.status).toBe(200);
    expect(updated.body.product).toMatchObject({ priceCents: 2499, version: version + 1 });

    expect((await api.call('GET', '/products')).body.products).toHaveLength(1);
    expect((await api.call('DELETE', `/admin/products/${id}`, { token })).status).toBe(204);
    // Hidden from the storefront, still visible to admins.
    expect((await api.call('GET', '/products')).body.products).toHaveLength(0);
    expect((await api.call('GET', `/admin/products/${id}`, { token })).body.product.isActive).toBe(false);
  });

  it('rejects a duplicate SKU', async () => {
    const { token } = await createUser('admin');
    await api.call('POST', '/admin/products', { token, body: newProduct });
    const res = await api.call('POST', '/admin/products', { token, body: newProduct });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_SKU');
  });

  it('validates input', async () => {
    const { token } = await createUser('admin');
    const res = await api.call('POST', '/admin/products', { token, body: { ...newProduct, priceCents: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('detects conflicting edits with optimistic locking', async () => {
    const { token } = await createUser('admin');
    const { id, version } = (await api.call('POST', '/admin/products', { token, body: newProduct })).body.product;

    // Two admins load version 1, both save. The second save must not silently win.
    const first = await api.call('PATCH', `/admin/products/${id}`, { token, body: { version, name: 'First' } });
    const second = await api.call('PATCH', `/admin/products/${id}`, { token, body: { version, name: 'Second' } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('does not allow setting stock directly, only adjusting it', async () => {
    const { token } = await createUser('admin');
    const { id, version } = (await api.call('POST', '/admin/products', { token, body: newProduct })).body.product;

    const direct = await api.call('PATCH', `/admin/products/${id}`, { token, body: { version, stock: 100 } });
    expect(direct.status).toBe(400);

    const restock = await api.call('POST', `/admin/products/${id}/stock-adjustments`, { token, body: { delta: 10 } });
    expect(restock.body.product.stock).toBe(15);

    const tooMuch = await api.call('POST', `/admin/products/${id}/stock-adjustments`, { token, body: { delta: -100 } });
    expect(tooMuch.status).toBe(409);
    expect(await stockOf(id)).toBe(15);
  });
});

describe('purchasing', () => {
  type Line = { productId: number; quantity: number };
  const buy = (token: string, items: Line[], headers?: Record<string, string>) =>
    api.call('POST', '/orders', { token, body: { items }, headers });

  it('buys several products in one order, with line items and a total', async () => {
    const buyer = await createUser();
    const a = await createProduct(5, 1000);
    const b = await createProduct(5, 250);

    const res = await buy(buyer.token, [{ productId: b, quantity: 4 }, { productId: a, quantity: 2 }]);

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({
      totalCents: 3000,
      items: [
        { productId: a, quantity: 2, unitPriceCents: 1000, lineTotalCents: 2000 },
        { productId: b, quantity: 4, unitPriceCents: 250, lineTotalCents: 1000 },
      ],
    });
    expect(await stockOf(a)).toBe(3);
    expect(await stockOf(b)).toBe(1);
  });

  it('snapshots prices at purchase time', async () => {
    const admin = await createUser('admin');
    const buyer = await createUser();
    const productId = await createProduct(5, 1000);

    await buy(buyer.token, [{ productId, quantity: 2 }]);
    const { version } = (await api.call('GET', `/admin/products/${productId}`, { token: admin.token })).body.product;
    await api.call('PATCH', `/admin/products/${productId}`, { token: admin.token, body: { version, priceCents: 5000 } });

    const mine = await api.call('GET', '/orders/mine', { token: buyer.token });
    expect(mine.body.orders[0]).toMatchObject({
      totalCents: 2000,
      items: [{ quantity: 2, unitPriceCents: 1000, lineTotalCents: 2000 }],
    });
  });

  it('buys nothing if any line is short, and says which lines', async () => {
    const buyer = await createUser();
    const a = await createProduct(5);
    const b = await createProduct(1);

    const res = await buy(buyer.token, [{ productId: a, quantity: 2 }, { productId: b, quantity: 2 }]);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details.items).toEqual([
      { productId: b, name: 'Test product', requested: 2, available: 1 },
    ]);
    // The unit of A taken before B failed was given back.
    expect(await stockOf(a)).toBe(5);
    expect(await stockOf(b)).toBe(1);
    expect((await api.call('GET', '/orders/mine', { token: buyer.token })).body.orders).toEqual([]);
  });

  it('rejects carts containing deactivated or unknown products', async () => {
    const buyer = await createUser();
    const a = await createProduct(10);
    const b = await createProduct(10);
    await pool.query('UPDATE products SET is_active = FALSE WHERE id = $1', [b]);

    const res = await buy(buyer.token, [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: { productIds: [b] } });
    expect(await stockOf(a)).toBe(10);

    const unknown = await buy(buyer.token, [{ productId: 999_999, quantity: 1 }]);
    expect(unknown.body.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: { productIds: [999_999] } });
  });

  it('records the store currency on each order, and keeps it if the setting changes', async () => {
    const buyer = await createUser();
    const productId = await createProduct(5);

    expect((await api.call('GET', '/config')).body).toEqual({ currency: 'SGD', locale: 'en-SG' });
    const res = await buy(buyer.token, [{ productId, quantity: 1 }]);
    expect(res.body.order.currency).toBe('SGD');

    // Simulate an order placed while the store used another currency.
    await pool.query("UPDATE orders SET currency = 'USD' WHERE id = $1", [res.body.order.id]);
    await buy(buyer.token, [{ productId, quantity: 1 }]);

    const mine = await api.call('GET', '/orders/mine', { token: buyer.token });
    expect(mine.body.orders.map((o: { currency: string }) => o.currency)).toEqual(['SGD', 'USD']);
  });

  it('handles large orders without integer overflow', async () => {
    const buyer = await createUser();
    // $1,000,000 x 100 units = $100,000,000, beyond a 32-bit integer in cents.
    const productId = await createProduct(100, 100_000_000);
    const res = await buy(buyer.token, [{ productId, quantity: 100 }]);
    expect(res.status).toBe(201);
    expect(res.body.order.totalCents).toBe(10_000_000_000);
  });

  it('rejects an idempotency key reused for a different cart', async () => {
    const buyer = await createUser();
    const productId = await createProduct(10);
    const headers = { 'Idempotency-Key': 'checkout-attempt-0042' };

    expect((await buy(buyer.token, [{ productId, quantity: 1 }], headers)).status).toBe(201);
    const reused = await buy(buyer.token, [{ productId, quantity: 5 }], headers);

    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await stockOf(productId)).toBe(9);
  });

  it('validates the cart', async () => {
    const buyer = await createUser();
    const productId = await createProduct(2);
    const bad = [
      [], // empty
      [{ productId, quantity: 0 }],
      [{ productId, quantity: -1 }],
      [{ productId, quantity: 1.5 }],
      [{ productId, quantity: 'two' }],
      [{ productId, quantity: 1 }, { productId, quantity: 1 }], // duplicate product
      Array.from({ length: 21 }, (_, i) => ({ productId: i + 1, quantity: 1 })), // too many lines
    ];
    for (const items of bad) {
      const res = await api.call('POST', '/orders', { token: buyer.token, body: { items } });
      expect(res.status).toBe(400);
    }
    expect(await stockOf(productId)).toBe(2);
  });

  it('refuses, at the database level, an order whose total does not match its items', async () => {
    const buyer = await createUser();
    const productId = await createProduct(5, 1000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query<{ id: number }>(
        "INSERT INTO orders (user_id, total_cents, currency) VALUES ($1, 1, 'SGD') RETURNING id", // wrong: should be 1000
        [buyer.id],
      );
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, line_total_cents) VALUES ($1, $2, 1, 1000, 1000)',
        [order.rows[0].id, productId],
      );
      // The check is deferred, so it fires at COMMIT.
      await expect(client.query('COMMIT')).rejects.toThrow(/add up to 1000/);
    } finally {
      client.release();
    }
  });
});
