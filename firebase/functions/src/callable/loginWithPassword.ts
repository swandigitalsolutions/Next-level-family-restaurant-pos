/**
 * loginWithPassword — replaces Flask POST /api/login.
 *
 * Keeps the exact username+password UX: the client calls this callable, gets a
 * Firebase custom token back, and does signInWithCustomToken(). Passwords are
 * verified against the carried-over Werkzeug hash, which lives in the
 * server-only userCredentials/{uid} doc (never readable by any client). Role is
 * written into both the minted token and the user's custom claims.
 */
import { onCall, HttpsError, CallableRequest } from "firebase-functions/v2/https";
import { REGION } from "../lib/config";
import { checkPasswordHash } from "../lib/werkzeugHash";
import { findCredentialByUsername, getUserByUid } from "../lib/repo";
import { setRoleClaim, mintCustomToken } from "../lib/authService";
import { callerIpHash, isLocked, registerFailure, clearFailures } from "../lib/loginThrottle";

const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";

export interface LoginInput {
  username?: unknown;
  password?: unknown;
}

export interface LoginResult {
  token: string;
  user: { id: string; username: string; full_name: string; role: string };
}

export async function handleLogin(
  req: CallableRequest<LoginInput>,
): Promise<LoginResult> {
  const key = callerIpHash(req);
  if (await isLocked(key)) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many failed attempts. Please try again in a few minutes.",
    );
  }

  const username = String(req.data?.username ?? "").trim().toLowerCase();
  const password = String(req.data?.password ?? "");
  if (!username || !password) {
    throw new HttpsError("invalid-argument", "Username and password are required");
  }

  const cred = await findCredentialByUsername(username);
  if (!cred || !checkPasswordHash(cred.passwordHash, password)) {
    await registerFailure(key);
    throw new HttpsError("unauthenticated", "Invalid username or password");
  }

  const user = await getUserByUid(cred.uid);
  if (!user) {
    // credential without a profile — treat as an invalid account, don't leak.
    await registerFailure(key);
    throw new HttpsError("unauthenticated", "Invalid username or password");
  }
  if ((user.status || "active") !== "active") {
    throw new HttpsError(
      "permission-denied",
      "This account has been deactivated. Contact your administrator.",
    );
  }

  await clearFailures(key);
  await setRoleClaim(user.uid, user.role);
  const token = await mintCustomToken(user.uid, user.role);

  return {
    token,
    user: {
      id: user.uid,
      username: user.username,
      full_name: user.fullName,
      role: user.role,
    },
  };
}

export const loginWithPassword = onCall<LoginInput, Promise<LoginResult>>(
  { region: REGION, enforceAppCheck: ENFORCE_APP_CHECK, consumeAppCheckToken: ENFORCE_APP_CHECK },
  handleLogin,
);
