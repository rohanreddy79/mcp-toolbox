// Creates examples/demo.db deterministically with node:sqlite. Safe to re-run. The database lives
// outside the filesystem root on purpose: the fs tools should not see raw database bytes.
import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo.db');

export async function seed() {
  await rm(DB_PATH, { force: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL DEFAULT 'DE'
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      ordered_at TEXT NOT NULL
    );
    CREATE INDEX orders_customer_idx ON orders(customer_id);
    CREATE INDEX orders_ordered_at_idx ON orders(ordered_at);
    CREATE VIEW order_totals AS
      SELECT o.id AS order_id, c.name AS customer, p.name AS product, o.quantity * p.price_cents AS total_cents
      FROM orders o JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = o.product_id;
  `);
  const customer = db.prepare('INSERT INTO customers (name, email, country) VALUES (?, ?, ?)');
  const product = db.prepare('INSERT INTO products (sku, name, category, price_cents) VALUES (?, ?, ?, ?)');
  const order = db.prepare('INSERT INTO orders (customer_id, product_id, quantity, ordered_at) VALUES (?, ?, ?, ?)');
  const customers = [
    ['Ada Lovelace', 'ada@example.com', 'GB'],
    ['Grace Hopper', 'grace@example.com', 'US'],
    ['Linus Torvalds', 'linus@example.com', 'FI'],
    ['Margaret Hamilton', 'margaret@example.com', 'US'],
  ];
  const products = [
    ['MUG-001', 'Espresso cup', 'mugs', 1200],
    ['MUG-002', 'Travel mug', 'mugs', 2400],
    ['STA-001', 'Dot-grid notebook', 'stationery', 1500],
    ['STO-001', 'Mug rack', 'storage', 3600],
  ];
  db.exec('BEGIN');
  for (const row of customers) customer.run(...row);
  for (const row of products) product.run(...row);
  for (let i = 0; i < 40; i += 1) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const month = String(1 + (i % 12)).padStart(2, '0');
    order.run(1 + (i % 4), 1 + ((i * 7) % 4), 1 + (i % 3), `2026-${month}-${day}T10:00:00Z`);
  }
  db.exec('COMMIT');
  db.close();
  return DB_PATH;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed().then((p) => console.log(`seeded ${p}`));
}
