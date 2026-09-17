/**
 * Phase 9 — POST /api/website/orders idempotency (authoritative, concurrency-safe).
 *
 * Same Idempotency-Key ⇒ the SAME WebsiteOrder, never a 2nd WEB-xxxxxx, never a
 * 2nd Razorpay provider order — sequentially AND under concurrent delivery from
 * multiple would-be Cloud Function instances (simulated with Promise.all against
 * the single emulator instance; the Firestore transaction lock is what matters).
 */
import "./_app.mjs";
import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getFirestore } from "firebase-admin/firestore";
import { wipe, seedCatalog, fnUrl } from "./_seed.mjs";

const db = getFirestore();
const KEY = "test-website-key";

const postOrder = (body, idemKey) =>
  fetch(fnUrl("websiteApi") + "/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-Key": KEY,
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
    },
    body: JSON.stringify(body),
  });

const CART = () => ({
  items: [{ id: "item_food_1", qty: 2 }, { id: "item_alc_1", qty: 1 }],
  customer: { name: "Idem Customer", phone: "9800011122", email: "i@x.com" },
  fulfillment: { type: "pickup", pickupAt: "2026-09-10T12:30:00.000Z", notes: "" },
});

before(() => assert.ok(process.env.FIRESTORE_EMULATOR_HOST));
beforeEach(async () => {
  await wipe(["categories", "catalog", "tables", "bills", "counters", "auditLog", "websiteOrders", "websitePayments", "websiteOrderIdempotency"]);
  await seedCatalog();
});

// ------------------------------------------------------------- validation

test("Idempotency-Key format is enforced (^[A-Za-z0-9._:-]{8,128}$)", async () => {
  assert.equal((await postOrder(CART(), "short")).status, 400); // < 8
  assert.equal((await postOrder(CART(), "has space here")).status, 400);
  assert.equal((await postOrder(CART(), "x".repeat(129))).status, 400);
  assert.equal((await postOrder(CART(), "ok.key:with-allowed_chars.123")).status, 201); // valid
});

test("no Idempotency-Key -> endpoint still works (contract preserved)", async () => {
  const a = await postOrder(CART());
  const b = await postOrder(CART());
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual((await a.json()).ref, (await b.json()).ref); // two distinct orders
  assert.equal((await db.collection("websiteOrders").get()).size, 2);
});

// ------------------------------------------------------- sequential replay

test("same key + same body -> the SAME order, no 2nd WEB id, no 2nd provider order", async () => {
  const r1 = await postOrder(CART(), "k-seq-0001");
  assert.equal(r1.status, 201);
  const o1 = await r1.json();
  assert.equal(o1.ref, "WEB-000001");

  const r2 = await postOrder(CART(), "k-seq-0001");
  assert.equal(r2.status, 201);
  const o2 = await r2.json();

  assert.equal(o2.ref, o1.ref); // same Order ID
  assert.equal(o2.payment.providerOrderId, o1.payment.providerOrderId); // same Razorpay order
  assert.equal(o2.totalPaise, o1.totalPaise);

  assert.equal((await db.collection("websiteOrders").get()).size, 1);
  assert.equal((await db.collection("counters").doc("websiteOrder").get()).data().value, 1);
  const idem = (await db.collection("websiteOrderIdempotency").doc("k-seq-0001").get()).data();
  assert.equal(idem.status, "done");
  assert.equal(idem.ref, "WEB-000001");
});

test("same key + DIFFERENT body -> 422 conflict, original order untouched", async () => {
  await postOrder(CART(), "k-conflict-1");
  const diff = { ...CART(), items: [{ id: "item_food_1", qty: 5 }] };
  const r = await postOrder(diff, "k-conflict-1");
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /different request/i);
  assert.equal((await db.collection("websiteOrders").get()).size, 1);
});

test("a 422 (bad cart) does NOT burn the key — a corrected retry with the same key succeeds", async () => {
  const bad = { ...CART(), items: [{ id: "item_missing", qty: 1 }] };
  const r1 = await postOrder(bad, "k-recover-1");
  assert.equal(r1.status, 422);
  // same key, now a valid cart with the SAME hash? no — different body. Use a fresh key semantics:
  // the point: the lock was released, so re-using it with the (now different) valid body must work.
  const r2 = await postOrder(CART(), "k-recover-1");
  assert.equal(r2.status, 201);
  assert.equal((await db.collection("websiteOrders").get()).size, 1);
});

// -------------------------------------------------------- concurrent race

test("N concurrent requests, one key -> exactly ONE order, ONE counter tick, ONE provider order", async () => {
  const N = 6;
  const results = await Promise.all(Array.from({ length: N }, () => postOrder(CART(), "k-race-0001")));
  const bodies = await Promise.all(results.map((r) => r.json().catch(() => ({}))));

  // every response is either the created order (201) or 409 "still processing"
  const created = [];
  for (let i = 0; i < N; i++) {
    const st = results[i].status;
    assert.ok(st === 201 || st === 409, `unexpected status ${st}`);
    if (st === 201) created.push(bodies[i]);
  }
  assert.ok(created.length >= 1, "at least one request must succeed");

  // exactly one order, one counter increment
  const orders = await db.collection("websiteOrders").get();
  assert.equal(orders.size, 1);
  assert.equal((await db.collection("counters").doc("websiteOrder").get()).data().value, 1);

  // every 201 refers to the SAME order + SAME provider order (no 2nd Razorpay order)
  const ref = orders.docs[0].data().ref;
  const providerOrderId = orders.docs[0].data().payment.providerOrderId;
  for (const c of created) {
    assert.equal(c.ref, ref);
    assert.equal(c.payment.providerOrderId, providerOrderId);
  }
  // and only ONE provider order id exists across the whole run
  const providerIds = new Set(created.map((c) => c.payment.providerOrderId));
  assert.equal(providerIds.size, 1);
});

test("post-race replay returns the same order (lock cached as 'done')", async () => {
  await Promise.all(Array.from({ length: 4 }, () => postOrder(CART(), "k-race-0002")));
  const again = await postOrder(CART(), "k-race-0002");
  assert.equal(again.status, 201);
  const o = await again.json();
  const ref = (await db.collection("websiteOrders").get()).docs[0].data().ref;
  assert.equal(o.ref, ref);
  assert.equal((await db.collection("websiteOrders").get()).size, 1);
});
