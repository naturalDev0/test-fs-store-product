import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { createProduct, createUser, resetDb, startServer } from './helpers.js';

let api: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  api = await startServer();
});
beforeEach(resetDb);
afterAll(async () => {
  await api.close();
  await pool.end();
});

describe('inventory ledger', () => {
  it('records every kind of stock change with who made it and why', async () => {
    const admin = await createUser('admin');
    const buyer = await createUser();

    const created = await api.call('POST', '/admin/products', {
      token: admin.token,
      body: { sku: 'LEDGER-1', name: 'Lamp', priceCents: 1000, stock: 10 },
    });
    const id = created.body.product.id;
    await api.call('POST', '/orders', { token: buyer.token, body: { items: [{ productId: id, quantity: 3 }] } });
    await api.call('POST', `/admin/products/${id}/stock-adjustments`, {
      token: admin.token,
      body: { delta: 5, note: 'Supplier delivery' },
    });
    await api.call('POST', `/admin/products/${id}/stock-adjustments`, {
      token: admin.token,
      body: { delta: -2, note: 'Damaged in storage' },
    });

    const res = await api.call('GET', `/admin/products/${id}/stock-movements`, { token: admin.token });

    expect(res.status).toBe(200);
    // Newest first.
    expect(res.body.movements).toMatchObject([
      { reason: 'write_off', delta: -2, stockAfter: 10, note: 'Damaged in storage', actorEmail: admin.email },
      { reason: 'restock', delta: 5, stockAfter: 12, note: 'Supplier delivery', actorEmail: admin.email },
      { reason: 'purchase', delta: -3, stockAfter: 7, orderId: expect.any(Number), actorEmail: buyer.email },
      { reason: 'opening_balance', delta: 10, stockAfter: 10, actorEmail: admin.email },
    ]);
  });

  it('records nothing when a stock change is rejected', async () => {
    const admin = await createUser('admin');
    const buyer = await createUser();
    const productId = await createProduct(2);

    await api.call('POST', '/orders', { token: buyer.token, body: { items: [{ productId, quantity: 5 }] } });
    await api.call('POST', `/admin/products/${productId}/stock-adjustments`, { token: admin.token, body: { delta: -5 } });

    const { rows } = await pool.query('SELECT reason FROM stock_movements WHERE product_id = $1', [productId]);
    expect(rows).toEqual([{ reason: 'opening_balance' }]);
  });

  it('is append-only: history cannot be edited or deleted', async () => {
    const productId = await createProduct(5);

    await expect(pool.query('UPDATE stock_movements SET delta = 99 WHERE product_id = $1', [productId])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM stock_movements WHERE product_id = $1', [productId])).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects movements whose direction contradicts their reason', async () => {
    const productId = await createProduct(5);
    // A "restock" that removes stock is nonsense; the database refuses it.
    await expect(
      pool.query(
        `INSERT INTO stock_movements (product_id, delta, reason, stock_after) VALUES ($1, -1, 'restock', 4)`,
        [productId],
      ),
    ).rejects.toThrow(/stock_movements_reason_shape/);
  });

  it('reconciliation reports balanced books, and detects stock changed behind the ledger', async () => {
    const admin = await createUser('admin');
    const productId = await createProduct(5);

    const before = await api.call('GET', '/admin/inventory/reconciliation', { token: admin.token });
    expect(before.body).toMatchObject({ balanced: true, productsChecked: 1, mismatches: [] });

    // Someone edits stock directly in SQL, bypassing the application.
    await pool.query('UPDATE products SET stock = 50 WHERE id = $1', [productId]);

    const after = await api.call('GET', '/admin/inventory/reconciliation', { token: admin.token });
    expect(after.body.balanced).toBe(false);
    expect(after.body.mismatches).toEqual([
      { productId, sku: expect.any(String), stock: 50, ledgerStock: 5 },
    ]);
  });

  it('is admin-only', async () => {
    const customer = await createUser();
    const productId = await createProduct(5);
    expect((await api.call('GET', '/admin/inventory/reconciliation', { token: customer.token })).status).toBe(403);
    expect((await api.call('GET', `/admin/products/${productId}/stock-movements`, { token: customer.token })).status).toBe(403);
  });
});
