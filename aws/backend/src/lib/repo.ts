/**
 * The ONLY module that reads/writes Postgres for the auth + staff surface —
 * Postgres port of firebase/functions/src/lib/repo.ts. Unit tests mock this
 * wholesale, same as the Firestore version.
 *
 * SECURITY: password hashes live in `user_credentials`, which carries no
 * client-facing grant (002_privileges.sql) — same "denied for every client
 * incl. admin, Admin-SDK/app-role only" posture as Firestore rules gave.
 */
import { getPool, withTransaction } from "./db";
import { Role, normalizeRole } from "./config";
import { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_SECONDS } from "./config";
import * as crypto from "crypto";

export interface UserProfile {
  uid: string;
  username: string;
  usernameLower: string;
  fullName: string;
  phone: string;
  role: Role;
  status: "active" | "inactive";
  cognitoSub?: string | null;
  createdAt?: Date;
}

export interface Credential {
  uid: string;
  usernameLower: string;
  passwordHash: string;
}

export { writeAudit, auditFromCaller } from "./audit";
export type { AuditEntry, AuditEntry as AuditInput } from "./audit";

function toProfile(row: any): UserProfile {
  return {
    uid: row.uid,
    username: row.username ?? "",
    usernameLower: row.username_lower ?? String(row.username ?? "").toLowerCase(),
    fullName: row.full_name ?? "",
    phone: row.phone ?? "",
    role: normalizeRole(row.role ?? "billing") as Role,
    status: (row.status ?? "active") as "active" | "inactive",
    cognitoSub: row.cognito_sub ?? null,
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------------ profiles

export async function findUserByUsername(usernameLower: string): Promise<UserProfile | null> {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM users WHERE username_lower = $1 LIMIT 1", [usernameLower]);
  return res.rows[0] ? toProfile(res.rows[0]) : null;
}

export async function getUserByUid(uid: string): Promise<UserProfile | null> {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM users WHERE uid = $1", [uid]);
  return res.rows[0] ? toProfile(res.rows[0]) : null;
}

export async function usernameTaken(usernameLower: string): Promise<boolean> {
  const pool = await getPool();
  const res = await pool.query("SELECT 1 FROM users WHERE username_lower = $1 LIMIT 1", [usernameLower]);
  return (res.rowCount ?? 0) > 0;
}

/** backend/app.py _admin_count — active admins, optionally excluding one uid. */
export async function countActiveAdmins(excludeUid?: string): Promise<number> {
  const pool = await getPool();
  const res = await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active' AND uid <> COALESCE($1, '')",
    [excludeUid ?? null],
  );
  return res.rows[0]?.n ?? 0;
}

export async function listUserProfiles(): Promise<UserProfile[]> {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM users ORDER BY username_lower");
  return res.rows.map(toProfile);
}

export async function createUserProfile(p: UserProfile): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO users (uid, username, username_lower, full_name, phone, role, status, cognito_sub, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`,
    [p.uid, p.username, p.usernameLower, p.fullName, p.phone, p.role, p.status, p.cognitoSub ?? null],
  );
}

export async function updateUserProfile(uid: string, patch: Partial<Omit<UserProfile, "uid" | "createdAt">>): Promise<void> {
  const pool = await getPool();
  const cur = await getUserByUid(uid);
  if (!cur) throw new Error(`updateUserProfile: user ${uid} not found`);
  const merged = { ...cur, ...patch };
  await pool.query(
    `UPDATE users SET username=$2, username_lower=$3, full_name=$4, phone=$5, role=$6, status=$7, cognito_sub=$8, updated_at=now() WHERE uid=$1`,
    [uid, merged.username, merged.usernameLower, merged.fullName, merged.phone, merged.role, merged.status, merged.cognitoSub ?? null],
  );
}

// --------------------------------------------------------------- credentials

export async function findCredentialByUsername(usernameLower: string): Promise<Credential | null> {
  const pool = await getPool();
  const res = await pool.query("SELECT * FROM user_credentials WHERE username_lower = $1 LIMIT 1", [usernameLower]);
  const row = res.rows[0];
  return row ? { uid: row.uid, usernameLower: row.username_lower, passwordHash: row.password_hash } : null;
}

export async function writeCredential(uid: string, passwordHash: string, usernameLower: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO user_credentials (uid, username_lower, password_hash, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (uid) DO UPDATE SET username_lower = EXCLUDED.username_lower, password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [uid, usernameLower, passwordHash],
  );
}

export async function updateCredential(uid: string, patch: { passwordHash?: string }): Promise<void> {
  if (patch.passwordHash === undefined) return;
  const pool = await getPool();
  await pool.query("UPDATE user_credentials SET password_hash = $2, updated_at = now() WHERE uid = $1", [uid, patch.passwordHash]);
}

// --- login throttle (durable, cross-Lambda-instance; 6 failures/IP -> 5min lockout) ---

export interface ThrottleEntry { count: number; lockedAt: number }

export async function throttleGet(key: string): Promise<ThrottleEntry | null> {
  const pool = await getPool();
  const res = await pool.query("SELECT count, locked_at FROM auth_throttle WHERE ip_hash = $1", [key]);
  const row = res.rows[0];
  return row ? { count: Number(row.count) || 0, lockedAt: Number(row.locked_at) || 0 } : null;
}

export async function throttleBump(key: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO auth_throttle (ip_hash, count, locked_at) VALUES ($1, 1, $2)
       ON CONFLICT (ip_hash) DO UPDATE SET count = auth_throttle.count + 1, locked_at = $2`,
      [key, Date.now()],
    );
  });
}

export async function throttleClear(key: string): Promise<void> {
  const pool = await getPool();
  await pool.query("DELETE FROM auth_throttle WHERE ip_hash = $1", [key]);
}

/** backend/app.py _login_throttle_key — first X-Forwarded-For hop, else source IP. */
export function callerIpHash(headers: Record<string, string | undefined>, sourceIp: string | undefined): string {
  const fwd = String(headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || sourceIp || "unknown";
  return crypto.createHash("sha256").update(ip).digest("hex");
}

export async function isLocked(key: string): Promise<boolean> {
  const entry = await throttleGet(key);
  if (!entry) return false;
  if (entry.count < LOGIN_MAX_ATTEMPTS) return false;
  if (Date.now() - entry.lockedAt > LOGIN_LOCKOUT_SECONDS * 1000) {
    await throttleClear(key);
    return false;
  }
  return true;
}

export const registerFailure = throttleBump;
export const clearFailures = throttleClear;
