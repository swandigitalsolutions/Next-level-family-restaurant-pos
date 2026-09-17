// ETL source reader. SQLite file (bundled backend/nextlevel.db copy, or the
// fixture) via node:sqlite, OR PostgreSQL via `pg` (production cutover, Phase 6).
//
// Interface (synchronous, so transform.mjs works unchanged for both):
//   all(sql)      -> rows for the table named in the SQL's FROM clause
//   count(table)  -> row count
//   has(table)    -> boolean
//   close()

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const KNOWN_TABLES = [
  "users", "food_categories", "alcohol_categories", "food_items", "alcohol_items",
  "restaurant_tables", "table_sessions", "table_session_items",
  "food_bills", "food_bill_items", "alcohol_bills", "alcohol_bill_items",
  "qr_orders", "qr_order_items", "counters", "audit_log", "customers", "payments",
];
const tableOf = (sql) => (String(sql).match(/from\s+"?(\w+)"?/i) || [, ""])[1];

async function openPostgres(url) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    throw new Error("Postgres source needs the `pg` package: (cd firebase && npm i pg)");
  }
  const dsn = /sslmode=|@(localhost|127\.0\.0\.1)/.test(url)
    ? url
    : url + (url.includes("?") ? "&" : "?") + "sslmode=require";
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  const present = new Set(
    (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map((r) => r.tablename),
  );
  // eager snapshot — every table read once, in id order
  const cache = new Map();
  for (const t of KNOWN_TABLES) {
    if (!present.has(t)) continue;
    const hasId = (await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='id'",
      [t],
    )).rowCount > 0;
    cache.set(t, (await client.query(`SELECT * FROM ${t}${hasId ? " ORDER BY id" : ""}`)).rows);
  }
  await client.end();
  return {
    all: (sql) => cache.get(tableOf(sql)) || [],
    count: (t) => (cache.get(t) || []).length,
    has: (t) => cache.has(t),
    close: () => {},
  };
}

export async function openSource(pathOrUrl) {
  if (/^postgres(ql)?:\/\//i.test(pathOrUrl)) return openPostgres(pathOrUrl);

  if (!existsSync(pathOrUrl)) throw new Error(`source database not found: ${pathOrUrl}`);
  const db = new DatabaseSync(pathOrUrl, { readOnly: true });
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  return {
    all: (sql) => db.prepare(sql).all(),
    count: (t) => (has(t) ? db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0),
    has,
    close: () => db.close(),
  };
}
