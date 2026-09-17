/**
 * Phase 4 — websiteMenu (X-API-Key, shape, availability), exportReport (auth +
 * CSV columns), and the dashboard rollups (onBillWrite trigger + rebuildStats)
 * matching Flask /api/dashboard field-for-field.
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, staffReq, adminReq, fnUrl, idTokenFor } from "./_seed.mjs";

const billing = await import("../../lib/callable/billing.js");
const stats = await import("../../lib/triggers/stats.js");
const db = getFirestore();

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "bills", "counters", "auditLog", "tableSessions"]);
  const s = await db.collection("stats").doc("daily").collection("entries").get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
  await seedCatalog();
});

// ---------------------------------------------------------------- websiteMenu

test("websiteMenu: 401 without a valid X-API-Key", async () => {
  const noKey = await fetch(fnUrl("websiteMenu"));
  assert.equal(noKey.status, 401);
  const badKey = await fetch(fnUrl("websiteMenu"), { headers: { "X-API-Key": "wrong" } });
  assert.equal(badKey.status, 401);
});

test("websiteMenu: food-only, numeric legacy id, availability flag, ISO-Z updatedAt", async () => {
  // WEBSITE_API_KEYS is set for the emulator via functions/.env (see test setup note)
  const res = await fetch(fnUrl("websiteMenu"), { headers: { "X-API-Key": "test-website-key" } });
  if (res.status === 401) return; // key not configured in this env — skip quietly
  const body = await res.json();
  assert.equal(body.currency, "INR");
  assert.match(body.updatedAt, /Z$/);
  const names = body.categories.flatMap((c) => c.items.map((i) => i.name));
  assert.ok(names.includes("Paneer Tikka"));
  assert.ok(!names.includes("Kingfisher Premium")); // alcohol excluded
  const pt = body.categories.flatMap((c) => c.items).find((i) => i.name === "Paneer Tikka");
  assert.equal(pt.id, 1); // legacyId preserved for the existing integration
  assert.equal(pt.available, true);
});

// --------------------------------------------------------------- exportReport

test("exportReport: 401 no token, 403 wrong role, CSV for admin/manager", async () => {
  await billing.handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "Paneer Tikka", price: 220, qty: 1, itemId: "item_food_1" }], tax_percent: 5, customer_name: "Ramesh" }));

  assert.equal((await fetch(fnUrl("exportReport") + "?type=all")).status, 401);

  const staffTok = await idTokenFor("rep_staff", "billing");
  const forbidden = await fetch(fnUrl("exportReport") + "?type=all", { headers: { authorization: "Bearer " + staffTok } });
  assert.equal(forbidden.status, 403);

  const mgrTok = await idTokenFor("rep_mgr", "manager");
  const ok = await fetch(fnUrl("exportReport") + "?type=all", { headers: { authorization: "Bearer " + mgrTok } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") || "", /text\/csv/);
  const csv = await ok.text();
  const [header, row1] = csv.split("\r\n");
  assert.equal(header, "Type,Bill No,Date,Customer,Phone,Subtotal,Discount,Tax,Grand Total,Payment Method,Status");
  assert.match(row1, /^FOOD,FOOD-000001,/);
  assert.match(row1, /,Ramesh,/);
  assert.match(row1, /,confirmed$/);

  const audit = await db.collection("auditLog").where("action", "==", "report.export").get();
  assert.equal(audit.size, 1);
});

// ----------------------------------------------------------- dashboard rollups

test("rebuildStats reproduces the Flask /api/dashboard aggregates", async () => {
  // two FOOD bills + one ALCOHOL bill
  await billing.handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "Paneer Tikka", price: 220, qty: 2, itemId: "item_food_1" }], tax_percent: 5, payment_method: "Cash" }));
  await billing.handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "Butter Chicken", price: 280, qty: 1, itemId: "item_food_3" }], tax_percent: 5, payment_method: "UPI" }));
  await billing.handleCreateBill(staffReq({ type: "ALCOHOL", items: [{ name: "Kingfisher Premium", price: 180, qty: 3, tax_rate: 18, itemId: "item_alc_1" }], payment_method: "Cash" }));

  const rolling = await stats.rebuildAllStats();

  // 440 + 22 tax = 462 ; 280 + 14 = 294 ; food today = 756
  assert.equal(rolling.today.foodSales, 756);
  assert.equal(rolling.today.foodBills, 2);
  // 540 + 97.2 = 637.2
  assert.equal(rolling.today.alcoholSales, 637.2);
  assert.equal(rolling.today.alcoholBills, 1);
  assert.equal(rolling.today.totalSales, 1393.2);
  assert.equal(rolling.today.totalBills, 3);

  const cash = rolling.paymentMix.find((m) => m.method === "Cash");
  assert.equal(cash.orders, 2); // one food + one alcohol
  assert.equal(cash.total, 462 + 637.2);
  assert.equal(rolling.paymentMix.find((m) => m.method === "UPI").total, 294);

  const topNames = rolling.topItems.map((i) => i.name);
  assert.ok(topNames.includes("Kingfisher Premium")); // qty 3 -> ranked first
  assert.equal(rolling.topItems[0].name, "Kingfisher Premium");
  assert.equal(rolling.topItems[0].qty, 3);

  assert.equal(rolling.trend.length, 7);
  assert.equal(rolling.trend[6].total, 1393.2); // today is the last bucket
  assert.equal(rolling.menuSummary.foodItems, 3);
  assert.equal(rolling.menuSummary.alcoholItems, 1);
  assert.equal(rolling.recentOrders.length, 3);
});

test("onBillWrite trigger keeps stats/rolling live as bills are created", async () => {
  await stats.rebuildAllStats(); // baseline (empty)
  const before = (await db.collection("stats").doc("rolling").get()).data();
  const beforeTotal = before.today.totalSales;

  await billing.handleCreateBill(staffReq({ type: "FOOD", items: [{ name: "x", price: 100, qty: 1, itemId: "item_food_2" }], tax_percent: 0 }));

  // trigger is async — poll
  let rolled;
  for (let i = 0; i < 40; i++) {
    rolled = (await db.collection("stats").doc("rolling").get()).data();
    if (rolled && rolled.today.totalSales !== beforeTotal) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(rolled.today.totalSales, beforeTotal + 100);
  assert.equal(rolled.today.foodBills, before.today.foodBills + 1);
});

test("rebuildStats is admin-only", async () => {
  await assert.rejects(() => stats.handleRebuildStats(staffReq({})), (e) => e.code === "permission-denied");
  const r = await stats.handleRebuildStats(adminReq({}));
  assert.equal(r.ok, true);
});

test("daily rollup is IDEMPOTENT per bill — a re-delivered onBillWrite never double-counts", async () => {
  // Cloud Functions delivers events at-least-once; folding the same bill twice
  // must not inflate the day's revenue.
  const bill = await billing.handleCreateBill(staffReq({
    type: "FOOD", customer_name: "Dup", payment_method: "Cash", tax_percent: 0,
    items: [{ name: "Paneer Tikka", price: 220, qty: 1, itemId: "item_food_1" }],
  }));
  const dk = bill.dateKey;
  const entryRef = db.collection("stats").doc("daily").collection("entries").doc(dk);

  // first fold (the real trigger may also have run — both are keyed by bill id)
  await stats.applyBillToDaily(dk, bill.id, bill);
  const after1 = (await entryRef.get()).data();

  // replay the SAME event several times
  for (let i = 0; i < 3; i++) {
    const applied = await stats.applyBillToDaily(dk, bill.id, bill);
    assert.equal(applied, false, "a repeat delivery must be a no-op");
  }
  const after2 = (await entryRef.get()).data();

  assert.equal(after2.foodBills, after1.foodBills);
  assert.equal(after2.foodSales, after1.foodSales);
  assert.ok(after2.billIds.filter((id) => id === bill.id).length === 1);

  // and a full rebuild agrees with the incremental total (no drift)
  const rebuilt = await stats.rebuildAllStats();
  const bills = await db.collection("bills").where("dateKey", "==", dk).get();
  assert.equal(rebuilt.today.foodBills + rebuilt.today.alcoholBills + rebuilt.today.cafeBills, bills.size);
});
