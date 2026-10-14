import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listProducts, getProduct } from '../services/products.js';
import { listOrders, purchase } from '../services/purchase.js';
import * as schema from './schemas.js';

export const storefrontRouter = Router();

/** Public catalogue: active products only, no internal fields. */
storefrontRouter.get('/products', async (_req, res) => {
  const products = await listProducts({ includeInactive: false });
  res.json({ products: products.map(toPublic) });
});

storefrontRouter.get('/products/:id', async (req, res) => {
  const { id } = schema.idParam.parse(req.params);
  res.json({ product: toPublic(await getProduct(id, { includeInactive: false })) });
});

/**
 * Buy a product. Customers only.
 *
 * Optional `Idempotency-Key` header: retrying with the same key returns the
 * original order (200) instead of buying twice.
 */
storefrontRouter.post('/orders', requireAuth, requireRole('customer'), async (req, res) => {
  const { productId, quantity } = schema.purchase.parse(req.body);
  const key = schema.idempotencyKey.parse(req.get('Idempotency-Key'));

  const result = await purchase(req.user!.id, productId, quantity, key);
  res.status(result.replayed ? 200 : 201).json(result);
});

storefrontRouter.get('/orders/mine', requireAuth, async (req, res) => {
  res.json({ orders: await listOrders({ userId: req.user!.id }) });
});

function toPublic(p: Awaited<ReturnType<typeof getProduct>>) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    stock: p.stock,
  };
}
