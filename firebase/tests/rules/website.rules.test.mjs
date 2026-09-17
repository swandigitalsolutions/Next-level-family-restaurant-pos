import test, { before, after } from "node:test";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { makeEnv, asRole, anon } from "./_helpers.mjs";

let env;
before(async () => {
  env = await makeEnv("demo-rules-website");
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "websiteOrders/w1"), {
      ref: "WEB-000001", channel: "website", status: "CONFIRMED", paymentStatus: "ADVANCE_PAID",
      totalPaise: 22000, advancePaise: 11000, balancePaise: 11000, paidPaise: 11000,
    });
    await setDoc(doc(d, "websitePayments/pay_1"), { ref: "WEB-000001", amountPaise: 11000 });
    await setDoc(doc(d, "counters/websiteOrder"), { value: 1, prefix: "WEB" });
  });
});
after(async () => { await env?.cleanup(); });

test("websiteOrders: staff/manager/admin list + read; owner and anon denied", async () => {
  await assertSucceeds(getDocs(collection(asRole(env, "s", "billing"), "websiteOrders")));
  await assertSucceeds(getDoc(doc(asRole(env, "m", "manager"), "websiteOrders/w1")));
  await assertSucceeds(getDoc(doc(asRole(env, "a", "admin"), "websiteOrders/w1")));
  await assertFails(getDoc(doc(anon(env), "websiteOrders/w1")));                 // website reads via websiteApi + X-API-Key, never Firestore
  await assertFails(getDocs(collection(anon(env), "websiteOrders")));
  await assertFails(getDocs(collection(asRole(env, "o", "owner"), "websiteOrders")));
});

test("websiteOrders: NO client write (create / update / delete) for ANY role", async () => {
  for (const r of ["billing", "manager", "admin"]) {
    const d = asRole(env, r, r);
    await assertFails(setDoc(doc(d, "websiteOrders/w2"), { ref: "WEB-000002" }));
    await assertFails(updateDoc(doc(d, "websiteOrders/w1"), { paidPaise: 999999 }));
    await assertFails(updateDoc(doc(d, "websiteOrders/w1"), { status: "COMPLETED" }));
    await assertFails(updateDoc(doc(d, "websiteOrders/w1"), { totalPaise: 0 }));
    await assertFails(deleteDoc(doc(d, "websiteOrders/w1")));
  }
  await assertFails(updateDoc(doc(anon(env), "websiteOrders/w1"), { balancePaise: 0 }));
});

test("websitePayments (Razorpay webhook idempotency markers) are completely sealed", async () => {
  for (const r of ["billing", "manager", "admin", "owner"]) {
    const d = asRole(env, r, r);
    await assertFails(getDoc(doc(d, "websitePayments/pay_1")));
    await assertFails(setDoc(doc(d, "websitePayments/pay_2"), { amountPaise: 1 }));
  }
  await assertFails(getDoc(doc(anon(env), "websitePayments/pay_1")));
});

test("counters/websiteOrder stays sealed", async () => {
  await assertFails(getDoc(doc(asRole(env, "a", "admin"), "counters/websiteOrder")));
  await assertFails(updateDoc(doc(asRole(env, "a", "admin"), "counters/websiteOrder"), { value: 999 }));
});
