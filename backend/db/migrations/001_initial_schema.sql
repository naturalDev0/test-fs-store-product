-- 001: initial schema (PostgreSQL 14+).
--
-- Written idempotently (IF NOT EXISTS) so it also applies cleanly to
-- databases created before the migration runner existed.
--
-- Design rule: invariants that protect money and stock live in the database
-- (CHECK, UNIQUE, FOREIGN KEY), not only in application code. If a bug ever
-- slips past the API layer, the database still refuses the bad write.

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM ('completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          user_role   NOT NULL DEFAULT 'customer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "A@x.com" and "a@x.com" are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email));

CREATE TABLE IF NOT EXISTS products (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT        NOT NULL DEFAULT '',
  -- Money as integer cents: no floating-point rounding errors.
  price_cents INTEGER     NOT NULL CHECK (price_cents >= 0),
  -- Last line of defence against overselling: the database itself
  -- rejects any write that would make stock negative.
  stock       INTEGER     NOT NULL DEFAULT 0 CHECK (stock >= 0),
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Optimistic-locking counter for admin edits (name, price, description).
  -- Purchases deliberately do NOT bump it, so customers buying stock never
  -- cause an admin's edit form to fail with a conflict.
  version     INTEGER     NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT       NOT NULL REFERENCES users (id),
  product_id       BIGINT       NOT NULL REFERENCES products (id),
  quantity         INTEGER      NOT NULL CHECK (quantity > 0),
  -- Price snapshot at purchase time: later price edits never rewrite history.
  unit_price_cents INTEGER      NOT NULL CHECK (unit_price_cents >= 0),
  total_cents      INTEGER      NOT NULL CHECK (total_cents = unit_price_cents * quantity),
  status           order_status NOT NULL DEFAULT 'completed',
  -- Client-generated key so a retried request (double click, network retry)
  -- never creates a second order.
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT orders_user_idempotency_uq UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS orders_user_created_idx    ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_product_idx         ON orders (product_id);
CREATE INDEX IF NOT EXISTS products_active_name_idx   ON products (name) WHERE is_active;
