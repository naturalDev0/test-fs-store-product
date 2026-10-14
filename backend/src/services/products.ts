import { pool } from '../db.js';
import { HttpError, PG, pgCode, notFound } from '../errors.js';

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `
  id, sku, name, description, price_cents AS "priceCents", stock,
  is_active AS "isActive", version, created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listProducts(opts: { includeInactive: boolean }): Promise<Product[]> {
  const { rows } = await pool.query<Product>(
    `SELECT ${COLUMNS} FROM products ${opts.includeInactive ? '' : 'WHERE is_active'} ORDER BY name, id`,
  );
  return rows;
}

export async function getProduct(id: number, opts: { includeInactive: boolean }): Promise<Product> {
  const { rows } = await pool.query<Product>(
    `SELECT ${COLUMNS} FROM products WHERE id = $1 ${opts.includeInactive ? '' : 'AND is_active'}`,
    [id],
  );
  if (!rows[0]) throw notFound('Product');
  return rows[0];
}

export interface NewProduct {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
}

export async function createProduct(input: NewProduct): Promise<Product> {
  try {
    const { rows } = await pool.query<Product>(
      `INSERT INTO products (sku, name, description, price_cents, stock)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [input.sku, input.name, input.description, input.priceCents, input.stock],
    );
    return rows[0];
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION) {
      throw new HttpError(409, 'DUPLICATE_SKU', `SKU "${input.sku}" already exists`);
    }
    throw err;
  }
}

export interface ProductEdit {
  name?: string;
  description?: string;
  priceCents?: number;
  isActive?: boolean;
}

/**
 * Edits catalogue fields with optimistic locking.
 *
 * The admin sends back the `version` they loaded. The UPDATE only applies if
 * nobody else has edited the product since; otherwise the admin gets a 409
 * and reloads, instead of silently overwriting a colleague's change.
 *
 * Stock is intentionally NOT editable here. Setting an absolute stock value
 * from a form would erase any purchases made since the form was loaded (a
 * "lost update"). Stock changes go through adjustStock, which applies a delta.
 */
export async function updateProduct(id: number, expectedVersion: number, edit: ProductEdit): Promise<Product> {
  const { rows } = await pool.query<Product>(
    `UPDATE products
        SET name        = COALESCE($3, name),
            description = COALESCE($4, description),
            price_cents = COALESCE($5, price_cents),
            is_active   = COALESCE($6, is_active),
            version     = version + 1,
            updated_at  = now()
      WHERE id = $1 AND version = $2
      RETURNING ${COLUMNS}`,
    [id, expectedVersion, edit.name ?? null, edit.description ?? null, edit.priceCents ?? null, edit.isActive ?? null],
  );
  if (rows[0]) return rows[0];

  // No row updated: either it doesn't exist, or the version moved on.
  const current = await pool.query<{ version: number }>('SELECT version FROM products WHERE id = $1', [id]);
  if (!current.rows[0]) throw notFound('Product');
  throw new HttpError(409, 'VERSION_CONFLICT', 'This product was changed by someone else. Reload and try again.', {
    currentVersion: current.rows[0].version,
  });
}

/**
 * Atomically adds (restock) or removes (write-off) stock.
 *
 * `stock = stock + delta` is evaluated by the database against the current
 * row, so it composes safely with concurrent purchases. A delta that would
 * take stock below zero violates the CHECK constraint and is rejected.
 */
export async function adjustStock(id: number, delta: number): Promise<Product> {
  try {
    const { rows } = await pool.query<Product>(
      `UPDATE products SET stock = stock + $2, updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, delta],
    );
    if (!rows[0]) throw notFound('Product');
    return rows[0];
  } catch (err) {
    if (pgCode(err) === PG.CHECK_VIOLATION) {
      throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Adjustment would make stock negative');
    }
    throw err;
  }
}

/**
 * "Delete" is a soft delete: the product is hidden from the storefront and
 * can no longer be bought, but past orders still reference it, so order
 * history stays intact.
 */
export async function deactivateProduct(id: number): Promise<void> {
  const { rowCount } = await pool.query(
    'UPDATE products SET is_active = FALSE, version = version + 1, updated_at = now() WHERE id = $1',
    [id],
  );
  if (rowCount === 0) throw notFound('Product');
}
