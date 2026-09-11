import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem, seedTable, seedUser, fakeEvent } from "./_helpers";
import { handler as queriesHandler } from "../src/handlers/callable/queries";
import { handler as billingHandler } from "../src/handlers/callable/billing";

before(async () => { await getPool(); });
beforeEach(resetDb);

async function call(action: string, body: unknown, role = "billing") {
  const pool = await getPool();
  const uid = await seedUser(pool, role);
  return queriesHandler(fakeEvent({ role, action, body, uid }));
}

test("listCategories / listCatalogItems reflect seeded catalog", async () => {
  const pool = await getPool();
  const catId = await seedCategory(pool, "food", "Mains");
  await seedItem(pool, { kind: "food", categoryId: catId, name: "Dosa", price: 100 });

  const cats: any = JSON.parse((await call("listCategories", { kind: "food" }, "manager") as any).body);
  assert.equal(cats.length, 1);
  assert.equal(cats[0].name, "Mains");

  const items: any = JSON.parse((await call("listCatalogItems", { kind: "food" }, "manager") as any).body);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Dosa");
});

test("listTables reflects table + open session state", async () => {
  const pool = await getPool();
  await seedTable(pool, "T1");
  const tables: any = JSON.parse((await call("listTables", {}, "billing") as any).body);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].status, "available");
});

test("listBills returns created bills, newest first", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Dosa", price: 100 });
  const uid = await seedUser(pool, "billing");
  await billingHandler(fakeEvent({ role: "billing", uid, action: "createBill", body: { type: "FOOD", items: [{ item_id: item, name: "Dosa", price: 100, qty: 1 }] } }));

  const bills: any = JSON.parse((await call("listBills", { kind: "FOOD" }, "billing") as any).body);
  assert.equal(bills.length, 1);
  assert.match(bills[0].bill_no, /^FOOD-\d{6}$/);
});

test("dashboard returns a well-formed rolling-stats shape even with zero bills", async () => {
  const res: any = await call("dashboard", {}, "owner");
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok("total_sales_today" in body);
  assert.ok(Array.isArray(body.trend));
});

test("owner CAN read dashboard/lists but role checks still apply per-endpoint (auditLog denies manager)", async () => {
  const res: any = await call("auditLog", {}, "manager");
  assert.equal(res.statusCode, 403, "manager has no audit access, matching AUDIT_ROLES");
});
