/**
 * loginWithPassword — Lambda port of
 * firebase/functions/src/callable/loginWithPassword.ts.
 *
 * UX stays identical (username + password, one call, get a usable session
 * back) but the mechanism changes: Cognito is now the credential store, so
 * this handler calls `AdminInitiateAuth` directly instead of verifying a
 * Werkzeug hash and minting a custom token. The legacy hash in
 * `user_credentials` is kept only for ETL/rollback verification — see
 * aws/db/scripts/migrate-from-firestore.mjs — and is never read here.
 *
 * This is the one callable route exposed WITHOUT a Cognito authorizer (see
 * api-stack.ts) since the caller has no token yet.
 */
import { findUserByUsername, callerIpHash, isLocked, registerFailure, clearFailures } from "../../lib/repo";
import { signInWithPassword } from "../../lib/cognitoAuth";
import { ok, err, withErrors } from "../../lib/http";

export const handler = withErrors(async (event: any) => {
  const body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : {};
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sourceIp = event.requestContext?.http?.sourceIp;
  const key = callerIpHash(headers as any, sourceIp);

  if (await isLocked(key)) {
    return err("Too many failed attempts. Please try again in a few minutes.", 429, "resource-exhausted");
  }

  const username = String(body?.username ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!username || !password) return err("Username and password are required", 400, "invalid-argument");

  const profile = await findUserByUsername(username);
  if (!profile) {
    await registerFailure(key);
    return err("Invalid username or password", 401, "unauthenticated");
  }
  if ((profile.status || "active") !== "active") {
    // Do not register this as a failed attempt — it is a correct password on
    // a deactivated account, not a guess; Cognito itself is also disabled for
    // this user (staffAdmin.deactivateStaff), so the auth call below would
    // fail anyway, but we short-circuit for the exact Flask-parity message.
    return err("This account has been deactivated. Contact your administrator.", 403, "permission-denied");
  }

  const tokens = await signInWithPassword(username, password);
  if (!tokens) {
    await registerFailure(key);
    return err("Invalid username or password", 401, "unauthenticated");
  }
  await clearFailures(key);

  return ok({
    token: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: { id: profile.uid, username: profile.username, full_name: profile.fullName, role: profile.role },
  });
});
