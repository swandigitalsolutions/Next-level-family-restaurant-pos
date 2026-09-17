// Minimal, known dataset for the Phase 4 emulator tests. Admin SDK, direct writes.
import "./_app.mjs";
import { getFirestore } from "firebase-admin/firestore";

export async function wipe(collections) {
  const db = getFirestore();
  for (const c of collections) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

export async function seedCatalog() {
  const db = getFirestore();
  const now = new Date();
  const RC = "RESTAURANT", OC = "OUTSIDE_CAFE";
  const cats = [
    { id: "cat_food_1", kind: "food", salesChannel: RC, name: "Starters", nameLower: "starters", sortOrder: 0, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_food_2", kind: "food", salesChannel: RC, name: "Mains", nameLower: "mains", sortOrder: 1, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_alc_1", kind: "alcohol", salesChannel: RC, name: "Beer", nameLower: "beer", sortOrder: 0, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_1", kind: "cafe", salesChannel: OC, name: "Coffee", nameLower: "coffee", sortOrder: 1, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_2", kind: "cafe", salesChannel: OC, name: "Ice Creams", nameLower: "ice creams", sortOrder: 2, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_3", kind: "cafe", salesChannel: OC, name: "Tea", nameLower: "tea", sortOrder: 0, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_4", kind: "cafe", salesChannel: OC, name: "Water Bottles", nameLower: "water bottles", sortOrder: 3, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_5", kind: "cafe", salesChannel: OC, name: "Cool Drinks", nameLower: "cool drinks", sortOrder: 4, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_6", kind: "cafe", salesChannel: OC, name: "Juices", nameLower: "juices", sortOrder: 5, status: "active", createdAt: now, updatedAt: now },
    { id: "cat_cafe_7", kind: "cafe", salesChannel: OC, name: "Other", nameLower: "other", sortOrder: 6, status: "active", createdAt: now, updatedAt: now },
  ];
  const items = [
    { id: "item_food_1", kind: "food", salesChannel: RC, name: "Paneer Tikka", nameLower: "paneer tikka", categoryId: "cat_food_1", categoryName: "Starters", categorySort: 0, price: 220, taxRate: 0, stockQty: 10, brand: null, bottleSize: null, description: "grilled", status: "active", imagePath: null, createdAt: now, updatedAt: now, legacyId: 1 },
    { id: "item_food_2", kind: "food", salesChannel: RC, name: "Chicken 65", nameLower: "chicken 65", categoryId: "cat_food_1", categoryName: "Starters", categorySort: 0, price: 240, taxRate: 0, stockQty: null, brand: null, bottleSize: null, description: null, status: "active", imagePath: null, createdAt: now, updatedAt: now, legacyId: 2 },
    { id: "item_food_3", kind: "food", salesChannel: RC, name: "Butter Chicken", nameLower: "butter chicken", categoryId: "cat_food_2", categoryName: "Mains", categorySort: 1, price: 280, taxRate: 0, stockQty: 3, brand: null, bottleSize: null, description: null, status: "active", imagePath: null, createdAt: now, updatedAt: now, legacyId: 3 },
    { id: "item_alc_1", kind: "alcohol", salesChannel: RC, name: "Kingfisher Premium", nameLower: "kingfisher premium", categoryId: "cat_alc_1", categoryName: "Beer", categorySort: 0, price: 180, taxRate: 18, stockQty: 24, brand: "Kingfisher", bottleSize: "650ml", description: null, status: "active", imagePath: null, createdAt: now, updatedAt: now, legacyId: 1 },
    { id: "item_cafe_1", kind: "cafe", salesChannel: OC, name: "Filter Coffee", nameLower: "filter coffee", categoryId: "cat_cafe_1", categoryName: "Coffee", categorySort: 1, price: 40, taxRate: 0, stockQty: null, brand: null, bottleSize: null, description: null, status: "active", imagePath: null, createdAt: now, updatedAt: now, legacyId: 1 },
    { id: "item_cafe_2", kind: "cafe", salesChannel: OC, name: "Vanilla Ice Cream", nameLower: "vanilla ice cream", categoryId: "cat_cafe_2", categoryName: "Ice Creams", categorySort: 2, price: 60, taxRate: 0, stockQty: 12, brand: null, bottleSize: null, description: null, status: "active", imagePath: null, createdAt: now, updatedAt: now, legacyId: 2 },
  ];
  const tables = [
    { id: "tbl_1", tableNo: "Table 01", seats: 4, status: "available", qrToken: "tok_t1", openSessionId: null, createdAt: now, updatedAt: now, legacyId: 1 },
    { id: "tbl_2", tableNo: "Table 02", seats: 4, status: "available", qrToken: "tok_t2", openSessionId: null, createdAt: now, updatedAt: now, legacyId: 2 },
  ];
  const counters = [
    { id: "foodBill", value: 0, prefix: "FOOD" },
    { id: "alcoholBill", value: 0, prefix: "ALC" },
    { id: "cafeBill", value: 0, prefix: "CAFE" },
    { id: "qrOrder", value: 0, prefix: "QR" },
    { id: "websiteOrder", value: 0, prefix: "WEB" },
  ];
  const w = db.bulkWriter();
  for (const c of cats) w.set(db.collection("categories").doc(c.id), c);
  for (const it of items) w.set(db.collection("catalog").doc(it.id), it);
  for (const t of tables) w.set(db.collection("tables").doc(t.id), t);
  for (const c of counters) w.set(db.collection("counters").doc(c.id), { value: c.value, prefix: c.prefix, updatedAt: now });
  await w.close();
}

export function staffReq(data, over = {}) {
  return {
    data,
    auth: { uid: "u_2", token: { role: "billing", username: "cashier1", uid: "u_2" } },
    rawRequest: { headers: {}, ip: "127.0.0.1" },
    acceptsStreaming: false,
    ...over,
  };
}
export function cafeReq(data, over = {}) {
  return staffReq(data, { auth: { uid: "u_5", token: { role: "cafe_billing", username: "cafe1", uid: "u_5" } }, ...over });
}
export function kitchenReq(data, over = {}) {
  return staffReq(data, { auth: { uid: "u_6", token: { role: "kitchen", username: "kds1", uid: "u_6" } }, ...over });
}
export function ownerReq(data, over = {}) {
  return staffReq(data, { auth: { uid: "u_7", token: { role: "owner", username: "owner1", uid: "u_7" } }, ...over });
}
/** Build a request for an arbitrary role string (role-matrix tests). */
export function reqAs(role, data, over = {}) {
  return staffReq(data, { auth: { uid: `u_${role}`, token: { role, username: role, uid: `u_${role}` } }, ...over });
}
export function managerReq(data) {
  return staffReq(data, { auth: { uid: "u_1", token: { role: "manager", username: "boss", uid: "u_1" } } });
}
export function adminReq(data) {
  return staffReq(data, { auth: { uid: "u_1", token: { role: "admin", username: "boss", uid: "u_1" } } });
}

export async function auditRows(action) {
  const db = getFirestore();
  const snap = await db.collection("auditLog").where("action", "==", action).get();
  return snap.docs.map((d) => d.data());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fnUrl(name) {
  const project = process.env.GCLOUD_PROJECT || "demo-nextlevel-int";
  const port = (process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001").split(":").pop();
  return `http://127.0.0.1:${port}/${project}/asia-south1/${name}`;
}

/** Mint a Firebase ID token (with a role claim) via the Auth emulator. */
export async function idTokenFor(uid, role) {
  const { getAuth } = await import("firebase-admin/auth");
  const auth = getAuth();
  try {
    await auth.createUser({ uid, displayName: uid });
  } catch {
    /* already exists */
  }
  const customToken = await auth.createCustomToken(uid, { role });
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  const res = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const body = await res.json();
  if (!body.idToken) throw new Error("token exchange failed: " + JSON.stringify(body));
  return body.idToken;
}

/** Poll stats/rolling until updatedAt advances past `since` (trigger is async). */
export async function waitForRolling(since = 0, tries = 40) {
  const db = getFirestore();
  for (let i = 0; i < tries; i++) {
    const s = await db.collection("stats").doc("rolling").get();
    const ts = s.exists ? s.data().updatedAt?.toMillis?.() ?? 0 : 0;
    if (s.exists && ts >= since) return s.data();
    await sleep(150);
  }
  return (await db.collection("stats").doc("rolling").get()).data() || null;
}
