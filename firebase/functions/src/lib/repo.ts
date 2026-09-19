/**
 * The ONLY module that reads/writes Firestore for the auth + staff surface.
 * Unit tests mock this wholesale, so no Firestore fake is needed anywhere else.
 * Collection shapes match firebase/ARCHITECTURE.md §4.
 *
 * SECURITY: password hashes live in `userCredentials/{uid}`, which Firestore
 * rules make completely inaccessible to every client (read+write denied). The
 * `users/{uid}` profile doc is safe for an admin / self client read because it
 * carries NO credential material.
 */
import { db, FieldValue } from "./adminSdk";
import { Role, normalizeRole } from "./config";

/** Client-safe staff profile. NO passwordHash — ever. */
export interface UserProfile {
  uid: string;
  username: string;
  usernameLower: string;
  fullName: string;
  phone: string;
  role: Role;
  status: "active" | "inactive";
  createdAt?: FirebaseFirestore.Timestamp;
}

/** Server-only credential record. Never leaves a Cloud Function. */
export interface Credential {
  uid: string;
  usernameLower: string;
  passwordHash: string;
}

// Audit lives in ./audit.ts now (shared by tx + non-tx callers); re-exported
// here so existing importers keep working.
export { writeAudit, auditFromCaller } from "./audit";
export type { AuditEntry, AuditEntry as AuditInput } from "./audit";

const USERS = "users";
const CREDS = "userCredentials";
const THROTTLE = "authThrottle";

function toProfile(
  uid: string,
  data: FirebaseFirestore.DocumentData,
): UserProfile {
  return {
    uid,
    username: data.username ?? "",
    usernameLower: data.usernameLower ?? String(data.username ?? "").toLowerCase(),
    fullName: data.fullName ?? "",
    phone: data.phone ?? "",
    role: normalizeRole(data.role ?? "billing") as Role,
    status: (data.status ?? "active") as "active" | "inactive",
    createdAt: data.createdAt,
  };
}

// ------------------------------------------------------------------ profiles

export async function findUserByUsername(
  usernameLower: string,
): Promise<UserProfile | null> {
  const snap = await db()
    .collection(USERS)
    .where("usernameLower", "==", usernameLower)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return toProfile(doc.id, doc.data());
}

export async function getUserByUid(uid: string): Promise<UserProfile | null> {
  const doc = await db().collection(USERS).doc(uid).get();
  return doc.exists
    ? toProfile(doc.id, doc.data() as FirebaseFirestore.DocumentData)
    : null;
}

export async function usernameTaken(usernameLower: string): Promise<boolean> {
  const snap = await db()
    .collection(USERS)
    .where("usernameLower", "==", usernameLower)
    .limit(1)
    .get();
  return !snap.empty;
}

/** backend/app.py _admin_count */
export async function countActiveAdmins(excludeUid?: string): Promise<number> {
  const snap = await db()
    .collection(USERS)
    .where("role", "==", "admin")
    .where("status", "==", "active")
    .get();
  return snap.docs.filter((d) => d.id !== excludeUid).length;
}

/** Sanitized staff list for the admin-only listStaff callable. */
export async function listUserProfiles(): Promise<UserProfile[]> {
  const snap = await db().collection(USERS).orderBy("usernameLower").get();
  return snap.docs.map((d) => toProfile(d.id, d.data()));
}

export async function createUserProfile(p: UserProfile): Promise<void> {
  await db()
    .collection(USERS)
    .doc(p.uid)
    .set({
      username: p.username,
      usernameLower: p.usernameLower,
      fullName: p.fullName,
      phone: p.phone,
      role: p.role,
      status: p.status,
      createdAt: FieldValue.serverTimestamp(),
    });
}

export async function updateUserProfile(
  uid: string,
  patch: Partial<Omit<UserProfile, "uid" | "createdAt">>,
): Promise<void> {
  await db().collection(USERS).doc(uid).set(patch, { merge: true });
}

// --------------------------------------------------------------- credentials

export async function findCredentialByUsername(
  usernameLower: string,
): Promise<Credential | null> {
  const snap = await db()
    .collection(CREDS)
    .where("usernameLower", "==", usernameLower)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const d = doc.data();
  return {
    uid: doc.id,
    usernameLower: d.usernameLower ?? usernameLower,
    passwordHash: d.passwordHash ?? "",
  };
}

export async function writeCredential(
  uid: string,
  passwordHash: string,
  usernameLower: string,
): Promise<void> {
  await db().collection(CREDS).doc(uid).set({
    usernameLower,
    passwordHash,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function updateCredential(
  uid: string,
  patch: { passwordHash?: string },
): Promise<void> {
  await db()
    .collection(CREDS)
    .doc(uid)
    .set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

// --- login throttle (backend/app.py _LOGIN_ATTEMPTS, now shared + durable) ---

export interface ThrottleEntry {
  count: number;
  lockedAt: number; // epoch ms
}

export async function throttleGet(key: string): Promise<ThrottleEntry | null> {
  const doc = await db().collection(THROTTLE).doc(key).get();
  if (!doc.exists) return null;
  const d = doc.data() as FirebaseFirestore.DocumentData;
  return { count: Number(d.count) || 0, lockedAt: Number(d.lockedAt) || 0 };
}

export async function throttleBump(key: string): Promise<void> {
  await db()
    .collection(THROTTLE)
    .doc(key)
    .set({ count: FieldValue.increment(1), lockedAt: Date.now() }, { merge: true });
}

export async function throttleClear(key: string): Promise<void> {
  await db().collection(THROTTLE).doc(key).delete();
}
