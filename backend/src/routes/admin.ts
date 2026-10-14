import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as products from '../services/products.js';
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
  res.status(201).json({ product: await products.createProduct(input) });
});

adminRouter.patch('/products/:id', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  const { version, ...edit } = schema.updateProduct.parse(req.body);
  res.json({ product: await products.updateProduct(id, version, edit) });
});

adminRouter.post('/products/:id/stock-adjustments', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  const { delta } = schema.stockAdjustment.parse(req.body);
  res.json({ product: await products.adjustStock(id, delta) });
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
