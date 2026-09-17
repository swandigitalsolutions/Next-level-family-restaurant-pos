/**
 * Invariants I2 (gap-safe numbering) and I3 (stock floor) against the real
 * Firestore emulator, using the COMPILED functions primitives.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const { nextNumber } = await import("../../functions/lib/lib/counters.js");
const { applyStockDelta } = await import("../../functions/lib/lib/catalogRepo.js");

let app;
let db;
before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "must run under firebase emulators:exec");
  app = initializeApp({ projectId: "demo-nextlevel-int" }, "int-" + Date.now());
  db = getFirestore(app);
});
after(async () => {
  await deleteApp(app).catch(() => {});
});

async function wipe(colls) {
  for (const c of colls) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

test("I2 — nextNumber is monotonic and gap-free (sequential)", async () => {
  await wipe(["counters"]);
  await db.collection("counters").doc("foodBill").set({ value: 0, prefix: "FOOD" });
  const got = [];
  for (let i = 0; i < 5; i++) {
    const r = await db.runTransaction((tx) => nextNumber(tx, db, "foodBill"));
    got.push(r.formatted);
  }
  assert.deepEqual(got, ["FOOD-000001", "FOOD-000002", "FOOD-000003", "FOOD-000004", "FOOD-000005"]);
  const v = (await db.collection("counters").doc("foodBill").get()).data().value;
  assert.equal(v, 5);
});

test("I2 — CONCURRENT transactions issue each number once (no dup, no gap)", async () => {
  await wipe(["counters"]);
  await db.collection("counters").doc("qrOrder").set({ value: 0, prefix: "QR" });
  // 8-way single-doc contention: past this the *emulator's* transaction
  // lock-timeout (not nextNumber) starts aborting retries; real Firestore uses
  // wider backoff and scales further. 8 already exceeds a busy till.
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      db.runTransaction((tx) => nextNumber(tx, db, "qrOrder"), { maxAttempts: 40 }),
    ),
  );
  const numbers = results.map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: N }, (_, i) => i + 1));
  assert.equal(new Set(numbers).size, N); // no duplicates
  assert.equal(new Set(results.map((r) => r.formatted)).size, N); // formatted strings unique
  const v = (await db.collection("counters").doc("qrOrder").get()).data().value;
  assert.equal(v, N);
});

test("I2 — a second wave continues the sequence without collision", async () => {
  const wave = await Promise.all(
    Array.from({ length: 6 }, () =>
      db.runTransaction((tx) => nextNumber(tx, db, "qrOrder"), { maxAttempts: 40 }),
    ),
  );
  assert.deepEqual(
    wave.map((r) => r.number).sort((a, b) => a - b),
    [9, 10, 11, 12, 13, 14],
  );
});

test("I2 — a missing counter document throws (seed/ETL must create it)", async () => {
  await wipe(["counters"]);
  await assert.rejects(() => db.runTransaction((tx) => nextNumber(tx, db, "alcoholBill")), /missing/);
});

test("I3 — applyStockDelta: decrement, floor at 0, restore; untracked + missing untouched", async () => {
  await wipe(["catalog"]);
  await db.collection("catalog").doc("a").set({ name: "tracked", stockQty: 5 });
  await db.collection("catalog").doc("b").set({ name: "untracked", stockQty: null });

  const stock = async (id) => (await db.collection("catalog").doc(id).get()).data().stockQty;

  await db.runTransaction((tx) => applyStockDelta(tx, db, "a", -3));
  assert.equal(await stock("a"), 2);

  await db.runTransaction((tx) => applyStockDelta(tx, db, "a", -10)); // floor
  assert.equal(await stock("a"), 0);

  await db.runTransaction((tx) => applyStockDelta(tx, db, "a", 4)); // restore path
  assert.equal(await stock("a"), 4);

  await db.runTransaction((tx) => applyStockDelta(tx, db, "b", -1)); // untracked -> untouched
  assert.equal(await stock("b"), null);

  await db.runTransaction((tx) => applyStockDelta(tx, db, "missing", -1)); // no throw
  await db.runTransaction((tx) => applyStockDelta(tx, db, "a", 0)); // no-op
  assert.equal(await stock("a"), 4);
});
