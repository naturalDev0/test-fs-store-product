-- 004: record the currency of each order.
--
-- An amount without its currency is ambiguous, and the store's currency is a
-- setting (STORE_CURRENCY) that can change. Recording it on each order means
-- a past order keeps the currency it was paid in.
--
-- Orders placed before this migration were priced and shown in USD, so they
-- are backfilled as USD. The default is then dropped: new orders must state
-- their currency explicitly.
ALTER TABLE orders
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD'
    CONSTRAINT orders_currency_check CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE orders
  ALTER COLUMN currency DROP DEFAULT;
