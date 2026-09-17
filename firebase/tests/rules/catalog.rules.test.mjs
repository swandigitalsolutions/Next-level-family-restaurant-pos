import test, { before, after } from "node:test";
import { doc, getDoc, setDoc, getDocs, collection } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

let env;
before(async () => {
  env = await makeEnv("demo-rules-catalog");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "categories/cat_food_1"), { kind: "food", name: "Starters", status: "active", sortOrder: 0 });
    await setDoc(doc(d, "catalog/item_food_1"), { kind: "food", name: "Paneer Tikka", price: 220, status: "active" });
    await setDoc(doc(d, "tables/tbl_1"), { tableNo: "Table 01", status: "occupied", qrToken: "tok_1" });
    await setDoc(doc(d, "stats/rolling"), { trend: [] });
    await setDoc(doc(d, "config/website"), { updatedAt: 0 });
  });
});
after(async () => { await env?.cleanup(); });

test("catalog/categories/tables: staff read, owner + anon denied", async () => {
  for (const p of ["categories/cat_food_1", "catalog/item_food_1", "tables/tbl_1"]) {
    await assertSucceeds(getDoc(doc(asRole(env, "s", "billing"), p)));
    await assertSucceeds(getDoc(doc(asRole(env, "m", "manager"), p)));
    await assertSucceeds(getDoc(doc(asRole(env, "a", "admin"), p)));
    await assertFails(getDoc(doc(asRole(env, "o", "owner"), p)));   // owner is dashboard-only
    await assertFails(getDoc(doc(anon(env), p)));
  }
});

test("catalog/categories/tables: no client writes at all", async () => {
  const a = asRole(env, "a", "admin");
  await assertFails(setDoc(doc(a, "catalog/item_food_2"), { name: "x" }));
  await assertFails(setDoc(doc(a, "catalog/item_food_1"), { price: 1 }));
  await assertFails(setDoc(doc(a, "categories/cat_food_2"), { name: "x" }));
  await assertFails(setDoc(doc(a, "tables/tbl_2"), { tableNo: "x" }));
});

test("tables cannot be enumerated by an unauthenticated customer (qrToken lookup is Function-only)", async () => {
  await assertFails(getDocs(collection(anon(env), "tables")));
});

test("stats + config: staff AND owner read; nobody writes", async () => {
  for (const r of ["billing", "manager", "admin", "owner"]) {
    await assertSucceeds(getDoc(doc(asRole(env, r, r), "stats/rolling")));
    await assertSucceeds(getDoc(doc(asRole(env, r, r), "config/website")));
  }
  await assertFails(getDoc(doc(anon(env), "stats/rolling")));
  await assertFails(setDoc(doc(asRole(env, "a", "admin"), "stats/rolling"), { trend: [] }));
  await assertFails(setDoc(doc(asRole(env, "a", "admin"), "config/website"), { updatedAt: 1 }));
});
