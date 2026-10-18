# Product Store

A full-stack product management application:

- **Backend API:** Express + TypeScript + PostgreSQL, with role-based access control
- **Admin dashboard:** create, edit, restock and remove products; see each product's stock history; check that inventory reconciles; view all orders
- **Storefront:** customers browse products, build a cart and check out

Checkout is safe under concurrency. It never oversells, a cart is bought completely or not at all, carts can't deadlock each other, and every unit of stock is accounted for in an append-only ledger. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the schema, the concurrency strategy, and the trade-offs.

## Run it locally

Requirements: Node.js 22+ and PostgreSQL 14+ (or Docker).

```bash
# 1. Start PostgreSQL (creates the `store` and `store_test` databases)
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run db:seed      # applies migrations and adds demo users and products
npm run dev          # API on http://localhost:4000

# 3. Frontend (in a second terminal)
cd frontend
npm install
npm run dev          # app on http://localhost:5173
```

- **Windows (Git Bash):** if `docker compose` isn't recognised, use `docker-compose up -d`.
- **Not using Docker?** Create the `store` and `store_test` databases in your own PostgreSQL and update the URLs in `backend/.env`.
- **Currency and locale:** two independent settings in `backend/.env`. `STORE_CURRENCY` (`SGD` by default, or `USD`) is the money prices are charged in, and decides the symbol (`S$`, `US$`). `STORE_LOCALE` (`en-SG` by default) is the language and number format. Restart the backend after changing them. Each order keeps the currency it was placed in.
- **Already ran an earlier version?** Run `npm run db:migrate` in `backend`. It upgrades the database in place and keeps existing orders.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `Admin123!` |
| Customer | `customer@example.com` | `Customer123!` |

To see the concurrency handling by hand: the seeded *Limited Edition Desk Mat* has only 3 units. Open the storefront in two tabs as the customer, put 2 in the cart in each, and check out in both. One succeeds; the other is told only 1 is left and nothing is charged. Then log in as the admin and open the product's **History**.

## Tests

```bash
cd backend
npm test
```

35 tests run against a real PostgreSQL database (`store_test`, which the suite wipes and rebuilds through the migrations). They cover authentication, role checks, admin CRUD, optimistic locking, idempotency, the inventory ledger, and the concurrency scenarios in [ARCHITECTURE.md §2.7](ARCHITECTURE.md#27-how-its-proven). These include two control experiments: a naive implementation that does oversell, and a lock order that does deadlock.

## Project layout

```
backend/
  db/migrations/                numbered schema migrations
  scripts/migrate.ts            migration runner
  src/services/purchase.ts      checkout: all-or-nothing, no oversell, no deadlock
  src/services/ledger.ts        stock movements and reconciliation
  src/services/products.ts      admin CRUD, optimistic locking, stock adjustments
  src/routes/                   HTTP routes and request validation
  src/middleware/               authentication, roles, error handling
  tests/                        API, ledger and concurrency tests
frontend/
  src/pages/Storefront.tsx      shop and cart
  src/pages/AdminProducts.tsx   inventory, stock history, reconciliation
ARCHITECTURE.md                 design document
```

## Use of AI

I built this with Claude as a coding assistant, as the brief encourages. I directed the design decisions, reviewed the code, and can walk through any part of it, especially the concurrency strategy.
