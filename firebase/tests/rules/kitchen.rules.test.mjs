import test, { before, after } from "node:test";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

let env;
before(async () => {
  env = await makeEnv("demo-rules-kitchen");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "kitchenTickets/t1"), {
      source: "qr", sourceId: "ref1", ref: "QR-000001", tableLabel: "Table 01",
      items: [{ name: "Paneer Tikka", kind: "food", qty: 2, note: "" }],
      status: "QUEUED", createdAt: new Date(),
    });
    await setDoc(doc(d, "catalog/item_food_1"), { name: "Paneer Tikka", kind: "food", status: "active", price: 220 });
    await setDoc(doc(d, "bills/bill_food_1"), { billNo: "FOOD-000001", type: "FOOD", grandTotal: 100 });
  });
});
after(async () => { await env?.cleanup(); });

test("kitchenTickets: kitchen/manager/admin read; billing, cafe, owner, anon denied", async () => {
  await assertSucceeds(getDocs(collection(asRole(env, "k", "kitchen"), "kitchenTickets")));
  await assertSucceeds(getDoc(doc(asRole(env, "m", "manager"), "kitchenTickets/t1")));
  await assertSucceeds(getDoc(doc(asRole(env, "a", "admin"), "kitchenTickets/t1")));
  await assertFails(getDocs(collection(asRole(env, "b", "billing"), "kitchenTickets")));
  await assertFails(getDocs(collection(asRole(env, "c", "cafe_billing"), "kitchenTickets")));
  await assertFails(getDocs(collection(asRole(env, "o", "owner"), "kitchenTickets")));
  await assertFails(getDoc(doc(anon(env), "kitchenTickets/t1")));
});

test("kitchenTickets: create + delete are Function-only for everyone", async () => {
  for (const r of ["kitchen", "billing", "manager", "admin"]) {
    const d = asRole(env, r, r);
    await assertFails(setDoc(doc(d, "kitchenTickets/t2"), { status: "QUEUED", source: "qr" }));
    await assertFails(deleteDoc(doc(d, "kitchenTickets/t1")));
  }
});

test("kitchenTickets: kitchen may step status one legal way; billing cannot; illegal steps blocked", async () => {
  const k = asRole(env, "k", "kitchen");
  await assertSucceeds(updateDoc(doc(k, "kitchenTickets/t1"), { status: "PREPARING", updatedAt: 1 }));
  // billing cannot touch tickets at all
  await assertFails(updateDoc(doc(asRole(env, "b", "billing"), "kitchenTickets/t1"), { status: "READY", updatedAt: 1 }));
  // cannot rewrite the items / ref
  await assertFails(updateDoc(doc(k, "kitchenTickets/t1"), { status: "READY", ref: "hacked" }));
});

test("catalog + tables are now readable by kitchen and cafe (item names for tickets / cafe menu)", async () => {
  await assertSucceeds(getDoc(doc(asRole(env, "k", "kitchen"), "catalog/item_food_1")));
  await assertSucceeds(getDoc(doc(asRole(env, "c", "cafe_billing"), "catalog/item_food_1")));
});

test("bills: cafe may read (its CAFE series lives here); kitchen may NOT", async () => {
  await assertSucceeds(getDoc(doc(asRole(env, "c", "cafe_billing"), "bills/bill_food_1")));
  await assertFails(getDoc(doc(asRole(env, "k", "kitchen"), "bills/bill_food_1")));
});
