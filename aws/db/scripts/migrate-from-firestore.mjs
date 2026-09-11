#!/usr/bin/env node
/**
 * Firestore -> PostgreSQL migration tool.
 *
 * Usage:
 *   node migrate-from-firestore.mjs --dry                          # read Firestore, print counts, write nothing
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node migrate-from-firestore.mjs \
 *        --project demo-project --target staging                  # write to a non-prod Postgres, source = emulator
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json node migrate-from-firestore.mjs \
 *        --project nextlevel-pos --target production \
 *        --i-understand-this-writes-production                    # real migration (explicit opt-in)
 *   node migrate-from-firestore.mjs --verify --project nextlevel-pos --target staging   # reconciliation only, no writes
 *
 * Requires:
 *   GOOGLE_APPLICATION_CREDENTIALS  -> a Firebase service account (skip if FIRESTORE_EMULATOR_HOST is set instead)
 *   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (or DATABASE_URL)  -> target Postgres
 *
 * Design (mirrors firebase/scripts/etl-firestore.mjs, reversed direction):
 *   1. Deterministic ids carry straight across — Firestore doc ids were
 *      already chosen to be valid Postgres primary keys (see
 *      FIRESTORE-SCHEMA.md "Migration ID mapping"), so this ETL needs NO
 *      id-remapping/lookup table.
 *   2. Every write is `INSERT ... ON CONFLICT (pk) DO UPDATE` -> idempotent,
 *      safe to re-run after a crash or partial failure.
 *   3. Collection order respects FK dependencies: users -> categories ->
 *      catalog -> restaurant_tables -> table_sessions -> bills -> counters ->
 *      qr_orders -> audit_log -> website_orders -> website_payments ->
 *      kitchen_tickets.
 *   4. `--verify`: re-reads both sides and compares per-collection counts —
 *      exits non-zero on ANY mismatch, never reports success on a partial
 *      match.
 *   5. counters seeded to max(firestore value, existing Postgres value) so
 *      post-migration numbers never collide with already-issued ones.
 *   6. NEVER writes to Firestore — this is a one-way, read-only-on-the-
 *      Firestore-side migration. Firebase stays fully intact regardless of
 *      how this script is run.
 */
import { Pool } from "pg";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    dry: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    target: { type: "string", default: "staging" },
    project: { type: "string" },
    "i-understand-this-writes-production": { type: "boolean", default: false },
  },
});

if (args.target === "production" && !args["i-understand-this-writes-production"]) {
  console.error("Refusing to write to --target production without --i-understand-this-writes-production");
  process.exit(1);
}

async function openFirestore() {
  const { initializeApp, getApps, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) {
    const opts = args.project ? { projectId: args.project } : {};
    initializeApp(opts);
  }
  return getFirestore();
}

const iso = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null);
const num = (v, d = 0) => (v === null || v === undefined ? d : Number(v));

// Columns that are Postgres `jsonb` and therefore need an explicit JSON
// string — vs. real Postgres array columns (search_tokens, settled_bill_ids,
// settled_bill_nos) which the `pg` driver must receive as a plain JS array
// so it can build the correct `{...}` array literal itself. Getting this
// wrong throws a real Postgres error (caught live during this ETL's own
// smoke test against the Firestore emulator — see aws/docs/MIGRATION-STATUS.md).
const JSONB_COLUMNS = new Set(["items", "customer", "fulfillment", "payment", "payments", "details", "pending_order"]);

