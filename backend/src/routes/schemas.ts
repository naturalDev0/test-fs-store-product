import { z } from 'zod';

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const credentials = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const MAX_PRICE_CENTS = 100_000_000; // $1,000,000
const MAX_STOCK = 1_000_000;

export const createProduct = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  priceCents: z.number().int().min(0).max(MAX_PRICE_CENTS),
  stock: z.number().int().min(0).max(MAX_STOCK).default(0),
});

export const updateProduct = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    priceCents: z.number().int().min(0).max(MAX_PRICE_CENTS).optional(),
    isActive: z.boolean().optional(),
  })
  .strict(); // rejects `stock`: stock changes go through /stock-adjustments

export const stockAdjustment = z.object({
  delta: z
    .number()
    .int()
    .min(-MAX_STOCK)
    .max(MAX_STOCK)
    .refine((d) => d !== 0, 'delta must not be zero'),
  /** Why the stock changed, e.g. "Supplier delivery" or "Damaged in storage". */
  note: z.string().trim().max(500).default(''),
});

export const MAX_CART_LINES = 20;

export const purchase = z.object({
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1, 'The cart is empty')
    .max(MAX_CART_LINES, `A cart can hold at most ${MAX_CART_LINES} different products`)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      'Each product may appear only once; combine the quantities instead',
    ),
});

export const idempotencyKey = z.string().trim().min(8).max(128).optional();
