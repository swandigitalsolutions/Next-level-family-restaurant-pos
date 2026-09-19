/**
 * Login throttle — durable, cross-instance version of backend/app.py's
 * in-process _LOGIN_ATTEMPTS (6 failures per IP -> 5 minute lockout).
 */
import * as crypto from "crypto";
import type { CallableRequest } from "firebase-functions/v2/https";
import { LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_SECONDS } from "./config";
import { throttleGet, throttleBump, throttleClear } from "./repo";

/** backend/app.py _login_throttle_key — first X-Forwarded-For hop, else remote IP. */
export function callerIpHash(req: CallableRequest): string {
  const raw = req.rawRequest;
  const fwd = String(raw?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || raw?.ip || (raw?.socket && raw.socket.remoteAddress) || "unknown";
  return crypto.createHash("sha256").update(ip).digest("hex");
}

/** backend/app.py _is_login_locked (also clears an expired lockout). */
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

export const registerFailure = (key: string) => throttleBump(key);
export const clearFailures = (key: string) => throttleClear(key);
