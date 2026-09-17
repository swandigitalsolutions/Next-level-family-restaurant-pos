/**
 * Staff account management — replaces Flask /api/staff (admin only).
 * Preserves every guardrail in backend/app.py:
 *   - username regex ^[a-z0-9_.]{3,32}$
 *   - password >= 6 chars
 *   - role must be one of admin|manager|billing|cafe|kitchen|owner
 *   - the last ACTIVE admin can never be demoted / deactivated
 *   - you cannot deactivate your own account
 * Role changes are mirrored into the Firebase custom claim; deactivation also
 * disables the Auth user so no new/refreshed token can be minted.
 *
 * SECURITY: the Werkzeug password hash is written to the server-only
 * `userCredentials/{uid}` doc, never to the client-readable `users/{uid}`
 * profile. Every value returned to the caller is sanitized (see publicUser).
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION, VALID_ROLES, Role, normalizeRole } from "../lib/config";
import { generatePasswordHash } from "../lib/werkzeugHash";
import { assertAdmin } from "../lib/authz";
import {
  getUserByUid,
  usernameTaken,
  countActiveAdmins,
  createUserProfile,
  updateUserProfile,
  listUserProfiles,
  writeCredential,
  updateCredential,
  writeAudit,
  UserProfile,
} from "../lib/repo";
import { createAuthUser, setRoleClaim, setDisabled } from "../lib/authService";

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

/** The ONLY shape that ever leaves these functions. No credential material. */
const publicUser = (u: UserProfile) => ({
  id: u.uid,
  username: u.username,
  full_name: u.fullName,
  phone: u.phone,
  role: u.role,
  status: u.status,
});

function validRole(r: string): r is Role {
  return (VALID_ROLES as readonly string[]).includes(r);
}

// ------------------------------------------------------------------ listStaff

export async function handleListStaff(req: CallableRequest<unknown>) {
  assertAdmin(req);
  const profiles = await listUserProfiles();
  return { staff: profiles.map(publicUser) };
}

// ---------------------------------------------------------------- createStaff

export interface CreateStaffInput {
  username?: unknown;
  password?: unknown;
  full_name?: unknown;
  phone?: unknown;
  role?: unknown;
}

export async function handleCreateStaff(req: CallableRequest<CreateStaffInput>) {
  const caller = assertAdmin(req);
  const username = String(req.data?.username ?? "").trim().toLowerCase();
  const password = String(req.data?.password ?? "");
  const fullName = String(req.data?.full_name ?? "").trim();
  const phone = String(req.data?.phone ?? "").trim();
  const role = normalizeRole(req.data?.role ?? "billing");

  if (!USERNAME_RE.test(username)) {
    throw new HttpsError(
      "invalid-argument",
      "Username must be 3-32 characters: lowercase letters, numbers, dot or underscore only",
    );
  }
  if (!fullName) throw new HttpsError("invalid-argument", "Full name is required");
  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters");
  }
  if (!validRole(role)) throw new HttpsError("invalid-argument", "Invalid role");
  if (await usernameTaken(username)) {
    throw new HttpsError(
      "already-exists",
      "A staff account with this username already exists",
    );
  }

  const { uid } = await createAuthUser({ displayName: fullName });
  await setRoleClaim(uid, role);
  const profile: UserProfile = {
    uid,
    username,
    usernameLower: username,
    fullName,
    phone,
    role,
    status: "active",
  };
  await createUserProfile(profile);
  await writeCredential(uid, generatePasswordHash(password), username);
  await writeAudit({
    actorUid: caller.uid,
    actorUsername: caller.username,
    actorRole: caller.role,
    action: "staff.create",
    entityType: "user",
    entityId: uid,
    details: { username, role },
  });
  return publicUser(profile);
}

// ---------------------------------------------------------------- updateStaff

export interface UpdateStaffInput {
  uid?: unknown;
  full_name?: unknown;
  phone?: unknown;
  role?: unknown;
  status?: unknown;
  password?: unknown;
}

