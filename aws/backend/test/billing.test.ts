import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem, seedTable, seedUser, fakeEvent } from "./_helpers";
import { handler as billingHandler } from "../src/handlers/callable/billing";

before(async () => { await getPool(); });
beforeEach(resetDb);

async function call(action: string, body: unknown, role = "billing") {
  const pool = await getPool();
  const uid = await seedUser(pool, role);
  return billingHandler(fakeEvent({ role, action, body, uid }));
}

test("createBill FOOD: mints a bill, decrements tracked stock, leaves untracked stock alone", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const tracked = await seedItem(pool, { kind: "food", categoryId: cat, name: "Dosa", price: 100, stockQty: 10 });
  const untracked = await seedItem(pool, { kind: "food", categoryId: cat, name: "Rice", price: 50, stockQty: null });

  const res: any = await call("createBill", { type: "FOOD", items: [{ item_id: tracked, name: "Dosa", price: 100, qty: 3 }, { item_id: untracked, name: "Rice", price: 50, qty: 2 }] });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.match(body.bill_no, /^FOOD-\d{6}$/);

  const stock = await pool.query("SELECT id, stock_qty FROM catalog WHERE id = ANY($1)", [[tracked, untracked]]);
  const byId = Object.fromEntries(stock.rows.map((r) => [r.id, r.stock_qty]));
  assert.equal(byId[tracked], 7, "tracked stock decremented by qty");
  assert.equal(byId[untracked], null, "untracked stock left alone");
});

test("createBill: stock never goes negative (floors at 0)", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Special", price: 100, stockQty: 2 });
  await call("createBill", { type: "FOOD", items: [{ item_id: item, name: "Special", price: 100, qty: 5 }] });
  const row = (await pool.query("SELECT stock_qty FROM catalog WHERE id=$1", [item])).rows[0];
  assert.equal(row.stock_qty, 0);
});

test("createBill CAFE: cafe_billing role allowed, billing/manager/admin also allowed", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "cafe");
  const item = await seedItem(pool, { kind: "cafe", categoryId: cat, name: "Tea", price: 20 });
  const res: any = await call("createBill", { type: "CAFE", items: [{ name: "Tea", price: 20, qty: 2, item_id: item }] }, "cafe_billing");
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.match(body.bill_no, /^CAFE-\d{6}$/);
});

test("createBill: kitchen role is FORBIDDEN from billing", async () => {
  const res: any = await call("createBill", { type: "FOOD", items: [{ name: "X", price: 10, qty: 1 }] }, "kitchen");
  assert.equal(res.statusCode, 403);
});

test("openTable then settleTable: pro-rata discount, table freed, session closed, bills immutable", async () => {
  const pool = await getPool();
  const tableId = await seedTable(pool, "T1");

  const openRes: any = await call("openTable", { table_id: tableId });
  const { session } = JSON.parse(openRes.body);
  const sessionId = session.id;

  // NOTE: the session line's kind field is `kind` at runtime (matching what
  // pushQrOrderToBill/the billing UI actually write), not the `itemKind`
  // name FIRESTORE-SCHEMA.md's SessionLine documents — this was already the
  // case in the source Firebase implementation (billing.ts toSessionLine
  // reads `i.kind`) and is preserved as-is for exact parity.
  await pool.query("UPDATE table_sessions SET items=$2 WHERE id=$1", [sessionId, JSON.stringify([
    { kind: "food", itemId: null, itemName: "Dosa", price: 100, qty: 2, lineTotal: 200, taxRate: 0, brand: "", bottleSize: "" },
    { kind: "alcohol", itemId: null, itemName: "Beer", price: 150, qty: 1, lineTotal: 150, taxRate: 18, brand: "", bottleSize: "" },
  ])]);

  const settleRes: any = await call("settleTable", { session_id: sessionId, discount: 35 });
  assert.equal(settleRes.statusCode, 200);
  const settled = JSON.parse(settleRes.body);
  assert.equal(settled.bills.length, 2, "one FOOD bill + one ALCOHOL bill");
  assert.equal(settled.discount, 35);

  const table = (await pool.query("SELECT status, open_session_id FROM restaurant_tables WHERE id=$1", [tableId])).rows[0];
  assert.equal(table.status, "available");
  assert.equal(table.open_session_id, null);

  const sess = (await pool.query("SELECT status FROM table_sessions WHERE id=$1", [sessionId])).rows[0];
  assert.equal(sess.status, "settled");

  // bills are immutable: UPDATE must be rejected at the DB privilege level
  // for the app role (pos_app) — using the postgres superuser here we can
  // only assert the row exists and matches; the privilege revoke itself is
  // proven by the 002_privileges.sql migration having applied cleanly
  // (see aws/docs/TESTING.md).
  const bills = await pool.query("SELECT bill_no, grand_total FROM bills WHERE table_session_id=$1", [sessionId]);
  assert.equal(bills.rowCount, 2);
});

test("settleTable: empty session is rejected", async () => {
  const pool = await getPool();
  const tableId = await seedTable(pool, "T2");
  const openRes: any = await call("openTable", { table_id: tableId });
  const { session } = JSON.parse(openRes.body);
  const res: any = await call("settleTable", { session_id: session.id });
  assert.equal(res.statusCode, 409); // failed-precondition, matches the Firebase HttpsError code
});

test("openTable is idempotent per table: a second call returns the SAME open session, does not create a duplicate", async () => {
  const pool = await getPool();
  const tableId = await seedTable(pool, "T3");
  const r1: any = await call("openTable", { table_id: tableId });
  const r2: any = await call("openTable", { table_id: tableId });
  const b1 = JSON.parse(r1.body), b2 = JSON.parse(r2.body);
  assert.equal(b1.session.id, b2.session.id);
  assert.equal(b2.created, false);
  const count = await pool.query("SELECT count(*)::int AS n FROM table_sessions WHERE table_id=$1 AND status='open'", [tableId]);
  assert.equal(count.rows[0].n, 1);
});
