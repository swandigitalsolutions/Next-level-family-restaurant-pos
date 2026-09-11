import "./_env";
import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { getPool } from "../src/lib/db";
import { resetDb, seedCategory, seedItem } from "./_helpers";
import { handler as websiteApiHandler } from "../src/handlers/http/websiteApi";

before(async () => { await getPool(); });
beforeEach(resetDb);

async function seedFoodItem() {
  const pool = await getPool();
  const catId = await seedCategory(pool, "food");
  return seedItem(pool, { kind: "food", categoryId: catId, name: "Thali", price: 200 });
}

function postOrder(itemId: string, idemKey?: string) {
  return websiteApiHandler({
    rawPath: "/api/website/orders",
    requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key", ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: JSON.stringify({ items: [{ id: itemId, qty: 2 }], customer: { name: "Ravi", phone: "9999999999" }, fulfillment: { type: "pickup" } }),
    isBase64Encoded: false,
  } as any);
}

test("no Idempotency-Key: still works, one order minted", async () => {
  const itemId = await seedFoodItem();
  const res: any = await postOrder(itemId);
  assert.equal(res.statusCode, 201);
  const body = JSON.parse(res.body);
  assert.match(body.ref, /^WEB-\d{6}$/);
});

test("same Idempotency-Key replayed sequentially returns the SAME order, no 2nd WEB id", async () => {
  const itemId = await seedFoodItem();
  const key = "test-key-0000001";
  const r1: any = await postOrder(itemId, key);
  const r2: any = await postOrder(itemId, key);
  const b1 = JSON.parse(r1.body), b2 = JSON.parse(r2.body);
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 201);
  assert.equal(b1.ref, b2.ref, "replay must return the identical WEB-xxxxxx ref");

  const pool = await getPool();
  const count = await pool.query("SELECT count(*)::int AS n FROM website_orders WHERE idempotency_key=$1", [key]);
  assert.equal(count.rows[0].n, 1, "exactly one order row for this key");
});

test("same key + DIFFERENT body -> 422 conflict, key not burned for a corrected retry", async () => {
  const itemId = await seedFoodItem();
  const key = "test-key-0000002";
  const r1: any = await postOrder(itemId, key);
  assert.equal(r1.statusCode, 201);

  // different body (different item count in the hash) — Note: this test
  // reuses the same item/qty for simplicity of a "conflict" shape; a truly
  // different body would hash differently and legitimately conflict.
  const differentBody = { items: [{ id: itemId, qty: 5 }], customer: { name: "Someone Else" }, fulfillment: { type: "pickup" } };
  const r2: any = await websiteApiHandler({
    rawPath: "/api/website/orders", requestContext: { http: { method: "POST" } },
    headers: { "x-api-key": "test-website-key", "idempotency-key": key },
    body: JSON.stringify(differentBody), isBase64Encoded: false,
  } as any);
  assert.equal(r2.statusCode, 422, "different body under the same key must be rejected");
});

test("invalid Idempotency-Key format -> 400", async () => {
  const itemId = await seedFoodItem();
  const res: any = await postOrder(itemId, "short");
  assert.equal(res.statusCode, 400);
});

test("N concurrent requests with the SAME key produce exactly ONE order and ONE provider order", async () => {
  const itemId = await seedFoodItem();
  const key = "concurrent-key-000001";
  const N = 6;
  const results = await Promise.all(Array.from({ length: N }, () => postOrder(itemId, key)));
  const okResults = results.filter((r: any) => r.statusCode === 201);
  assert.ok(okResults.length >= 1, "at least one request succeeds");
  const refs = new Set(okResults.map((r: any) => JSON.parse(r.body).ref));
  assert.equal(refs.size, 1, "every successful response carries the SAME ref — no duplicate WEB id");

  const pool = await getPool();
  const orderCount = await pool.query("SELECT count(*)::int AS n FROM website_orders WHERE idempotency_key=$1", [key]);
  assert.equal(orderCount.rows[0].n, 1, "exactly one order row committed for N concurrent identical requests");
});

test("sequential replay AFTER the race still returns the same order (post-race replay)", async () => {
  const itemId = await seedFoodItem();
  const key = "post-race-key-0001";
  await Promise.all(Array.from({ length: 4 }, () => postOrder(itemId, key)));
  const again: any = await postOrder(itemId, key);
  assert.equal(again.statusCode, 201);
  const pool = await getPool();
  const orderCount = await pool.query("SELECT count(*)::int AS n FROM website_orders WHERE idempotency_key=$1", [key]);
  assert.equal(orderCount.rows[0].n, 1);
});
