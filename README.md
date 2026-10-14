# Product Store

A full-stack product management application:

- **Backend API:** Express + TypeScript + PostgreSQL, with role-based access control
- **Admin dashboard:** create, edit, restock and remove products; view all orders
- **Storefront:** customers browse and buy products

The buy endpoint is safe under concurrency: it never oversells, even with 100 simultaneous purchases of the same product. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the schema, the concurrency strategy, and the trade-offs.

## Run it locally

Requirements: Node.js 22+ and PostgreSQL 14+ (or Docker).

```bash
# 1. Start PostgreSQL (creates the `store` and `store_test` databases)
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run db:seed      # applies the schema and adds demo users and products
npm run dev          # API on http://localhost:4000

# 3. Frontend (in a second terminal)
cd frontend
npm install
npm run dev          # app on http://localhost:5173
```

Not using Docker? Create the `store` and `store_test` databases in your own PostgreSQL and update the URLs in `backend/.env`.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `Admin123!` |
| Customer | `customer@example.com` | `Customer123!` |

To see the concurrency handling by hand: the seeded *Limited Edition Desk Mat* has only 3 units. Open the storefront in two tabs as the customer and try to buy 2 in each.

## Tests

```bash
cd backend
npm test
```

21 tests run against a real PostgreSQL database (`store_test`, which the suite wipes). They cover authentication, role checks, admin CRUD, optimistic locking, idempotency, and the concurrency scenarios described in [ARCHITECTURE.md §2.5](ARCHITECTURE.md#25-how-its-proven), including a control experiment showing that a naive implementation does oversell.

## Project layout

```
backend/
  db/schema.sql                 tables, constraints, indexes
  src/services/purchase.ts      the race-safe buy logic
  src/services/products.ts      admin CRUD, optimistic locking, stock adjustments
  src/routes/                   HTTP routes and request validation
  src/middleware/               authentication, roles, error handling
  tests/                        API and concurrency tests
frontend/
  src/pages/Storefront.tsx      customer shop
  src/pages/AdminProducts.tsx   inventory management
ARCHITECTURE.md                 design document
```

## Use of AI

I built this with Claude as a coding assistant, as the brief encourages. I directed the design decisions, reviewed the code, and can walk through any part of it, especially the concurrency strategy.
