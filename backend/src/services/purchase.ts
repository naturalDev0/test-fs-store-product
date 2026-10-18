import type pg from 'pg';
import { pool, withTransaction } from '../db.js';
import { HttpError, PG, pgCode, pgConstraint } from '../errors.js';
import { recordMovement } from './ledger.js';

export interface CartLine {
  productId: number;
  quantity: number;
}

export interface OrderItem {
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: number;
  userId: number;
  userEmail: string;
  status: string;
  totalCents: number;
  createdAt: string;
  items: OrderItem[];
}

export interface PurchaseResult {
  order: Order;
  /** True when this request repeated an idempotency key, so no new order was made. */
  replayed: boolean;
}

/** Thrown inside the transaction when a line can't be fulfilled; triggers rollback. */
class LineUnavailable extends Error {}

/**
 * Buys every line in the cart, all or nothing, without ever overselling.
 *
 * 1. NO OVERSELLING. For each line, the stock check and the decrement are
 *    ONE atomic statement:
 *
 *      UPDATE products SET stock = stock - $qty
 *      WHERE id = $id AND is_active AND stock >= $qty
 *
 *    PostgreSQL locks the row before changing it, so concurrent buyers of a
 *    product queue up. When a waiting UPDATE gets the lock, PostgreSQL
 *    re-checks the WHERE clause against the latest committed stock. If it's
 *    now too low, zero rows match and nothing is sold. There is no gap
 *    between "check" and "act" for another buyer to slip into.
 *
 * 2. ALL OR NOTHING. All lines, the order, its items and the ledger entries
 *    share one transaction. If any line can't be fulfilled, the transaction
 *    rolls back and the stock already taken for earlier lines is restored.
 *
 * 3. NO DEADLOCKS. A transaction keeps each row lock until it commits, so a
 *    cart holds several locks at once. If one buyer locked A then B while
 *    another locked B then A, each would wait for the other forever (a
 *    deadlock; PostgreSQL would abort one of them after a second). So lines
 *    are always processed in ascending product id order: every transaction
 *    takes its locks in the same global order, and a cycle of waiting is
 *    impossible.
 *
 * 4. NO DOUBLE ORDERS. With an Idempotency-Key, the UNIQUE (user_id,
 *    idempotency_key) constraint guarantees at most one order per key, even
 *    when two identical requests race. The loser's transaction (including its
 *    stock decrements) rolls back, and it returns the winner's order.
 *
 * As safety nets, the database rejects negative stock (CHECK), an order whose
 * total doesn't match its items (deferred constraint trigger), and stock
 * movements that contradict their reason.
 */
