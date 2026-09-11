#!/usr/bin/env node
/**
 * Firestore -> PostgreSQL migration tool.
 *
 * Usage:
 *   node migrate-from-firestore.mjs --dry                       # read Firestore, print counts, write nothing
 *   node migrate-from-firestore.mjs --target staging             # write to a non-prod Postgres
 *   node migrate-from-firestore.mjs --target production \
 *        --i-understand-this-writes-production                  # write to prod (explicit opt-in, mirrors
 *                                                                # firebase/scripts/etl-firestore.mjs's own guard)
 *   node migrate-from-firestore.mjs --verify --target staging    # reconciliation pass only (no writes)
 *
 * Requires:
 *   GOOGLE_APPLICATION_CREDENTIALS  -> a Firebase service account with Firestore read access
 *   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (or DATABASE_URL)  -> target Postgres
 *
 * Design (mirrors firebase/scripts/etl-firestore.mjs, reversed direction):
 *   1. Deterministic ids carry straight across — Firestore doc ids were already
 *      chosen to be the Postgres primary keys (see FIRESTORE-SCHEMA.md
 *      "Migration ID mapping"), so this ETL needs NO id-remapping/lookup table.
 *   2. Every write is `INSERT ... ON CONFLICT (id) DO UPDATE` -> idempotent,
 *      safe to re-run after a crash or partial failure.
 *   3. Order of collections respects FK dependencies: users -> categories ->
 *      catalog -> tables -> table_sessions -> bills -> counters -> qr_orders ->
 *      audit_log -> stats -> website_orders -> website_payments ->
 *      kitchen_tickets.
 *   4. `--verify`: re-reads both sides, compares per-collection counts AND a
 *      sample of financial documents (bills, website_orders) by exact paise/
 *      rupee value — refuses to report success on any mismatch.
 *   5. counters seeded to max(firestore value, max numeric suffix already in
 *      Postgres) so post-migration numbers never collide.
 *
 * STATUS: skeleton — the per-collection transform functions below are typed
 * and structured but not yet wired to a live Firestore read (needs the
 * firebase-admin SDK + a service account, which this migration explicitly
 * does not create/touch per the "Firebase stays live, untouched" mandate).
 * Fill in `readCollection()` calls against your own service account before
 * running against a real project. See aws/docs/MIGRATION-STATUS.md.
 */
import { Pool } from "pg";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    dry: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    target: { type: "string", default: "staging" },
    "i-understand-this-writes-production": { type: "boolean", default: false },
  },
});

if (args.target === "production" && !args["i-understand-this-writes-production"]) {
  console.error("Refusing to write to --target production without --i-understand-this-writes-production");
  process.exit(1);
}

const counts = { users: 0, categories: 0, catalog: 0, tables: 0, table_sessions: 0, bills: 0, qr_orders: 0, audit_log: 0, website_orders: 0, kitchen_tickets: 0 };
const errors = [];

async function main() {
  const pool = args.dry ? null : new Pool();

  // ── 1. users + user_credentials ──────────────────────────────────────────
  // for (const doc of await readCollection("users")) {
  //   await upsert(pool, "users", { uid: doc.id, username: d.username, username_lower: d.usernameLower, ... });
  //   counts.users++;
  // }

  // ── 2. categories, 3. catalog, 4. tables, 5. table_sessions, 6. bills ────
  // (same INSERT ... ON CONFLICT DO UPDATE pattern per collection — see
  //  aws/db/migrations/001_init.sql for the exact target column list.)

  // ── 7. counters — seed to max(source, existing) ──────────────────────────
  // ── 8. qr_orders, 9. audit_log, 10. stats, 13. website_orders, 15. website_payments, 16. kitchen_tickets ──

  console.log(args.dry ? "[dry-run] no writes performed." : `writes complete (target=${args.target}).`);
  console.log("counts:", counts);
  if (errors.length) {
    console.error(`${errors.length} error(s):`, errors);
    process.exit(1);
  }
  if (pool) await pool.end();
}

async function upsert(pool, table, row) {
  if (!pool) return; // dry-run
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const updates = cols.filter((c) => c !== "id" && c !== "uid").map((c) => `${c} = EXCLUDED.${c}`).join(",");
  const pk = table === "users" ? "uid" : "id";
  await pool.query(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})
     ON CONFLICT (${pk}) DO UPDATE SET ${updates}`,
    vals,
  );
}

async function verify(pool) {
  // Reconciliation: compare Postgres counts + a sample of financial rows
  // (bills.grand_total, website_orders.total_paise) byte-for-byte against the
  // Firestore source. Exits non-zero on ANY mismatch — never declares success
  // on a partial match. Skeleton: wire up the Firestore reads to complete this.
  console.log("verify: not yet wired to a live Firestore source (see file header).");
  process.exit(2);
}

if (args.verify) {
  verify().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
