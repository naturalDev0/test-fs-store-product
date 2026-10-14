import { pool, withTransaction } from '../db.js';
import { HttpError, PG, pgCode, pgConstraint } from '../errors.js';

export interface Order {
  id: number;
  userId: number;
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  status: string;
  createdAt: string;
}

export interface PurchaseResult {
  order: Order;
  /** True when this request repeated an idempotency key, so no new order was made. */
  replayed: boolean;
}

const ORDER_COLUMNS = `
  o.id, o.user_id AS "userId", o.product_id AS "productId", p.name AS "productName",
  o.quantity, o.unit_price_cents AS "unitPriceCents", o.total_cents AS "totalCents",
  o.status, o.created_at AS "createdAt"`;

/**
 * Buys `quantity` units of a product for a user, without ever overselling.
 *
 * HOW OVERSELLING IS PREVENTED
 *
 * The stock check and the stock decrement are ONE atomic SQL statement:
 *
 *   UPDATE products SET stock = stock - $qty
 *   WHERE id = $id AND is_active AND stock >= $qty
 *
 * A naive "SELECT stock, check it in JavaScript, then UPDATE" has a gap
 * between the read and the write. Two buyers can both read stock = 1, both
 * pass the check, and both decrement, selling 2 units of 1.
 *
 * The single UPDATE closes that gap. PostgreSQL takes a row lock on the
 * product before changing it, so concurrent buyers of the same product queue
 * up on that row. When a waiting UPDATE gets the lock, PostgreSQL re-checks
 * its WHERE clause against the latest committed row (READ COMMITTED
 * "re-check" behaviour). If the stock is now too low, the row no longer
 * matches, zero rows are updated, and we answer 409 instead of overselling.
 *
 * The stock decrement and the order insert share one transaction, so they
 * succeed or fail together: no stock lost without an order, no order without
 * stock. As a final safety net, the CHECK (stock >= 0) constraint makes the
 * database itself reject any negative stock.
 *
 * IDEMPOTENCY
 *
 * If the client sends an Idempotency-Key, a UNIQUE (user_id, idempotency_key)
 * constraint guarantees at most one order per key, even when two identical
 * requests race. The loser hits the unique violation, its whole transaction
 * (including its stock decrement) rolls back, and it returns the winner's
 * order instead.
 */
export async function purchase(
  userId: number,
  productId: number,
  quantity: number,
  idempotencyKey?: string,
): Promise<PurchaseResult> {
  // Fast path for a retry that arrives after the original request finished.
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { order: existing, replayed: true };
  }

  try {
    const order = await withTransaction(async (client) => {
      const decremented = await client.query<{ price_cents: number; name: string }>(
        `UPDATE products
            SET stock = stock - $2, updated_at = now()
          WHERE id = $1 AND is_active AND stock >= $2
          RETURNING price_cents, name`,
        [productId, quantity],
      );

      if (decremented.rowCount === 0) {
        // Nothing updated. Work out why, to return a useful error.
        // (This read is only for the message; it makes no decision about stock.)
        const { rows } = await client.query<{ stock: number; is_active: boolean }>(
          'SELECT stock, is_active FROM products WHERE id = $1',
          [productId],
        );
        const product = rows[0];
        if (!product || !product.is_active) {
          throw new HttpError(404, 'NOT_FOUND', 'Product not found');
        }
        throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for this purchase', {
          available: product.stock,
          requested: quantity,
        });
      }

      const { price_cents: unitPrice, name } = decremented.rows[0];
      const inserted = await client.query<{ id: number; created_at: string; status: string }>(
        `INSERT INTO orders (user_id, product_id, quantity, unit_price_cents, total_cents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, status, created_at`,
        [userId, productId, quantity, unitPrice, unitPrice * quantity, idempotencyKey ?? null],
      );

      const row = inserted.rows[0];
      return {
        id: row.id,
        userId,
        productId,
        productName: name,
        quantity,
        unitPriceCents: unitPrice,
        totalCents: unitPrice * quantity,
        status: row.status,
        createdAt: row.created_at,
      } satisfies Order;
    });

    return { order, replayed: false };
  } catch (err) {
    // Lost an idempotency race: another request with the same key committed
    // first. Our transaction (and its stock decrement) has rolled back.
    if (
      idempotencyKey &&
      pgCode(err) === PG.UNIQUE_VIOLATION &&
      pgConstraint(err) === 'orders_user_idempotency_uq'
    ) {
      const existing = await findByIdempotencyKey(userId, idempotencyKey);
      if (existing) return { order: existing, replayed: true };
    }
    throw err;
  }
}

async function findByIdempotencyKey(userId: number, key: string): Promise<Order | undefined> {
  const { rows } = await pool.query<Order>(
    `SELECT ${ORDER_COLUMNS}
       FROM orders o JOIN products p ON p.id = o.product_id
      WHERE o.user_id = $1 AND o.idempotency_key = $2`,
    [userId, key],
  );
  return rows[0];
}

export async function listOrders(filter: { userId?: number; limit?: number }): Promise<Order[]> {
  const params: unknown[] = [];
  let where = '';
  if (filter.userId !== undefined) {
    params.push(filter.userId);
    where = `WHERE o.user_id = $${params.length}`;
  }
  params.push(filter.limit ?? 100);
  const { rows } = await pool.query<Order & { userEmail?: string }>(
    `SELECT ${ORDER_COLUMNS}, u.email AS "userEmail"
       FROM orders o
       JOIN products p ON p.id = o.product_id
       JOIN users u ON u.id = o.user_id
       ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}
