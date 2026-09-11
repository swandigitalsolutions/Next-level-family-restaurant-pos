/**
 * Staff account management — Lambda port of
 * firebase/functions/src/callable/staffAdmin.ts. All guardrails preserved:
 *   - username regex ^[a-z0-9_.]{3,32}$
 *   - password >= 6 chars
 *   - role must be a valid 6-role value
 *   - the last ACTIVE admin can never be demoted/deactivated
 *   - you cannot deactivate your own account
 * Role changes are mirrored into the Cognito `custom:role` claim;
 * deactivation also disables the Cognito user, same as Firebase
 * Auth().updateUser({disabled:true}) did.
 */
import { dispatch } from "../../lib/callable";
import { HttpError, assertAdmin } from "../../lib/authz";
import { VALID_ROLES, Role, normalizeRole } from "../../lib/config";
import { generatePasswordHash } from "../../lib/werkzeugHash";
import {
  getUserByUid, usernameTaken, countActiveAdmins, createUserProfile, updateUserProfile,
  listUserProfiles, writeCredential, updateCredential, writeAudit, UserProfile,
} from "../../lib/repo";
import { createAuthUser, setStaffPassword, setRoleClaim, setDisabled } from "../../lib/cognitoAuth";

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

const publicUser = (u: UserProfile) => ({ id: u.uid, username: u.username, full_name: u.fullName, phone: u.phone, role: u.role, status: u.status });
function validRole(r: string): r is Role { return (VALID_ROLES as readonly string[]).includes(r); }

export const handler = dispatch({
  async listStaff(_body, event) {
    assertAdmin(event as any);
    const profiles = await listUserProfiles();
    return { staff: profiles.map(publicUser) };
  },

  async createStaff(body, event) {
    const caller = assertAdmin(event as any);
    const username = String(body?.username ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    const fullName = String(body?.full_name ?? "").trim();
    const phone = String(body?.phone ?? "").trim();
    const role = normalizeRole(body?.role ?? "billing");

    if (!USERNAME_RE.test(username)) throw new HttpError(422, "invalid-argument", "Username must be 3-32 characters: lowercase letters, numbers, dot or underscore only");
    if (!fullName) throw new HttpError(422, "invalid-argument", "Full name is required");
    if (password.length < 6) throw new HttpError(422, "invalid-argument", "Password must be at least 6 characters");
    if (!validRole(role)) throw new HttpError(422, "invalid-argument", "Invalid role");
    if (await usernameTaken(username)) throw new HttpError(409, "already-exists", "A staff account with this username already exists");

    // Cognito account first (source of the uid), then the Postgres profile,
    // then the legacy-hash row (ETL/rollback artifact only, never read at
    // runtime after cutover) — if any step after Cognito creation fails, the
    // orphaned Cognito user is harmless (no Postgres profile references it
    // yet) and can be cleaned up by re-running with the same username once
    // the underlying issue is fixed.
    const { uid } = await createAuthUser({ username, displayName: fullName });
    await setStaffPassword(username, password);
    await setRoleClaim(username, role);
    const profile: UserProfile = { uid, username, usernameLower: username, fullName, phone, role, status: "active" };
    await createUserProfile(profile);
    await writeCredential(uid, generatePasswordHash(password), username);
    await writeAudit({ actorUid: caller.uid, actorUsername: caller.username, actorRole: caller.role, action: "staff.create", entityType: "user", entityId: uid, details: { username, role } });
    return publicUser(profile);
  },

  async updateStaff(body, event) {
    const caller = assertAdmin(event as any);
    const uid = String(body?.uid ?? "");
    if (!uid) throw new HttpError(422, "invalid-argument", "uid is required");
    const existing = await getUserByUid(uid);
    if (!existing) throw new HttpError(404, "not-found", "Staff member not found");

    const fullName = String(body?.full_name != null ? body.full_name : existing.fullName).trim();
    const phone = String(body?.phone != null ? body.phone : existing.phone ?? "").trim();
    const role = normalizeRole(body?.role ?? existing.role ?? "billing");
    const status = String(body?.status ?? existing.status ?? "active").trim().toLowerCase();
    const password = body?.password != null ? String(body.password) : undefined;

    if (!fullName) throw new HttpError(422, "invalid-argument", "Full name is required");
    if (!validRole(role)) throw new HttpError(422, "invalid-argument", "Invalid role");
    if (status !== "active" && status !== "inactive") throw new HttpError(422, "invalid-argument", "Invalid status");

    const demotingLastAdmin = existing.role === "admin" && (role !== "admin" || status !== "active");
    if (demotingLastAdmin && (await countActiveAdmins(uid)) === 0) {
      throw new HttpError(409, "failed-precondition", "At least one active admin account must remain");
    }
    const wantsPasswordReset = password !== undefined && password !== "";
    if (wantsPasswordReset && password!.length < 6) throw new HttpError(422, "invalid-argument", "Password must be at least 6 characters");

    const patch: Partial<Omit<UserProfile, "uid" | "createdAt">> = { fullName, phone, role: role as Role, status: status as "active" | "inactive" };
    await updateUserProfile(uid, patch);
    if (wantsPasswordReset) {
      await updateCredential(uid, { passwordHash: generatePasswordHash(password as string) });
      await setStaffPassword(existing.username, password as string);
    }
    await setRoleClaim(existing.username, role as Role);
    await setDisabled(existing.username, status !== "active");
    await writeAudit({
      actorUid: caller.uid, actorUsername: caller.username, actorRole: caller.role, action: "staff.update",
      entityType: "user", entityId: uid,
      details: { username: existing.username, role: { from: existing.role, to: role }, status: { from: existing.status, to: status }, password_reset: wantsPasswordReset },
    });
    return publicUser({ ...existing, ...patch });
  },

  async deactivateStaff(body, event) {
    const caller = assertAdmin(event as any);
    const uid = String(body?.uid ?? "");
    if (!uid) throw new HttpError(422, "invalid-argument", "uid is required");
    if (uid === caller.uid) throw new HttpError(409, "failed-precondition", "You cannot remove your own account");
    const existing = await getUserByUid(uid);
    if (!existing) throw new HttpError(404, "not-found", "Staff member not found");
    if (existing.role === "admin" && (await countActiveAdmins(uid)) === 0) {
      throw new HttpError(409, "failed-precondition", "At least one active admin account must remain");
    }
    await updateUserProfile(uid, { status: "inactive" });
    await setDisabled(existing.username, true);
    await writeAudit({ actorUid: caller.uid, actorUsername: caller.username, actorRole: caller.role, action: "staff.deactivate", entityType: "user", entityId: uid, details: { username: existing.username } });
    return { message: "Staff account deactivated" };
  },
});
