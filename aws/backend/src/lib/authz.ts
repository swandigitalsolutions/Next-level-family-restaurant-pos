/**
 * Caller identity + role-claim assertions — API Gateway/Cognito port of
 * firebase/functions/src/lib/authz.ts. API Gateway HTTP API with a Cognito
 * JWT authorizer attaches the verified claims at
 * `event.requestContext.authorizer.jwt.claims`; the `custom:role` claim is
 * kept fresh by the PreTokenGeneration trigger (aws/infra/lib/auth-stack.ts)
 * reading `users.role` from Postgres at every token mint — same "always
 * current, never stale" property the Firestore users/{uid} listener gave.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  Role, VALID_ROLES, normalizeRole,
  MANAGE_ROLES, BILLING_ROLES, CAFE_ROLES, KITCHEN_ROLES, AUDIT_ROLES,
} from "./config";

export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export interface Caller {
  uid: string;
  username: string;
  role: Role;
}

export function roleOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): Role | null {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const r = normalizeRole(claims["custom:role"]);
  return (VALID_ROLES as readonly string[]).includes(r) ? (r as Role) : null;
}

export function assertSignedIn(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const uid = claims?.["custom:pos_uid"] || claims?.sub;
  if (!uid) throw new HttpError(401, "unauthenticated", "Unauthorized. Please log in.");
  const role = roleOf(event);
  if (!role) throw new HttpError(403, "permission-denied", "Your account has no role assigned.");
  return { uid: String(uid), username: String(claims?.["cognito:username"] || ""), role };
}

export function assertRole(event: APIGatewayProxyEventV2WithJWTAuthorizer, roles: Role[]): Caller {
  const caller = assertSignedIn(event);
  if (!roles.includes(caller.role)) {
    throw new HttpError(403, "permission-denied", "You do not have permission to perform this action.");
  }
  return caller;
}

export const assertAdmin = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => assertRole(e, ["admin"]);
export const assertManager = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => assertRole(e, MANAGE_ROLES);
export const assertBilling = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => assertRole(e, BILLING_ROLES);
export const assertCafe = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => assertRole(e, CAFE_ROLES);
export const assertKitchen = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => assertRole(e, KITCHEN_ROLES);
export const assertAuditReader = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => assertRole(e, AUDIT_ROLES);
