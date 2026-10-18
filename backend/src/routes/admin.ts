import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as products from '../services/products.js';
import * as ledger from '../services/ledger.js';
import { listOrders } from '../services/purchase.js';
import * as schema from './schemas.js';

/** Every route here requires an authenticated admin. */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

adminRouter.get('/products', async (_req, res) => {
  res.json({ products: await products.listProducts({ includeInactive: true }) });
});

adminRouter.get('/products/:id', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  res.json({ product: await products.getProduct(id, { includeInactive: true }) });
});

adminRouter.post('/products', async (req, res) => {
  const input = schema.createProduct.parse(req.body);
  res.status(201).json({ product: await products.createProduct(input, req.user!.id) });
});

adminRouter.patch('/products/:id', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  const { version, ...edit } = schema.updateProduct.parse(req.body);
  res.json({ product: await products.updateProduct(id, version, edit) });
});

adminRouter.post('/products/:id/stock-adjustments', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  const { delta, note } = schema.stockAdjustment.parse(req.body);
  res.json({ product: await products.adjustStock(id, delta, req.user!.id, note) });
});

/** The product's stock history, newest first. */
adminRouter.get('/products/:id/stock-movements', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  await products.getProduct(id, { includeInactive: true }); // 404 if missing
  res.json({ movements: await ledger.listMovements(id) });
});

/** Checks that every product's stock equals the sum of its ledger movements. */
adminRouter.get('/inventory/reconciliation', async (_req, res) => {
  const result = await ledger.reconcile();
  res.json({ balanced: result.mismatches.length === 0, ...result });
});

/** Soft delete: see deactivateProduct. */
adminRouter.delete('/products/:id', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  await products.deactivateProduct(id);
  res.status(204).end();
});

adminRouter.get('/orders', async (_req, res) => {
  res.json({ orders: await listOrders({}) });
});
