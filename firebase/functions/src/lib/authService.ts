/**
 * Firebase Auth (Admin) operations for the custom-token flow. Separated from the
 * callables so tests can mock it. No password is ever stored in Firebase Auth —
 * the Werkzeug hash in users/{uid}.passwordHash is the credential of record.
 */
import { authAdmin } from "./adminSdk";
import { Role } from "./config";

export interface NewAuthUser {
  displayName?: string;
}

export async function createAuthUser(input: NewAuthUser): Promise<{ uid: string }> {
  const rec = await authAdmin().createUser({
    displayName: input.displayName || undefined,
  });
  return { uid: rec.uid };
}

export async function setRoleClaim(uid: string, role: Role): Promise<void> {
  await authAdmin().setCustomUserClaims(uid, { role });
}

export async function setDisabled(uid: string, disabled: boolean): Promise<void> {
  await authAdmin().updateUser(uid, { disabled });
}

/** developerClaims land in the minted token AND we set them as custom claims so
 * they survive a client-side token refresh (rules read request.auth.token.role). */
export async function mintCustomToken(uid: string, role: Role): Promise<string> {
  return authAdmin().createCustomToken(uid, { role });
}