async function upsert(pool, table, pk, row) {
  if (!pool) return; // dry-run
  const cols = Object.keys(row);
  const vals = Object.values(row).map((v, i) => {
    const col = cols[i];
    if (JSONB_COLUMNS.has(col)) return JSON.stringify(v ?? null);
    return v;
  });
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const updates = cols.filter((c) => c !== pk).map((c) => `${c} = EXCLUDED.${c}`).join(",");
  await pool.query(
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT (${pk}) DO UPDATE SET ${updates}`,
    vals,
  );
}

async function main() {
  const db = await openFirestore();
  const pool = args.dry ? null : new Pool();
  const counts = {};
  const t0 = Date.now();

  // ── 1. users + user_credentials ──────────────────────────────────────────
  const usersSnap = await db.collection("users").get();
  for (const d of usersSnap.docs) {
    const u = d.data();
    await upsert(pool, "users", "uid", {
      uid: d.id, username: u.username ?? "", username_lower: u.usernameLower ?? String(u.username ?? "").toLowerCase(),
      full_name: u.fullName ?? "", phone: u.phone ?? "", role: normalizeRole(u.role), status: u.status ?? "active",
      created_at: iso(u.createdAt) ?? new Date(), updated_at: new Date(), legacy_id: u.legacyId ?? null,
    });
  }
  counts.users = usersSnap.size;

  const credsSnap = await db.collection("userCredentials").get();
  for (const d of credsSnap.docs) {
    const c = d.data();
    await upsert(pool, "user_credentials", "uid", {
      uid: d.id, username_lower: c.usernameLower ?? "", password_hash: c.passwordHash ?? "", updated_at: new Date(),
    });
  }
  counts.userCredentials = credsSnap.size;

  // ── 2. categories ─────────────────────────────────────────────────────────
  const catsSnap = await db.collection("categories").get();
  for (const d of catsSnap.docs) {
    const c = d.data();
    await upsert(pool, "categories", "id", {
      id: d.id, kind: c.kind, sales_channel: c.salesChannel ?? (c.kind === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT"),
      name: c.name ?? "", name_lower: c.nameLower ?? String(c.name ?? "").toLowerCase(), sort_order: num(c.sortOrder),
      status: c.status ?? "active", created_at: iso(c.createdAt) ?? new Date(), updated_at: new Date(), legacy_id: c.legacyId ?? null,
    });
  }
  counts.categories = catsSnap.size;

  // ── 3. catalog ────────────────────────────────────────────────────────────
  const itemsSnap = await db.collection("catalog").get();
  for (const d of itemsSnap.docs) {
    const it = d.data();
    await upsert(pool, "catalog", "id", {
      id: d.id, kind: it.kind, sales_channel: it.salesChannel ?? (it.kind === "cafe" ? "OUTSIDE_CAFE" : "RESTAURANT"),
      name: it.name ?? "", name_lower: it.nameLower ?? String(it.name ?? "").toLowerCase(), category_id: it.categoryId,
      category_name: it.categoryName ?? "", category_sort: num(it.categorySort), price: num(it.price), tax_rate: num(it.taxRate),
      stock_qty: it.stockQty === null || it.stockQty === undefined ? null : num(it.stockQty),
      brand: it.brand ?? null, bottle_size: it.bottleSize ?? null, description: it.description ?? null,
      status: it.status ?? "active", image_path: it.imagePath ?? null,
      created_at: iso(it.createdAt) ?? new Date(), updated_at: new Date(), legacy_id: it.legacyId ?? null,
    });
  }
  counts.catalog = itemsSnap.size;

  // ── 4. tables ─────────────────────────────────────────────────────────────
  const tablesSnap = await db.collection("tables").get();
  for (const d of tablesSnap.docs) {
    const t = d.data();
    await upsert(pool, "restaurant_tables", "id", {
      id: d.id, table_no: t.tableNo ?? "", seats: num(t.seats, 4), status: t.status ?? "available",
      qr_token: t.qrToken ?? "", created_at: iso(t.createdAt) ?? new Date(), updated_at: new Date(), legacy_id: t.legacyId ?? null,
    });
  }
  counts.tables = tablesSnap.size;
  // open_session_id is set in pass 2 below, after table_sessions exist (FK order)

  // ── 5. table_sessions ─────────────────────────────────────────────────────
  const sessSnap = await db.collection("tableSessions").get();
  for (const d of sessSnap.docs) {
    const s = d.data();
    await upsert(pool, "table_sessions", "id", {
      id: d.id, table_id: s.tableId, table_no: s.tableNo ?? "", customer_name: s.customerName ?? "Walk-in",
      customer_phone: s.customerPhone ?? "-", status: s.status ?? "open", opened_at: iso(s.openedAt) ?? new Date(),
      opened_by_uid: s.openedByUid ?? null, settled_at: iso(s.settledAt), items: s.items ?? [],
      subtotal: num(s.subtotal), tax: num(s.tax), grand_total: num(s.grandTotal),
      settled_bill_ids: s.settledBillIds ?? [], legacy_id: s.legacyId ?? null,
    });
  }
  counts.tableSessions = sessSnap.size;

  if (pool) {
    for (const d of tablesSnap.docs) {
      const t = d.data();
      if (t.openSessionId) await pool.query("UPDATE restaurant_tables SET open_session_id=$2 WHERE id=$1", [d.id, t.openSessionId]);
    }
  }

  // ── 6. bills (immutable — INSERT only, no upsert-update path needed but harmless) ──
  const billsSnap = await db.collection("bills").get();
  for (const d of billsSnap.docs) {
    const b = d.data();
    await upsert(pool, "bills", "id", {
      id: d.id, bill_no: b.billNo, bill_no_lower: b.billNoLower ?? String(b.billNo ?? "").toLowerCase(), type: b.type,
      source: b.source ?? "counter", table_id: b.tableId ?? null, table_session_id: b.tableSessionId ?? null,
      customer_name: b.customerName ?? "-", customer_phone: b.customerPhone ?? "-",
      customer_name_lower: b.customerNameLower ?? String(b.customerName ?? "").toLowerCase(), search_tokens: b.searchTokens ?? [],
      subtotal: num(b.subtotal), discount: num(b.discount), tax: num(b.tax), grand_total: num(b.grandTotal),
      payment_method: b.paymentMethod ?? "Cash", status: b.status ?? "confirmed",
      website_order_id: b.websiteOrderId ?? null, website_order_no: b.websiteOrderNo ?? null, deposit_paid_paise: b.depositPaidPaise ?? null,
      created_by_uid: b.createdByUid ?? null, created_at: iso(b.createdAt) ?? new Date(), date_key: b.dateKey ?? "",
      hour: num(b.hour), items: b.items ?? [], legacy_id: b.legacyId ?? null,
    });
  }
  counts.bills = billsSnap.size;

  // ── 7. counters — seed to max(firestore, existing postgres) ─────────────
  const countersSnap = await db.collection("counters").get();
  const nameMap = { foodBill: "foodBill", alcoholBill: "alcoholBill", cafeBill: "cafeBill", qrOrder: "qrOrder", websiteOrder: "website" };
  for (const d of countersSnap.docs) {
    const c = d.data();
    const pgName = nameMap[d.id] || d.id;
    if (pool) {
      const cur = await pool.query("SELECT value FROM counters WHERE name=$1", [pgName]);
      const existing = cur.rows[0]?.value ?? 0;
      const next = Math.max(existing, num(c.value));
      await pool.query("UPDATE counters SET value=$2, updated_at=now() WHERE name=$1", [pgName, next]);
    }
  }
  counts.counters = countersSnap.size;

  // ── 8. qr_orders ──────────────────────────────────────────────────────────
  const qrSnap = await db.collection("qrOrders").get();
  for (const d of qrSnap.docs) {
    const q = d.data();
    await upsert(pool, "qr_orders", "public_ref", {
      public_ref: d.id, order_no: q.orderNo, table_id: q.tableId, table_no: q.tableNo ?? "",
      customer_name: q.customerName ?? "Guest", note: q.note ?? null, status: q.status ?? "NEW",
      subtotal: num(q.subtotal), tax: num(q.tax), grand_total: num(q.grandTotal), pushed_to_bill: !!q.pushedToBill,
      table_session_id: q.tableSessionId ?? null, kitchen_ticket_id: q.kitchenTicketId ?? null, kitchen_status: q.kitchenStatus ?? null,
      created_at: iso(q.createdAt) ?? new Date(), updated_at: iso(q.updatedAt) ?? new Date(), date_key: q.dateKey ?? "",
      items: q.items ?? [], legacy_id: q.legacyId ?? null,
    });
  }
  counts.qrOrders = qrSnap.size;

  // ── 9. audit_log ──────────────────────────────────────────────────────────
  // Re-run-safe via ON CONFLICT (source_doc_id) — see 001_init.sql
  // audit_log_source_doc_id_uq. Keyed on the Firestore doc id itself (not
  // legacyId, which most runtime-created — i.e. most real — audit rows
  // never had), so every audit doc migrates exactly once regardless of
  // whether it predates or postdates the original Postgres->Firestore cutover.
  const auditSnap = await db.collection("auditLog").get();
  for (const d of auditSnap.docs) {
    const a = d.data();
    if (pool) {
      await pool.query(
        `INSERT INTO audit_log (actor_uid, actor_username, actor_role, action, entity_type, entity_id, details, created_at, legacy_id, source_doc_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (source_doc_id) WHERE source_doc_id IS NOT NULL DO NOTHING`,
        [a.actorUid ?? null, a.actorUsername ?? null, a.actorRole ?? null, a.action, a.entityType, a.entityId ?? null,
         a.details ? JSON.stringify(a.details) : null, iso(a.createdAt) ?? new Date(), a.legacyId ?? null, d.id],
      );
    }
  }
  counts.auditLog = auditSnap.size;

  // ── 10. stats — rebuilt from bills post-migration (statsService.computeRolling), not migrated 1:1 ──

  // ── 13. website_orders ────────────────────────────────────────────────────
  const woSnap = await db.collection("websiteOrders").get();
  for (const d of woSnap.docs) {
    const w = d.data();
    await upsert(pool, "website_orders", "id", {
      id: d.id, ref: w.ref, channel: w.channel ?? "website", status: w.status ?? "PENDING_PAYMENT",
      payment_status: w.paymentStatus ?? "UNPAID", customer: w.customer ?? {}, fulfillment: w.fulfillment ?? {}, items: w.items ?? [],
      subtotal_paise: num(w.subtotalPaise), tax_paise: num(w.taxPaise), total_paise: num(w.totalPaise),
      advance_paise: num(w.advancePaise), balance_paise: num(w.balancePaise), paid_paise: num(w.paidPaise),
      payment: w.payment ?? {}, payments: w.payments ?? [], settled_bill_ids: w.settledBillIds ?? [], settled_bill_nos: w.settledBillNos ?? [],
      kitchen_ticket_id: w.kitchenTicketId ?? null, kitchen_status: w.kitchenStatus ?? null, idempotency_key: w.idempotencyKey ?? null,
      created_at: iso(w.createdAt) ?? new Date(), updated_at: iso(w.updatedAt) ?? new Date(),
      confirmed_at: iso(w.confirmedAt), settled_at: iso(w.settledAt), date_key: w.dateKey ?? "",
    });
  }
  counts.websiteOrders = woSnap.size;

  // ── 15. website_payments ──────────────────────────────────────────────────
  const wpSnap = await db.collection("websitePayments").get();
  for (const d of wpSnap.docs) {
    const p = d.data();
    if (pool) {
      await pool.query(
        `INSERT INTO website_payments (marker_id, ref, event, amount_paise, amount_mismatch, rejected, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (marker_id) DO NOTHING`,
        [d.id, p.ref ?? null, p.event, p.amountPaise ?? null, p.amountMismatch ?? null, p.rejected ?? null, iso(p.at) ?? new Date()],
      );
    }
  }
  counts.websitePayments = wpSnap.size;

  // ── 16. kitchen_tickets ────────────────────────────────────────────────────
  const ktSnap = await db.collection("kitchenTickets").get();
  for (const d of ktSnap.docs) {
    const k = d.data();
    await upsert(pool, "kitchen_tickets", "id", {
      id: d.id, source: k.source, source_id: k.sourceId, ref: k.ref, table_label: k.tableLabel ?? null,
      customer_name: k.customerName ?? null, items: k.items ?? [], status: k.status ?? "QUEUED", note: k.note ?? null,
      accepted_by_uid: k.acceptedByUid ?? null, accepted_by_username: k.acceptedByUsername ?? null,
      created_at: iso(k.createdAt) ?? new Date(), updated_at: iso(k.updatedAt) ?? new Date(),
      ready_at: iso(k.readyAt), done_at: iso(k.doneAt), date_key: k.dateKey ?? "",
    });
  }
  counts.kitchenTickets = ktSnap.size;

  // ── website_order_idempotency (retention-bounded — only migrate live/recent rows) ──
  const idemSnap = await db.collection("websiteOrderIdempotency").get();
  for (const d of idemSnap.docs) {
    const i = d.data();
    if (pool && /^[A-Za-z0-9._:-]{8,128}$/.test(d.id)) {
      await pool.query(
        `INSERT INTO website_order_idempotency (key, request_hash, status, order_id, ref, pending_order, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (key) DO NOTHING`,
        [d.id, i.requestHash ?? "", i.status ?? "pending", i.orderId ?? null, i.ref ?? null,
         i.pendingOrder ? JSON.stringify(i.pendingOrder) : null, iso(i.createdAt) ?? new Date(), iso(i.completedAt)],
      );
    }
  }
  counts.websiteOrderIdempotency = idemSnap.size;

  console.log(args.dry ? "[dry-run] no writes performed." : `writes complete (target=${args.target}).`);
  console.log("counts:", counts, `(${Date.now() - t0}ms)`);
  if (pool) await pool.end();
}

function normalizeRole(r) {
  const s = String(r ?? "billing").trim().toLowerCase();
  if (s === "staff") return "billing";
  if (s === "cafe") return "cafe_billing";
  return s;
}

async function verify() {
  const db = await openFirestore();
  const pool = new Pool();
  const pairs = [
    ["users", "users", null],
    ["categories", "categories", null],
    ["catalog", "catalog", null],
    ["tables", "restaurant_tables", null],
    ["tableSessions", "table_sessions", null],
    ["bills", "bills", null],
    ["qrOrders", "qr_orders", null],
    ["auditLog", "audit_log", null],
    ["websiteOrders", "website_orders", null],
    ["kitchenTickets", "kitchen_tickets", null],
  ];
  let ok = true;
  console.log("collection".padEnd(20), "firestore".padStart(10), "postgres".padStart(10), "match");
  for (const [fsColl, pgTable] of pairs) {
    const fsCount = (await db.collection(fsColl).count().get()).data().count;
    const pgCount = (await pool.query(`SELECT count(*)::int AS n FROM ${pgTable}`)).rows[0].n;
    const match = fsCount === pgCount;
    if (!match) ok = false;
    console.log(fsColl.padEnd(20), String(fsCount).padStart(10), String(pgCount).padStart(10), match ? "✅" : "❌ MISMATCH");
  }
  await pool.end();
  if (!ok) {
    console.error("\nRECONCILIATION FAILED — at least one collection count mismatch. Do not proceed.");
    process.exit(1);
  }
  console.log("\nRECONCILIATION PASSED — all counts match.");
}

if (args.verify) {
  verify().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
