import test, { before, after } from "node:test";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

let env;
before(async () => {
  env = await makeEnv("demo-rules-bills");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "bills/bill_food_1"), { billNo: "FOOD-000001", type: "FOOD", grandTotal: 714, status: "confirmed" });
    await setDoc(doc(d, "counters/foodBill"), { value: 1, prefix: "FOOD" });
    await setDoc(doc(d, "_migration/status"), { ok: true });
  });
});
after(async () => { await env?.cleanup(); });

test("bills: staff read; owner + anon denied", async () => {
  await assertSucceeds(getDoc(doc(asRole(env, "s", "billing"), "bills/bill_food_1")));
  await assertSucceeds(getDocs(collection(asRole(env, "m", "manager"), "bills")));
  await assertFails(getDoc(doc(asRole(env, "o", "owner"), "bills/bill_food_1")));
  await assertFails(getDoc(doc(anon(env), "bills/bill_food_1")));
});

test("bills are immutable — no create / update / delete for ANY role (Function/Admin SDK only)", async () => {
  for (const r of ["billing", "manager", "admin"]) {
    const d = asRole(env, r, r);
    await assertFails(setDoc(doc(d, "bills/bill_food_2"), { billNo: "FOOD-000002", type: "FOOD" }));
    await assertFails(updateDoc(doc(d, "bills/bill_food_1"), { grandTotal: 0 }));
    await assertFails(updateDoc(doc(d, "bills/bill_food_1"), { status: "void" }));
    await assertFails(deleteDoc(doc(d, "bills/bill_food_1")));
  }
});

test("counters are completely sealed", async () => {
  for (const r of ["billing", "manager", "admin", "owner"]) {
    const d = asRole(env, r, r);
    await assertFails(getDoc(doc(d, "counters/foodBill")));
    await assertFails(setDoc(doc(d, "counters/foodBill"), { value: 999 }));
    await assertFails(updateDoc(doc(d, "counters/foodBill"), { value: 999 }));
  }
});

test("_migration bookkeeping is Admin-SDK only", async () => {
  const a = asRole(env, "a", "admin");
  await assertFails(getDoc(doc(a, "_migration/status")));
  await assertFails(setDoc(doc(a, "_migration/status"), { ok: false }));
});
