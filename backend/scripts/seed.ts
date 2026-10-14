import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { migrate } from './migrate.js';

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const customerEmail = 'customer@example.com';
const customerPassword = 'Customer123!';

const products = [
  { sku: 'KB-001', name: 'Mechanical Keyboard', description: 'Tactile switches, aluminium frame.', priceCents: 12900, stock: 25 },
  { sku: 'MS-001', name: 'Wireless Mouse', description: 'Ergonomic, 70-day battery.', priceCents: 4900, stock: 40 },
  { sku: 'HP-001', name: 'Noise-Cancelling Headphones', description: 'Over-ear, 30-hour battery.', priceCents: 19900, stock: 10 },
  { sku: 'MN-001', name: '27" 4K Monitor', description: 'IPS panel, USB-C power delivery.', priceCents: 38900, stock: 8 },
  { sku: 'WC-001', name: 'HD Webcam', description: '1080p at 60fps, privacy shutter.', priceCents: 7900, stock: 15 },
  { sku: 'LE-001', name: 'Limited Edition Desk Mat', description: 'Only 3 made. Try buying it from two tabs at once.', priceCents: 2900, stock: 3 },
];

async function seed() {
  await migrate();

  for (const [email, password, role] of [
    [adminEmail, adminPassword, 'admin'],
    [customerEmail, customerPassword, 'customer'],
  ] as const) {
    await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (lower(email)) DO NOTHING`,
      [email, await bcrypt.hash(password, 10), role],
    );
  }

  for (const p of products) {
    await pool.query(
      `INSERT INTO products (sku, name, description, price_cents, stock)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sku) DO NOTHING`,
      [p.sku, p.name, p.description, p.priceCents, p.stock],
    );
  }

  console.log('Seeded. Log in with:');
  console.log(`  admin:    ${adminEmail} / ${adminPassword}`);
  console.log(`  customer: ${customerEmail} / ${customerPassword}`);
}

seed()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
