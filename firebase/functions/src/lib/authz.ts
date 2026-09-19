/**
 * Caller identity + role-claim assertions for callable functions.
 * Mirrors backend/app.py login_required / require_role / the owner before_request.
 */
import { HttpsError, CallableRequest } from "firebase-functions/v2/https";
import {
  Role, VALID_ROLES, normalizeRole,
  MANAGE_ROLES, BILLING_ROLES, CAFE_ROLES, KITCHEN_ROLES, AUDIT_ROLES,
} from "./config";

export interface Caller {
  uid: string;
  username: string;
  role: Role;
}

export function roleOf(req: CallableRequest): Role | null {
  const r = normalizeRole(req.auth?.token?.role);
  return (VALID_ROLES as readonly string[]).includes(r) ? (r as Role) : null;
}

export function assertSignedIn(req: CallableRequest): Caller {
  if (!req.auth?.uid) {
    throw new HttpsError("unauthenticated", "Unauthorized. Please log in.");
  }
  const role = roleOf(req);
  if (!role) {
    throw new HttpsError("permission-denied", "Your account has no role assigned.");
  }
  return {
    uid: req.auth.uid,
    username: String(req.auth.token.username || req.auth.token.name || ""),
    role,
  };
}

export function assertRole(req: CallableRequest, roles: Role[]): Caller {
  const caller = assertSignedIn(req);
  if (!roles.includes(caller.role)) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to perform this action.",
    );
  }
  return caller;
}

export const assertAdmin = (req: CallableRequest) => assertRole(req, ["admin"]);
export const assertManager = (req: CallableRequest) => assertRole(req, MANAGE_ROLES);
export const assertBilling = (req: CallableRequest) => assertRole(req, BILLING_ROLES);
export const assertCafe = (req: CallableRequest) => assertRole(req, CAFE_ROLES);
export const assertKitchen = (req: CallableRequest) => assertRole(req, KITCHEN_ROLES);
export const assertAuditReader = (req: CallableRequest) => assertRole(req, AUDIT_ROLES);
