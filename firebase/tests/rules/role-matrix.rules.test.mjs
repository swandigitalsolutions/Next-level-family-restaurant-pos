/**
 * Firestore rules — the full 6-role read/write matrix, collection by collection.
 * Complements the per-collection specs; this one is the single "no role can do
 * more than its row" sweep.
 */
import test, { before, after } from "node:test";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

const ROLES = ["admin", "owner", "manager", "billing", "kitchen", "cafe_billing"];
let env;

before(async () => {
  env = await makeEnv("demo-rules-matrix");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "categories/c1"), { kind: "food", salesChannel: "RESTAURANT", name: "Mains", status: "active", sortOrder: 0 });
    await setDoc(doc(d, "catalog/i1"), { kind: "food", salesChannel: "RESTAURANT", name: "Dal", status: "active", price: 120 });
    await setDoc(doc(d, "tables/t1"), { tableNo: "Table 01", status: "available", qrToken: "tok" });
    await setDoc(doc(d, "tableSessions/s1"), { tableId: "t1", status: "open", items: [], customerName: "x", customerPhone: "-", subtotal: 0, tax: 0, grandTotal: 0 });
    await setDoc(doc(d, "bills/b1"), { billNo: "FOOD-000001", type: "FOOD", grandTotal: 120, status: "confirmed" });
    await setDoc(doc(d, "qrOrders/q1"), { orderNo: "QR-000001", status: "NEW", items: [], grandTotal: 0 });
    await setDoc(doc(d, "websiteOrders/w1"), { ref: "WEB-000001", status: "PENDING_PAYMENT", totalPaise: 12000 });
    await setDoc(doc(d, "websitePayments/p1"), { ref: "WEB-000001" });
    await setDoc(doc(d, "websiteOrderIdempotency/k1"), { status: "done", orderId: "w1" });
    await setDoc(doc(d, "kitchenTickets/kt1"), { source: "qr", sourceId: "q1", ref: "QR-000001", status: "QUEUED", items: [] });
    await setDoc(doc(d, "counters/foodBill"), { value: 5, prefix: "FOOD" });
    await setDoc(doc(d, "auditLog/a1"), { action: "bill.create" });
    await setDoc(doc(d, "stats/rolling"), { today: {} });
    await setDoc(doc(d, "config/website"), { updatedAt: 1 });
    await setDoc(doc(d, "users/u1"), { username: "u1", role: "billing", status: "active" });
    await setDoc(doc(d, "userCredentials/u1"), { passwordHash: "scrypt:x" });
    await setDoc(doc(d, "authThrottle/ip1"), { count: 1 });
  });
});
after(async () => { await env?.cleanup(); });

const canRead = {
  "categories/c1": ["admin", "manager", "billing", "kitchen", "cafe_billing"],
  "catalog/i1": ["admin", "manager", "billing", "kitchen", "cafe_billing"],
  "tables/t1": ["admin", "manager", "billing", "kitchen", "cafe_billing"],
  "tableSessions/s1": ["admin", "manager", "billing"],
  "bills/b1": ["admin", "manager", "billing", "cafe_billing"],
  "qrOrders/q1": ROLES, // get is public (opaque ref)
  "websiteOrders/w1": ["admin", "manager", "billing"],
  "kitchenTickets/kt1": ["admin", "manager", "kitchen"],
  "auditLog/a1": ["admin", "owner"],
  "stats/rolling": ["admin", "owner", "manager", "billing", "kitchen", "cafe_billing"],
  "config/website": ["admin", "owner", "manager", "billing", "kitchen", "cafe_billing"],
  "users/u1": ["admin"], // + self, not covered here
};
const sealedRead = ["websitePayments/p1", "websiteOrderIdempotency/k1", "counters/foodBill", "userCredentials/u1", "authThrottle/ip1"];

test("READ matrix — each collection readable by exactly its allowed roles", async () => {
  for (const [path, allowed] of Object.entries(canRead)) {
    for (const r of ROLES) {
      const ref = doc(asRole(env, `${r}-u`, r), path);
      if (allowed.includes(r)) await assertSucceeds(getDoc(ref));
      else await assertFails(getDoc(ref));
    }
    if (path !== "qrOrders/q1") await assertFails(getDoc(doc(anon(env), path)));
  }
  await assertSucceeds(getDoc(doc(anon(env), "qrOrders/q1"))); // opaque public ref (order tracker)
});

test("SEALED collections — no role (incl. admin) can read", async () => {
  for (const path of sealedRead) {
    for (const r of [...ROLES]) {
      await assertFails(getDoc(doc(asRole(env, `${r}-u`, r), path)));
    }
  }
});

test("WRITE matrix — financial / trusted collections reject EVERY client role", async () => {
  const sealedWrite = [
    "bills/b1", "counters/foodBill", "auditLog/a1", "stats/rolling", "config/website",
    "users/u1", "userCredentials/u1", "websitePayments/p1", "websiteOrderIdempotency/k1",
    "categories/c1", "catalog/i1", "tables/t1", "authThrottle/ip1",
  ];
  for (const path of sealedWrite) {
    for (const r of ROLES) {
      const d = asRole(env, `${r}-u`, r);
      await assertFails(setDoc(doc(d, path), { hacked: true }));
      await assertFails(updateDoc(doc(d, path), { hacked: true }));
      await assertFails(deleteDoc(doc(d, path)));
    }
  }
});

test("WRITE matrix — websiteOrders / kitchenTickets create+delete are Function-only for all roles", async () => {
  for (const r of ROLES) {
    const d = asRole(env, `${r}-u`, r);
    await assertFails(setDoc(doc(d, "websiteOrders/w2"), { ref: "WEB-000002" }));
    await assertFails(deleteDoc(doc(d, "websiteOrders/w1")));
    await assertFails(updateDoc(doc(d, "websiteOrders/w1"), { paidPaise: 1, totalPaise: 0 }));
    await assertFails(setDoc(doc(d, "kitchenTickets/kt2"), { status: "QUEUED" }));
    await assertFails(deleteDoc(doc(d, "kitchenTickets/kt1")));
  }
});

test("the intentionally-permitted client writes still work for their role only", async () => {
  // billing may edit an OPEN table session's cart fields
  await assertSucceeds(updateDoc(doc(asRole(env, "b", "billing"), "tableSessions/s1"),
    { customerName: "New", items: [], subtotal: 0, tax: 0, grandTotal: 0, updatedAt: 1 }));
  await assertFails(updateDoc(doc(asRole(env, "k", "kitchen"), "tableSessions/s1"), { customerName: "x", updatedAt: 1 }));
  await assertFails(updateDoc(doc(asRole(env, "c", "cafe_billing"), "tableSessions/s1"), { customerName: "x", updatedAt: 1 }));

  // billing may advance a qrOrder one legal FSM step
  await assertSucceeds(updateDoc(doc(asRole(env, "b", "billing"), "qrOrders/q1"), { status: "ACCEPTED", updatedAt: 1 }));
  await assertFails(updateDoc(doc(asRole(env, "o", "owner"), "qrOrders/q1"), { status: "PREPARING", updatedAt: 1 }));

  // kitchen may step a ticket one legal way
  await assertSucceeds(updateDoc(doc(asRole(env, "k", "kitchen"), "kitchenTickets/kt1"), { status: "PREPARING", updatedAt: 1 }));
  await assertFails(updateDoc(doc(asRole(env, "b", "billing"), "kitchenTickets/kt1"), { status: "READY", updatedAt: 1 }));
});
