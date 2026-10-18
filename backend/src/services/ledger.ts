import type pg from 'pg';
import { pool } from '../db.js';

export type MovementReason = 'opening_balance' | 'purchase' | 'restock' | 'write_off';

export interface NewMovement {
  productId: number;
  delta: number;
  reason: MovementReason;
  /** Stock level after this movement, taken from the UPDATE ... RETURNING that made it. */
  stockAfter: number;
  orderId?: number;
  actorUserId?: number;
  note?: string;
}

/**
 * Records a stock movement.
 *
 * Takes a transaction client, not the pool, on purpose: a movement must be
 * written in the SAME transaction as the stock change it describes, so the
 * two can never disagree (both commit or both roll back).
 */
export async function recordMovement(client: pg.PoolClient, m: NewMovement): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements (product_id, delta, reason, stock_after, order_id, actor_user_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [m.productId, m.delta, m.reason, m.stockAfter, m.orderId ?? null, m.actorUserId ?? null, m.note ?? ''],
  );
}

export interface Movement {
  id: number;
  productId: number;
  delta: number;
  reason: MovementReason;
  stockAfter: number;
  orderId: number | null;
  actorEmail: string | null;
  note: string;
  createdAt: string;
}

export async function listMovements(productId: number, limit = 100): Promise<Movement[]> {
  const { rows } = await pool.query<Movement>(
    `SELECT m.id, m.product_id AS "productId", m.delta, m.reason, m.stock_after AS "stockAfter",
            m.order_id AS "orderId", u.email AS "actorEmail", m.note, m.created_at AS "createdAt"
       FROM stock_movements m
       LEFT JOIN users u ON u.id = m.actor_user_id
      WHERE m.product_id = $1
      ORDER BY m.id DESC
      LIMIT $2`,
    [productId, limit],
  );
  return rows;
}

export interface ReconciliationMismatch {
  productId: number;
  sku: string;
  stock: number;
  ledgerStock: number;
}

/**
 * Compares every product's stock with the sum of its ledger movements.
 *
 * An empty result means the books balance. A mismatch means stock was
 * changed without a movement being recorded (for example, by someone
 * running SQL by hand), which an operator should investigate.
 */
export async function reconcile(): Promise<{ productsChecked: number; mismatches: ReconciliationMismatch[] }> {
  const { rows } = await pool.query<ReconciliationMismatch & { productsChecked: number }>(
    `SELECT p.id AS "productId", p.sku, p.stock,
            COALESCE(SUM(m.delta), 0)::int AS "ledgerStock",
            (COUNT(*) OVER ())::int AS "productsChecked"
       FROM products p
       LEFT JOIN stock_movements m ON m.product_id = p.id
      GROUP BY p.id
      ORDER BY p.id`,
  );
  return {
    productsChecked: rows[0]?.productsChecked ?? 0,
    mismatches: rows
      .filter((r) => r.stock !== r.ledgerStock)
      .map(({ productId, sku, stock, ledgerStock }) => ({ productId, sku, stock, ledgerStock })),
  };
}
