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
    const res = await api.call('POST', '/orders', { token: admin.token, body: { productId, quantity: 1 } });
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
  it('snapshots the price at purchase time', async () => {
    const admin = await createUser('admin');
    const buyer = await createUser();
    const productId = await createProduct(5, 1000);

    await api.call('POST', '/orders', { token: buyer.token, body: { productId, quantity: 2 } });
    const { version } = (await api.call('GET', `/admin/products/${productId}`, { token: admin.token })).body.product;
    await api.call('PATCH', `/admin/products/${productId}`, { token: admin.token, body: { version, priceCents: 5000 } });

    const mine = await api.call('GET', '/orders/mine', { token: buyer.token });
    expect(mine.body.orders[0]).toMatchObject({ quantity: 2, unitPriceCents: 1000, totalCents: 2000 });
  });

  it('returns 409 with the available quantity when stock is insufficient', async () => {
    const buyer = await createUser();
    const productId = await createProduct(2);
    const res = await api.call('POST', '/orders', { token: buyer.token, body: { productId, quantity: 3 } });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ available: 2, requested: 3 });
  });

  it('validates quantity', async () => {
    const buyer = await createUser();
    const productId = await createProduct(2);
    for (const quantity of [0, -1, 1.5, 'two']) {
      const res = await api.call('POST', '/orders', { token: buyer.token, body: { productId, quantity } });
      expect(res.status).toBe(400);
    }
    expect(await stockOf(productId)).toBe(2);
  });
});
