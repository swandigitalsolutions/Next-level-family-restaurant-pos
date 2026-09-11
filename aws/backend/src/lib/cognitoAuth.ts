/**
 * Cognito admin operations — replaces firebase/functions/src/lib/authService.ts
 * (Firebase Auth Admin SDK -> AWS SDK CognitoIdentityProvider AdminXxx calls).
 *
 * Design difference from the Firebase version: Firebase minted a custom token
 * signed with a server-only Werkzeug hash check, and the client exchanged it
 * for an ID token. Cognito's equivalent staff-created-account flow is
 * `AdminCreateUser` (with `MessageAction: SUPPRESS`, no invite email) +
 * `AdminSetUserPassword` (permanent, so the account is usable immediately —
 * no "force new password" first-login prompt, matching the old UX of staff
 * accounts being ready to use right after creation). Login itself moves to
 * direct Cognito `USER_PASSWORD_AUTH` (see handlers/callable/loginWithPassword.ts) —
 * the legacy Werkzeug hash in `user_credentials` is kept only as an ETL/
 * verification artifact, never checked at runtime after cutover.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminInitiateAuthCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomBytes } from "crypto";
import { Role } from "./config";

const REGION = process.env.AWS_REGION || "ap-south-1";
let client: CognitoIdentityProviderClient | undefined;
const getClient = () => (client ??= new CognitoIdentityProviderClient({ region: REGION }));

function userPoolId(): string {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) throw new Error("COGNITO_USER_POOL_ID env var not set");
  return id;
}
function clientId(): string {
  const id = process.env.COGNITO_CLIENT_ID;
  if (!id) throw new Error("COGNITO_CLIENT_ID env var not set");
  return id;
}

/** A random, spec-compliant temporary password — immediately overwritten by
 * AdminSetUserPassword(Permanent: true) with the caller-chosen password, so
 * this value is never actually used to sign in. */
function randomTempPassword(): string {
  return "Tmp#" + randomBytes(18).toString("base64url") + "1a";
}

export interface NewAuthUser { username: string; displayName?: string }

export async function createAuthUser(input: NewAuthUser): Promise<{ uid: string }> {
  const res = await getClient().send(new AdminCreateUserCommand({
    UserPoolId: userPoolId(),
    Username: input.username,
    MessageAction: "SUPPRESS",
    TemporaryPassword: randomTempPassword(),
    UserAttributes: [{ Name: "name", Value: input.displayName || input.username }],
  }));
  const sub = res.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
  if (!sub) throw new Error("Cognito did not return a sub for the new user");
  // pos_uid is self-referential (== sub) so every handler can read the
  // Postgres primary key straight off the JWT claim with no extra lookup —
  // same "Auth uid == Firestore doc id" convenience the Firebase version had.
  await getClient().send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId(), Username: input.username, UserAttributes: [{ Name: "custom:pos_uid", Value: sub }],
  }));
  return { uid: sub };
}

export async function setStaffPassword(username: string, password: string): Promise<void> {
  await getClient().send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId(), Username: username, Password: password, Permanent: true,
  }));
}

export async function setRoleClaim(username: string, role: Role): Promise<void> {
  await getClient().send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId(), Username: username, UserAttributes: [{ Name: "custom:role", Value: role }],
  }));
}

export async function setDisabled(username: string, disabled: boolean): Promise<void> {
  const cmd = disabled ? new AdminDisableUserCommand({ UserPoolId: userPoolId(), Username: username }) : new AdminEnableUserCommand({ UserPoolId: userPoolId(), Username: username });
  await getClient().send(cmd);
}

export async function deleteAuthUser(username: string): Promise<void> {
  await getClient().send(new AdminDeleteUserCommand({ UserPoolId: userPoolId(), Username: username })).catch(() => undefined);
}

export interface CognitoTokens { idToken: string; accessToken: string; refreshToken: string; expiresIn: number }

/** Direct username+password sign-in against Cognito (server-side admin flow —
 * safe to use from a Lambda since the app client has no secret; USER_PASSWORD_AUTH
 * must be enabled on the pool client, see auth-stack.ts authFlows). */
export async function signInWithPassword(username: string, password: string): Promise<CognitoTokens | null> {
  try {
    const res = await getClient().send(new AdminInitiateAuthCommand({
      UserPoolId: userPoolId(),
      ClientId: clientId(),
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }));
    const r = res.AuthenticationResult;
    if (!r?.IdToken || !r.AccessToken || !r.RefreshToken) return null;
    return { idToken: r.IdToken, accessToken: r.AccessToken, refreshToken: r.RefreshToken, expiresIn: r.ExpiresIn ?? 3600 };
  } catch (e: any) {
    // NotAuthorizedException / UserNotFoundException / PasswordResetRequiredException etc.
    // — all fold to "invalid credentials" at the call site; never leak which.
    return null;
  }
}
