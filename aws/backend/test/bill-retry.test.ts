/**
 * Retry safety for the till's own bill creation.
 *
 * The website channel has had Idempotency-Key handling from the start, but the
 * restaurant's own billing screens did not: a POST the browser had to send
 * twice created two real bills, with two bill numbers and two stock
 * decrements. These tests pin the behaviour that stops that.
 */
import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem, seedUser, fakeEvent } from "./_helpers";
import { handler as billingHandler } from "../src/handlers/callable/billing";

before(async () => { await getPool(); });
beforeEach(resetDb);

async function call(body: unknown, role = "billing") {
  const pool = await getPool();
  const uid = await seedUser(pool, role);
  const res: any = await billingHandler(fakeEvent({ role, action: "createBill", body, uid }));
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function billCount() {
  const pool = await getPool();
  return (await pool.query("SELECT count(*)::int AS n FROM bills")).rows[0].n;
}

test("a retried bill with the same client_ref produces exactly one bill", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Dosa", price: 120, stockQty: 10 });
  const payload = {
    type: "FOOD",
    client_ref: "till-sale-0001-abcd",
    items: [{ item_id: item, name: "Dosa", price: 120, qty: 2 }],
  };

  const first = await call(payload);
  const second = await call(payload);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.bill_no, first.body.bill_no, "the retry must return the original bill");
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.deduplicated, true);
  assert.equal(await billCount(), 1);

  const stock = await pool.query("SELECT stock_qty FROM catalog WHERE id=$1", [item]);
  assert.equal(stock.rows[0].stock_qty, 8, "stock must be decremented once, not twice");
});

test("concurrent retries of one sale still produce exactly one bill", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Idli", price: 60, stockQty: 50 });
  const payload = {
    type: "FOOD",
    client_ref: "till-sale-race-0002",
    items: [{ item_id: item, name: "Idli", price: 60, qty: 1 }],
  };

  const results = await Promise.all(Array.from({ length: 6 }, () => call(payload)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const numbers = new Set(results.map((r) => r.body.bill_no));
  assert.equal(numbers.size, 1, `one sale produced ${numbers.size} distinct bills`);
  assert.equal(await billCount(), 1);

  const stock = await pool.query("SELECT stock_qty FROM catalog WHERE id=$1", [item]);
  assert.equal(stock.rows[0].stock_qty, 49);
});

test("two different sales with different keys are both billed", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Vada", price: 40 });
  const one = await call({ type: "FOOD", client_ref: "sale-aaaa-1111", items: [{ item_id: item, name: "Vada", price: 40, qty: 1 }] });
  const two = await call({ type: "FOOD", client_ref: "sale-bbbb-2222", items: [{ item_id: item, name: "Vada", price: 40, qty: 1 }] });
  assert.notEqual(one.body.bill_no, two.body.bill_no);
  assert.equal(await billCount(), 2);
});

test("a till that sends no key keeps working exactly as before", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Pongal", price: 90 });
  const body = { type: "FOOD", items: [{ item_id: item, name: "Pongal", price: 90, qty: 1 }] };
  const one = await call(body);
  const two = await call(body);
  assert.notEqual(one.body.bill_no, two.body.bill_no, "without a key, two POSTs are two sales");
  assert.equal(await billCount(), 2);
});

test("a malformed key is ignored rather than failing the sale", async () => {
  const pool = await getPool();
  const cat = await seedCategory(pool, "food");
  const item = await seedItem(pool, { kind: "food", categoryId: cat, name: "Upma", price: 70 });
  const res = await call({ type: "FOOD", client_ref: "short", items: [{ item_id: item, name: "Upma", price: 70, qty: 1 }] });
  assert.equal(res.status, 200, "a bad key must never block taking money");
  assert.equal(await billCount(), 1);
});
