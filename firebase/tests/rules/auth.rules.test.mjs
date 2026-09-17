/**
 * Firestore rules — auth surface: users / userCredentials / auditLog / counters
 * and role-claim scoping. Catalog / sessions / bills / qrOrders behaviour lives
 * in the sibling *.rules.test.mjs files.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon, noRole } from "./_helpers.mjs";

let env;
before(async () => {
  env = await makeEnv("demo-rules-auth");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "catalog/item1"), { name: "Dal", price: 150, status: "active" });
    await setDoc(doc(d, "auditLog/a1"), { action: "bill.create" });
    await setDoc(doc(d, "counters/foodBill"), { value: 1 });
    await setDoc(doc(d, "authThrottle/x"), { count: 1, lockedAt: 0 });
    await setDoc(doc(d, "stats/rolling"), { trend: [] });
    await setDoc(doc(d, "users/staff-uid"), { username: "cashier1", role: "billing", status: "active" });
    await setDoc(doc(d, "users/other-uid"), { username: "cashier2", role: "billing", status: "active" });
    await setDoc(doc(d, "userCredentials/staff-uid"), {
      usernameLower: "cashier1",
      passwordHash: "scrypt:32768:8:1$salt$deadbeef",
    });
  });
});
after(async () => { await env?.cleanup(); });

test("unauthenticated gets nothing role-scoped", async () => {
  await assertFails(getDoc(doc(anon(env), "catalog/item1")));
  await assertFails(getDoc(doc(anon(env), "users/staff-uid")));
  await assertFails(getDoc(doc(anon(env), "auditLog/a1")));
});

test("a signed-in user with no / bogus role claim gets nothing", async () => {
  await assertFails(getDoc(doc(noRole(env, "x"), "catalog/item1")));
  const bogus = env.authenticatedContext("y", { role: "superadmin" }).firestore();
  await assertFails(getDoc(doc(bogus, "catalog/item1")));
});

test("billing cannot read the audit log or other users", async () => {
  const d = asRole(env, "staff-uid", "billing");
  await assertFails(getDoc(doc(d, "auditLog/a1")));
  await assertFails(getDoc(doc(d, "users/other-uid")));
});

test("audit log: admin + owner read; manager / billing / kitchen / cafe_billing denied", async () => {
  await assertSucceeds(getDoc(doc(asRole(env, "adm", "admin"), "auditLog/a1")));
  await assertSucceeds(getDoc(doc(asRole(env, "own", "owner"), "auditLog/a1")));
  for (const r of ["manager", "billing", "kitchen", "cafe_billing"]) {
    await assertFails(getDoc(doc(asRole(env, r, r), "auditLog/a1")));
  }
});

test("a user may read their own users/{uid} doc, and it carries no credential", async () => {
  const snap = await assertSucceeds(getDoc(doc(asRole(env, "staff-uid", "billing"), "users/staff-uid")));
  assert.equal(snap.data().passwordHash, undefined);
});

test("admin reads the audit log and any user doc", async () => {
  const d = asRole(env, "admin-uid", "admin");
  await assertSucceeds(getDoc(doc(d, "auditLog/a1")));
  await assertSucceeds(getDoc(doc(d, "users/other-uid")));
});

test("users/* is never client-writable (Function/Admin SDK only)", async () => {
  await assertFails(setDoc(doc(asRole(env, "admin-uid", "admin"), "users/staff-uid"), { role: "admin" }));
});

test("userCredentials is unreadable by EVERYONE — anon, self, staff, admin", async () => {
  await assertFails(getDoc(doc(anon(env), "userCredentials/staff-uid")));
  await assertFails(getDoc(doc(asRole(env, "staff-uid", "billing"), "userCredentials/staff-uid")));
  await assertFails(getDoc(doc(asRole(env, "mgr", "manager"), "userCredentials/staff-uid")));
  await assertFails(getDoc(doc(asRole(env, "adm", "admin"), "userCredentials/staff-uid")));
});

test("userCredentials is unwritable by EVERYONE", async () => {
  await assertFails(setDoc(doc(anon(env), "userCredentials/x"), { passwordHash: "h" }));
  await assertFails(setDoc(doc(asRole(env, "staff-uid", "billing"), "userCredentials/staff-uid"), { passwordHash: "h" }));
  await assertFails(setDoc(doc(asRole(env, "adm", "admin"), "userCredentials/staff-uid"), { passwordHash: "h" }));
});

test("auditLog: no client create / update / delete", async () => {
  const a = asRole(env, "admin-uid", "admin");
  await assertFails(setDoc(doc(a, "auditLog/a2"), { action: "hack" }));
});

test("counters + authThrottle are sealed for every role", async () => {
  for (const role of ["billing", "manager", "admin", "owner"]) {
    const d = asRole(env, `${role}-uid`, role);
    await assertFails(getDoc(doc(d, "counters/foodBill")));
    await assertFails(getDoc(doc(d, "authThrottle/x")));
    await assertFails(setDoc(doc(d, "counters/foodBill"), { value: 9 }));
  }
});