export async function purchase(userId: number, cart: CartLine[], idempotencyKey?: string): Promise<PurchaseResult> {
  // Same global lock order for every transaction: see point 3 above.
  const lines = [...cart].sort((a, b) => a.productId - b.productId);

  if (idempotencyKey) {
    const existing = await findOrderByIdempotencyKey(userId, idempotencyKey);
    if (existing) return replay(existing, lines);
  }

  try {
    const orderId = await withTransaction(async (client) => {
      const taken: { line: CartLine; unitPrice: number; stockAfter: number }[] = [];

      for (const line of lines) {
        const { rows } = await client.query<{ price_cents: number; stock: number }>(
          `UPDATE products
              SET stock = stock - $2, updated_at = now()
            WHERE id = $1 AND is_active AND stock >= $2
            RETURNING price_cents, stock`,
          [line.productId, line.quantity],
        );
        if (!rows[0]) throw new LineUnavailable();
        taken.push({ line, unitPrice: rows[0].price_cents, stockAfter: rows[0].stock });
      }

      const total = taken.reduce((sum, t) => sum + t.unitPrice * t.line.quantity, 0);
      const order = await client.query<{ id: number }>(
        `INSERT INTO orders (user_id, total_cents, idempotency_key) VALUES ($1, $2, $3) RETURNING id`,
        [userId, total, idempotencyKey ?? null],
      );
      const orderId = order.rows[0].id;

      // All line items in one statement.
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, line_total_cents)
         SELECT $1, product_id, quantity, unit_price, unit_price::bigint * quantity
           FROM unnest($2::bigint[], $3::int[], $4::int[]) AS t(product_id, quantity, unit_price)`,
        [orderId, taken.map((t) => t.line.productId), taken.map((t) => t.line.quantity), taken.map((t) => t.unitPrice)],
      );

      for (const t of taken) {
        await recordMovement(client, {
          productId: t.line.productId,
          delta: -t.line.quantity,
          reason: 'purchase',
          stockAfter: t.stockAfter,
          orderId,
          actorUserId: userId,
        });
      }
      return orderId;
    });

    return { order: (await findOrders({ orderId }))[0], replayed: false };
  } catch (err) {
    if (err instanceof LineUnavailable) throw await explainUnavailable(lines);

    // Lost an idempotency race: another request with the same key committed
    // first. Our transaction (and its stock decrements) has rolled back.
    if (
      idempotencyKey &&
      pgCode(err) === PG.UNIQUE_VIOLATION &&
      pgConstraint(err) === 'orders_user_idempotency_uq'
    ) {
      const existing = await findOrderByIdempotencyKey(userId, idempotencyKey);
      if (existing) return replay(existing, lines);
    }
    throw err;
  }
}

/**
 * Returns the original order for a repeated idempotency key, but only if the
 * request is the same one. Reusing a key for a DIFFERENT cart is a client bug,
 * and silently returning the old order would hide it.
 */
function replay(existing: Order, lines: CartLine[]): PurchaseResult {
  const same =
    existing.items.length === lines.length &&
    existing.items.every((item, i) => item.productId === lines[i].productId && item.quantity === lines[i].quantity);
  if (!same) {
    throw new HttpError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different purchase. Use a new key for a new purchase.',
    );
  }
  return { order: existing, replayed: true };
}

/**
 * Builds a helpful error after the purchase has rolled back.
 *
 * This read happens outside the transaction and decides nothing about stock;
 * it only explains to the customer which items are the problem. Stock may
 * have changed again since, which is fine for a message.
 */
async function explainUnavailable(lines: CartLine[]): Promise<HttpError> {
  const { rows } = await pool.query<{ id: number; name: string; stock: number; is_active: boolean }>(
    'SELECT id, name, stock, is_active FROM products WHERE id = ANY($1::bigint[])',
    [lines.map((l) => l.productId)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const unavailable = lines.filter((l) => !byId.get(l.productId)?.is_active).map((l) => l.productId);
  if (unavailable.length) {
    return new HttpError(409, 'PRODUCT_UNAVAILABLE', 'Some products in your cart are no longer available', {
      productIds: unavailable,
    });
  }

  const short = lines
    .map((l) => ({ ...l, product: byId.get(l.productId)! }))
    .filter(({ quantity, product }) => product.stock < quantity)
    .map(({ productId, quantity, product }) => ({
      productId,
      name: product.name,
      requested: quantity,
      available: product.stock,
    }));
  return new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for some items in your cart', { items: short });
}

async function findOrderByIdempotencyKey(userId: number, key: string): Promise<Order | undefined> {
  return (await findOrders({ userId, idempotencyKey: key }))[0];
}

/** Orders with their line items, newest first. */
export async function findOrders(
  filter: { orderId?: number; userId?: number; idempotencyKey?: string; limit?: number },
  db: pg.Pool | pg.PoolClient = pool,
): Promise<Order[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.orderId !== undefined) add('o.id = ?', filter.orderId);
  if (filter.userId !== undefined) add('o.user_id = ?', filter.userId);
  if (filter.idempotencyKey !== undefined) add('o.idempotency_key = ?', filter.idempotencyKey);
  params.push(filter.limit ?? 100);

  const { rows } = await db.query<Order>(
    `SELECT o.id, o.user_id AS "userId", u.email AS "userEmail", o.status,
            o.total_cents AS "totalCents", o.created_at AS "createdAt",
            json_agg(json_build_object(
              'productId', i.product_id,
              'productName', p.name,
              'quantity', i.quantity,
              'unitPriceCents', i.unit_price_cents,
              'lineTotalCents', i.line_total_cents
            ) ORDER BY i.product_id) AS items
       FROM orders o
       JOIN users u       ON u.id = o.user_id
       JOIN order_items i ON i.order_id = o.id
       JOIN products p    ON p.id = i.product_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY o.id, u.email
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}
