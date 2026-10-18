-- 002: inventory ledger.
--
-- products.stock says how many units there are. The ledger says WHY: every
-- change to stock (opening balance, purchase, restock, write-off) is
-- recorded as a movement, in the same transaction as the change itself.
--
-- Invariant, checked by GET /api/admin/inventory/reconciliation and the
-- test suite:
--     products.stock = SUM(stock_movements.delta) for that product

CREATE TYPE stock_movement_reason AS ENUM ('opening_balance', 'purchase', 'restock', 'write_off');

CREATE TABLE stock_movements (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    BIGINT                NOT NULL REFERENCES products (id),
  delta         INTEGER               NOT NULL CHECK (delta <> 0),
  reason        stock_movement_reason NOT NULL,
  -- Stock level right after this movement: lets anyone audit a product's
  -- history line by line without re-summing everything before it.
  stock_after   INTEGER               NOT NULL CHECK (stock_after >= 0),
  order_id      BIGINT                REFERENCES orders (id),
  -- Who made the change (the buyer for purchases, the admin otherwise).
  actor_user_id BIGINT                REFERENCES users (id),
  note          TEXT                  NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at    TIMESTAMPTZ           NOT NULL DEFAULT now(),

  -- Each reason has a fixed direction, and only purchases link to an order.
  CONSTRAINT stock_movements_reason_shape CHECK (
    CASE reason
      WHEN 'opening_balance' THEN delta > 0 AND order_id IS NULL
      WHEN 'purchase'        THEN delta < 0 AND order_id IS NOT NULL
      WHEN 'restock'         THEN delta > 0 AND order_id IS NULL
      WHEN 'write_off'       THEN delta < 0 AND order_id IS NULL
    END
  )
);

CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, id DESC);
CREATE INDEX stock_movements_order_idx   ON stock_movements (order_id) WHERE order_id IS NOT NULL;

-- Append-only, like an accounting ledger: history is never edited.
-- A mistake is fixed by recording a new, compensating movement.
CREATE FUNCTION stock_movements_forbid_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only; record a compensating movement instead';
END $$;

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_forbid_changes();

-- Backfill for databases that existed before the ledger: record current
-- stock as an opening balance, so the reconciliation invariant holds from
-- day one. (Purchases made before this point are not itemised in the ledger;
-- they remain visible in the orders table.)
INSERT INTO stock_movements (product_id, delta, reason, stock_after, note)
SELECT id, stock, 'opening_balance', stock, 'Opening balance recorded when the ledger was introduced'
  FROM products
 WHERE stock > 0;