export async function handleUpdateStaff(req: CallableRequest<UpdateStaffInput>) {
  const caller = assertAdmin(req);
  const uid = String(req.data?.uid ?? "");
  if (!uid) throw new HttpsError("invalid-argument", "uid is required");

  const existing = await getUserByUid(uid);
  if (!existing) throw new HttpsError("not-found", "Staff member not found");

  const fullName = String(
    req.data?.full_name != null ? req.data.full_name : existing.fullName,
  ).trim();
  const phone = String(
    req.data?.phone != null ? req.data.phone : existing.phone ?? "",
  ).trim();
  const role = normalizeRole(req.data?.role ?? existing.role ?? "billing");
  const status = String(
    req.data?.status ?? existing.status ?? "active",
  ).trim().toLowerCase();
  const password =
    req.data?.password != null ? String(req.data.password) : undefined;

  if (!fullName) throw new HttpsError("invalid-argument", "Full name is required");
  if (!validRole(role)) throw new HttpsError("invalid-argument", "Invalid role");
  if (status !== "active" && status !== "inactive") {
    throw new HttpsError("invalid-argument", "Invalid status");
  }

  const demotingLastAdmin =
    existing.role === "admin" && (role !== "admin" || status !== "active");
  if (demotingLastAdmin && (await countActiveAdmins(uid)) === 0) {
    throw new HttpsError(
      "failed-precondition",
      "At least one active admin account must remain",
    );
  }

  const wantsPasswordReset = password !== undefined && password !== "";
  if (wantsPasswordReset && (password as string).length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters");
  }

  const patch: Partial<Omit<UserProfile, "uid" | "createdAt">> = {
    fullName,
    phone,
    role: role as Role,
    status: status as "active" | "inactive",
  };
  await updateUserProfile(uid, patch);
  if (wantsPasswordReset) {
    await updateCredential(uid, { passwordHash: generatePasswordHash(password as string) });
  }
  await setRoleClaim(uid, role as Role);
  await setDisabled(uid, status !== "active");
  await writeAudit({
    actorUid: caller.uid,
    actorUsername: caller.username,
    actorRole: caller.role,
    action: "staff.update",
    entityType: "user",
    entityId: uid,
    details: {
      username: existing.username,
      role: { from: existing.role, to: role },
      status: { from: existing.status, to: status },
      password_reset: wantsPasswordReset,
    },
  });

  return publicUser({ ...existing, ...patch });
}

// ------------------------------------------------------------- deactivateStaff

export interface DeactivateStaffInput {
  uid?: unknown;
}

export async function handleDeactivateStaff(
  req: CallableRequest<DeactivateStaffInput>,
) {
  const caller = assertAdmin(req);
  const uid = String(req.data?.uid ?? "");
  if (!uid) throw new HttpsError("invalid-argument", "uid is required");
  if (uid === caller.uid) {
    throw new HttpsError("failed-precondition", "You cannot remove your own account");
  }
  const existing = await getUserByUid(uid);
  if (!existing) throw new HttpsError("not-found", "Staff member not found");
  if (existing.role === "admin" && (await countActiveAdmins(uid)) === 0) {
    throw new HttpsError(
      "failed-precondition",
      "At least one active admin account must remain",
    );
  }

  await updateUserProfile(uid, { status: "inactive" });
  await setDisabled(uid, true);
  await writeAudit({
    actorUid: caller.uid,
    actorUsername: caller.username,
    actorRole: caller.role,
    action: "staff.deactivate",
    entityType: "user",
    entityId: uid,
    details: { username: existing.username },
  });
  return { message: "Staff account deactivated" };
}

// ------------------------------------------------------------------- exports

export const listStaff = onCall(
  { region: REGION },
  (req: CallableRequest<unknown>) => handleListStaff(req),
);
export const createStaff = onCall(
  { region: REGION },
  (req: CallableRequest<CreateStaffInput>) => handleCreateStaff(req),
);
export const updateStaff = onCall(
  { region: REGION },
  (req: CallableRequest<UpdateStaffInput>) => handleUpdateStaff(req),
);
export const deactivateStaff = onCall(
  { region: REGION },
  (req: CallableRequest<DeactivateStaffInput>) => handleDeactivateStaff(req),
);
