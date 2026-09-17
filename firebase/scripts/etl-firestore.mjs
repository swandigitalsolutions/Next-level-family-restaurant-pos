#!/usr/bin/env node
/**
 * Postgres/SQLite -> Firestore ETL (Phase 3: emulator / dry only).
 *
 *   node scripts/etl-firestore.mjs --source <sqlite> --target dry
 *   firebase emulators:exec --only firestore,auth \
 *     "node scripts/etl-firestore.mjs --source <sqlite> --target emulator --create-auth-users"
 *
 * Idempotent: deterministic doc ids + plain `set()` (no merge). A re-run
 * overwrites, never duplicates. Writes `_migration/status` last; a crash leaves
 * `ok` unset so a re-run is safe. Always produces a reconciliation report and
 * exits non-zero on any mismatch.
 *
 * `--target live` is refused unless `--i-understand-this-writes-production`
 * (reserved for Phase 6).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSource } from "./lib/source.mjs";
import { transformAll } from "./lib/transform.mjs";
import { makeTarget, COLLECTIONS } from "./lib/target.mjs";
import { reconcile } from "./lib/reconcile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.join(here, "..");

function parseArgs(argv) {
  const a = { target: "dry" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--source") a.source = argv[++i];
    else if (k === "--target") a.target = argv[++i];
    else if (k === "--project") a.project = argv[++i];
    else if (k === "--report") a.report = argv[++i];
    else if (k === "--create-auth-users") a.createAuthUsers = true;
    else if (k === "--i-understand-this-writes-production") a.allowLive = true;
    else if (k === "--dry") a.target = "dry";
  }
  if (!a.source) a.source = path.join(firebaseDir, "..", "backend", "nextlevel.db");
  if (!a.report) a.report = path.join(firebaseDir, "reports", "phase3-reconciliation.md");
  return a;
}

function renderReport(a, plan, notes, result, timings) {
  const L = [];
  L.push("# Phase 3 — Firestore ETL reconciliation\n");
  L.push(`- source: \`${a.source}\``);
  L.push(`- target: \`${a.target}\`${a.createAuthUsers ? " (+ auth users)" : ""}`);
  L.push(`- generated: ${new Date().toISOString()}`);
  L.push(`- duration: ${timings.totalMs} ms`);
  L.push(`- result: **${result.ok ? "PASS" : "FAIL"}** (${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks)\n`);

  L.push("## Count reconciliation\n");
  L.push("| collection | source rows | planned docs | target docs | ok |");
  L.push("| --- | ---: | ---: | ---: | :--: |");
  for (const r of result.rows) {
    L.push(`| ${r.coll} | ${r.source} | ${r.planned} | ${r.target ?? "—"} | ${r.ok ? "✅" : "❌"} |`);
  }

  L.push("\n## Structural checks\n");
  for (const c of result.checks) {
    L.push(`- ${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : ` — ${c.msg}`}`);
  }

  if (notes.length) {
    L.push("\n## Transform notes\n");
    for (const n of notes) L.push(`- ${n}`);
  }

  L.push("\n## Deterministic id scheme\n");
  L.push("| collection | id |");
  L.push("| --- | --- |");
  for (const [k, v] of Object.entries({
    users: "u_<users.id>",
    userCredentials: "u_<users.id>",
    categories: "cat_food_<id> / cat_alc_<id>",
    catalog: "item_food_<id> / item_alc_<id>",
    tables: "tbl_<id>",
    tableSessions: "sess_<id>",
    bills: "bill_food_<id> / bill_alc_<id>",
    qrOrders: "<public_ref>",
    auditLog: "audit_<id>",
    counters: "foodBill / alcoholBill / qrOrder",
  })) L.push(`| ${k} | \`${v}\` |`);

  return L.join("\n") + "\n";
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  console.log(`ETL  source=${a.source}  target=${a.target}`);
  const src = await openSource(a.source);
  const { docs, notes } = transformAll(src);

  const plannedTotal = COLLECTIONS.reduce((n, c) => n + docs[c].length, 0);
  console.log(`transformed ${plannedTotal} docs across ${COLLECTIONS.length} collections`);
  for (const n of notes) console.log("  note:", n);

  const target = await makeTarget({ mode: a.target, projectId: a.project, allowLive: a.allowLive });

  let authResult = null;
  if (a.target !== "dry") {
    for (const coll of COLLECTIONS) {
      await target.writeCollection(coll, docs[coll]);
      console.log(`  wrote ${docs[coll].length.toString().padStart(4)}  ${coll}`);
    }
    if (a.createAuthUsers) {
      authResult = await target.createAuthUsers(docs.authUsers);
      console.log(`  auth users: +${authResult.created} created, ~${authResult.updated} updated`);
    }
    await target.db
      .collection("_migration")
      .doc("status")
      .set({
        source: a.source,
        target: a.target,
        finishedAt: new Date(),
        counts: Object.fromEntries(COLLECTIONS.map((c) => [c, docs[c].length])),
        authUsers: authResult,
        ok: true,
      });
  }

  const result = await reconcile({ src, docs, target });
  const timings = { totalMs: Date.now() - t0 };

  mkdirSync(path.dirname(a.report), { recursive: true });
  writeFileSync(a.report, renderReport(a, docs, notes, result, timings));
  console.log(`\nreconciliation -> ${a.report}`);
  console.table(result.rows);
  if (!result.ok) {
    console.error(`\nFAIL: ${result.failed.length} check(s) failed:`);
    for (const f of result.failed) console.error(`  - ${f.name}: ${f.msg}`);
  } else {
    console.log(`\nPASS: ${result.checks.length}/${result.checks.length} checks green`);
  }

  await target.close();
  src.close();
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
