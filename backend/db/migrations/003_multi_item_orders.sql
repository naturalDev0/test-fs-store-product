-- 003: multi-item orders.
--
-- An order now has one or more line items. Existing single-product orders
-- are converted into an order with one line item, so no history is lost.

-- Totals are BIGINT: a 32-bit INTEGER tops out at about $21 million in
-- cents, which a large multi-item order could exceed.
CREATE TABLE order_items (
  order_id         BIGINT  NOT NULL REFERENCES orders (id),
  product_id       BIGINT  NOT NULL REFERENCES products (id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  -- Price snapshot at purchase time, as before.
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  -- Multiply as BIGINT so the check itself can't overflow.
  line_total_cents BIGINT  NOT NULL CHECK (line_total_cents = unit_price_cents::bigint * quantity),
  -- One line per product per order.
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX order_items_product_idx ON order_items (product_id);

-- Move existing orders' product data into line items.
INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, line_total_cents)
SELECT id, product_id, quantity, unit_price_cents, total_cents
  FROM orders;

-- These columns now live on order_items. Dropping them also drops the
-- constraints and index that referred to them.
ALTER TABLE orders
  DROP COLUMN product_id,
  DROP COLUMN quantity,
  DROP COLUMN unit_price_cents;

ALTER TABLE orders
  ALTER COLUMN total_cents TYPE BIGINT,
  ADD CONSTRAINT orders_total_cents_check CHECK (total_cents >= 0);

-- An order's total must equal the sum of its line items, and an order must
-- have at least one item. A plain CHECK can't look across two tables, so
-- this is a constraint trigger.
--
-- It is DEFERRED to commit time on purpose: the order row and its items are
-- inserted by separate statements, so the check has to wait until all of
-- them exist. If the totals don't match, the whole transaction is rejected.
CREATE FUNCTION orders_check_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id    BIGINT;
  v_total       BIGINT;
  v_items_total BIGINT;
  v_item_count  INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    v_order_id := NEW.id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  SELECT total_cents INTO v_total FROM orders WHERE id = v_order_id;
  SELECT COALESCE(SUM(line_total_cents), 0), COUNT(*)
    INTO v_items_total, v_item_count
    FROM order_items WHERE order_id = v_order_id;

  IF v_item_count = 0 OR v_total <> v_items_total THEN
    RAISE EXCEPTION 'order % has total % but its % item(s) add up to %',
      v_order_id, v_total, v_item_count, v_items_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_total_matches_items';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER orders_total_matches_items
  AFTER INSERT OR UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orders_check_total();

CREATE CONSTRAINT TRIGGER order_items_total_matches_order
  AFTER INSERT OR UPDATE ON order_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orders_check_total();
