import test, { before, after, beforeEach } from "node:test";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

let env;
const OPEN = {
  tableId: "tbl_1", tableNo: "Table 01", status: "open",
  customerName: "Walk-in", customerPhone: "-",
  items: [{ kind: "food", itemId: "item_food_1", itemName: "Paneer Tikka", brand: "", bottleSize: "", price: 220, qty: 1, taxRate: 5, lineTotal: 220 }],
  subtotal: 220, tax: 11, grandTotal: 231, openedByUid: "u_2", legacyId: 1,
};

before(async () => { env = await makeEnv("demo-rules-sessions"); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "tableSessions/sess_1"), OPEN);
    await setDoc(doc(d, "tableSessions/sess_2"), { ...OPEN, status: "settled", settledAt: 1 });
  });
});

test("staff read; non-staff denied", async () => {
  await assertSucceeds(getDoc(doc(asRole(env, "s", "billing"), "tableSessions/sess_1")));
  await assertFails(getDoc(doc(asRole(env, "o", "owner"), "tableSessions/sess_1")));
  await assertFails(getDoc(doc(anon(env), "tableSessions/sess_1")));
});

test("staff may edit an OPEN session's cart + customer fields", async () => {
  const s = asRole(env, "s", "billing");
  await assertSucceeds(updateDoc(doc(s, "tableSessions/sess_1"), {
    customerName: "Priya", customerPhone: "999", items: [], subtotal: 0, tax: 0, grandTotal: 0, updatedAt: 1,
  }));
});

test("staff may NOT flip status, settledAt, settledBillIds, tableId, openedByUid", async () => {
  const s = asRole(env, "s", "billing");
  await assertFails(updateDoc(doc(s, "tableSessions/sess_1"), { status: "settled" }));
  await assertFails(updateDoc(doc(s, "tableSessions/sess_1"), { settledAt: 123 }));
  await assertFails(updateDoc(doc(s, "tableSessions/sess_1"), { settledBillIds: ["bill_food_9"] }));
  await assertFails(updateDoc(doc(s, "tableSessions/sess_1"), { tableId: "tbl_9" }));
  await assertFails(updateDoc(doc(s, "tableSessions/sess_1"), { openedByUid: "u_1" }));
  await assertFails(updateDoc(doc(s, "tableSessions/sess_1"), { items: [], legacyId: 99 }));
});

test("a SETTLED session is frozen to clients", async () => {
  const s = asRole(env, "s", "billing");
  await assertFails(updateDoc(doc(s, "tableSessions/sess_2"), { customerName: "x", updatedAt: 1 }));
});

test("session creation + deletion are Function-only", async () => {
  const s = asRole(env, "s", "billing");
  await assertFails(setDoc(doc(s, "tableSessions/sess_new"), OPEN));
});

test("non-staff cannot edit even an open session", async () => {
  await assertFails(updateDoc(doc(asRole(env, "o", "owner"), "tableSessions/sess_1"), { customerName: "x", updatedAt: 1 }));
  await assertFails(updateDoc(doc(anon(env), "tableSessions/sess_1"), { customerName: "x", updatedAt: 1 }));
});
