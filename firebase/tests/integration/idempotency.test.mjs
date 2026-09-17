/**
 * ETL runs twice against the same emulator -> identical doc counts and identical
 * key documents. Proves "no duplicate or partially migrated records"
 * (deterministic ids + set() without merge).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { openSource } from "../../scripts/lib/source.mjs";
import { transformAll } from "../../scripts/lib/transform.mjs";
import { makeTarget, COLLECTIONS } from "../../scripts/lib/target.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, "..", "..", "scripts", "fixtures", "etl-source.sqlite");

let app;
let db;
before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
  app = initializeApp({ projectId: "demo-nextlevel-int" }, "idem-" + Date.now());
  db = getFirestore(app);
});
after(async () => {
  await deleteApp(app).catch(() => {});
});

async function runEtlOnce() {
  const src = await openSource(SOURCE);
  const { docs } = transformAll(src);
  const target = await makeTarget({ mode: "emulator", projectId: "demo-nextlevel-int" });
  for (const c of COLLECTIONS) await target.writeCollection(c, docs[c]);
  await target.close();
  src.close();
  return docs;
}

async function counts() {
  const out = {};
  for (const c of COLLECTIONS) out[c] = (await db.collection(c).count().get()).data().count;
  return out;
}

test("second ETL run does not add or duplicate documents", async () => {
  const planned = await runEtlOnce();
  const after1 = await counts();
  for (const c of COLLECTIONS) assert.equal(after1[c], planned[c].length, `run1 ${c}`);

  const bill1a = (await db.collection("bills").doc("bill_food_2").get()).data();
  const cnt1a = (await db.collection("counters").doc("foodBill").get()).data().value;

  await runEtlOnce();
  const after2 = await counts();
  assert.deepEqual(after2, after1, "counts identical after the second run");

  const bill1b = (await db.collection("bills").doc("bill_food_2").get()).data();
  const cnt1b = (await db.collection("counters").doc("foodBill").get()).data().value;
  assert.equal(bill1b.grandTotal, bill1a.grandTotal);
  assert.equal(bill1b.billNo, "FOOD-000002");
  assert.equal(cnt1b, cnt1a, "counter value stable across re-runs");
});
