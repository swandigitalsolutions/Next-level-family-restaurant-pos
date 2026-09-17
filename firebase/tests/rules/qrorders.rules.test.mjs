import test, { before, after, beforeEach } from "node:test";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

let env;
const ORDER = (over = {}) => ({
  orderNo: "QR-000001", publicRef: "ref_1", tableId: "tbl_1", tableNo: "Table 01",
  customerName: "Guest", note: null, status: "NEW",
  subtotal: 220, tax: 0, grandTotal: 220, pushedToBill: false, tableSessionId: null,
  items: [{ kind: "food", itemId: "item_food_1", itemName: "Paneer Tikka", brand: "", bottleSize: "", price: 220, qty: 1, taxRate: 0, lineTotal: 220 }],
  legacyId: 1, ...over,
});

before(async () => { env = await makeEnv("demo-rules-qr"); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "qrOrders/ref_new"), ORDER({ status: "NEW" }));
    await setDoc(doc(d, "qrOrders/ref_prep"), ORDER({ status: "PREPARING" }));
    await setDoc(doc(d, "qrOrders/ref_served"), ORDER({ status: "SERVED" }));
  });
});

test("anyone may GET a single order by its opaque ref (customer tracker)", async () => {
  await assertSucceeds(getDoc(doc(anon(env), "qrOrders/ref_new")));
});

test("only staff may LIST/query qrOrders (the kitchen board)", async () => {
  await assertSucceeds(getDocs(collection(asRole(env, "s", "billing"), "qrOrders")));
  await assertFails(getDocs(collection(anon(env), "qrOrders")));
  await assertFails(getDocs(collection(asRole(env, "o", "owner"), "qrOrders")));
});

test("staff may advance status one legal FSM step", async () => {
  const s = asRole(env, "s", "billing");
  await assertSucceeds(updateDoc(doc(s, "qrOrders/ref_new"), { status: "ACCEPTED", updatedAt: 1 }));
  await assertSucceeds(updateDoc(doc(s, "qrOrders/ref_prep"), { status: "READY", updatedAt: 1 }));
});

test("staff may cancel any non-terminal order", async () => {
  const s = asRole(env, "s", "billing");
  await assertSucceeds(updateDoc(doc(s, "qrOrders/ref_prep"), { status: "CANCELLED", updatedAt: 1 }));
});

test("illegal transitions are rejected", async () => {
  const s = asRole(env, "s", "billing");
  await assertFails(updateDoc(doc(s, "qrOrders/ref_new"), { status: "READY", updatedAt: 1 }));      // skip
  await assertFails(updateDoc(doc(s, "qrOrders/ref_prep"), { status: "NEW", updatedAt: 1 }));        // backwards
  await assertFails(updateDoc(doc(s, "qrOrders/ref_served"), { status: "PREPARING", updatedAt: 1 })); // from terminal
  await assertFails(updateDoc(doc(s, "qrOrders/ref_served"), { status: "CANCELLED", updatedAt: 1 })); // cancel terminal
});

test("changing anything other than status/updatedAt is rejected", async () => {
  const s = asRole(env, "s", "billing");
  await assertFails(updateDoc(doc(s, "qrOrders/ref_new"), { status: "ACCEPTED", grandTotal: 1 }));
  await assertFails(updateDoc(doc(s, "qrOrders/ref_new"), { status: "ACCEPTED", pushedToBill: true }));
  await assertFails(updateDoc(doc(s, "qrOrders/ref_new"), { status: "ACCEPTED", items: [] }));
  await assertFails(updateDoc(doc(s, "qrOrders/ref_new"), { status: "ACCEPTED", tableSessionId: "sess_1" }));
});

test("create + delete are Function-only; non-staff cannot update", async () => {
  await assertFails(setDoc(doc(asRole(env, "s", "billing"), "qrOrders/ref_x"), ORDER()));
  await assertFails(updateDoc(doc(anon(env), "qrOrders/ref_new"), { status: "ACCEPTED", updatedAt: 1 }));
  await assertFails(updateDoc(doc(asRole(env, "o", "owner"), "qrOrders/ref_new"), { status: "ACCEPTED", updatedAt: 1 }));
});
