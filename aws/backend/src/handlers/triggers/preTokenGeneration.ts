/**
 * Cognito PreTokenGeneration trigger — the direct replacement for Firebase's
 * `setCustomUserClaims` (see firebase/functions/src/lib/authService.ts).
 * Invoked by Cognito on every token mint (sign-in AND refresh), so a role
 * change made by staffAdmin.updateStaff takes effect on the user's very next
 * token — the same "always current, never stale" property the Firestore
 * users/{uid} client listener gave, but enforced server-side where it
 * actually matters (the JWT claim every handler's `assertRole` trusts).
 *
 * Fails CLOSED: if the Postgres lookup fails or the user has no profile
 * (deleted/never migrated), no role claim is added — every `assertRole`
 * check downstream then correctly denies the request, rather than granting
 * whatever role happened to be cached from a previous token.
 */
import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import { getPool } from "../../lib/db";
import { normalizeRole } from "../../lib/config";

export const handler = async (event: PreTokenGenerationTriggerEvent): Promise<PreTokenGenerationTriggerEvent> => {
  try {
    const username = event.userName;
    const pool = await getPool();
    const res = await pool.query("SELECT uid, role, status FROM users WHERE username_lower = $1 LIMIT 1", [username.toLowerCase()]);
    const row = res.rows[0];
    const claims: Record<string, string> = {};
    if (row && row.status === "active") {
      claims["custom:role"] = normalizeRole(row.role);
      claims["custom:pos_uid"] = row.uid;
    }
    // deactivated/unknown user: emit no role claim at all — every assertRole
    // check treats a missing/unrecognized role as permission-denied.
    event.response = {
      claimsOverrideDetails: { claimsToAddOrOverride: claims },
    };
  } catch (e) {
    console.error("preTokenGeneration: Postgres lookup failed, issuing token with NO role claim (fail closed)", e);
    event.response = { claimsOverrideDetails: { claimsToAddOrOverride: {} } };
  }
  return event;
};
