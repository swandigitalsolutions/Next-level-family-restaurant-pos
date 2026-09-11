/*
 * aws-auth.js — staff authentication for the AWS build. AWS analogue of
 * firebase/hosting/js/auth.js + firebase-init.js. Cognito is never talked to
 * directly from the browser: `loginWithPassword` (unauthenticated route)
 * calls Cognito AdminInitiateAuth server-side and hands back an ID token,
 * which this module then attaches as `Authorization: Bearer <token>` on
 * every subsequent API call. Client-side JWT decoding here is DISPLAY ONLY
 * (username/role shown in the sidebar) — every actual authorization
 * decision happens server-side (API Gateway Cognito authorizer + handler
 * assertRole), exactly like the frontend gate in page-gate.js was always
 * documented as UX-only, never a security boundary.
 *
 * Session storage (not localStorage): tokens live for the tab's lifetime,
 * matching a shift-based POS terminal use pattern and limiting exposure if a
 * shared terminal is left logged in in a background tab.
 *
 * Requires page-gate.js to be loaded first (classic <script>, sets window.PageGate).
 */
import { API_BASE_URL } from "./aws-config.js";

const pageGate = (globalThis.PageGate && globalThis.PageGate.pageGate) || null;
const STORAGE_KEY = "nlpos_session_v1";

function currentPage() {
  const last = (location.pathname.split("/").pop() || "").toLowerCase();
  return last && last.indexOf(".") === -1 ? last + ".html" : last;
}

function decodeJwt(token) {
  try {
    const [, payload] = token.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return {};
  }
}

function normalizeRole(r) {
  const s = String(r || "billing").trim().toLowerCase();
  if (s === "staff") return "billing";
  if (s === "cafe") return "cafe_billing";
  return s;
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private-browsing / storage blocked — session just won't survive a reload */
  }
}

let _session = loadSession();

export function getIdToken() {
  return _session?.idToken || null;
}

export function getCurrentUser() {
  if (!_session) return null;
  const claims = decodeJwt(_session.idToken);
  return {
    id: claims["custom:pos_uid"] || claims.sub,
    uid: claims["custom:pos_uid"] || claims.sub,
    username: _session.user?.username || claims["cognito:username"] || "",
    full_name: _session.user?.full_name || "",
    role: normalizeRole(claims["custom:role"]),
  };
}

/** login.js replacement: POST loginWithPassword (unauthenticated route),
 * store the returned Cognito tokens. */
export async function loginWithPassword(username, password) {
  // the trailing "/login" segment is a required path param on every
  // "/api/callable/{module}/{action}" route (api-stack.ts) even though this
  // particular handler ignores it (it has exactly one operation).
  const res = await fetch(`${API_BASE_URL}/api/callable/loginWithPassword/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || "Login failed. Please try again.");
  }
  _session = { idToken: data.token, accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user, expiresAt: Date.now() + (data.expiresIn || 3600) * 1000 };
  saveSession(_session);
  return data.user;
}

export async function logout() {
  _session = null;
  saveSession(null);
  window.location.href = "login.html";
}

/** requireAuth() replacement — same role-based page gating as the Firebase
 * version, minus the realtime "your account was deactivated" push (no
 * client-readable users table to watch; a deactivated Cognito user simply
 * fails the next API call → 401 → the api-shim's own redirect-to-login
 * handles it, so this degrades to "next action" instead of "instantly", an
 * accepted trade-off — see aws/docs/PARITY-CHECKLIST.md). */
export function requireAuth() {
  const user = getCurrentUser();
  // an expired token still decodes fine client-side but every API call will
  // 401 — treat "expired" the same as "signed out" here so the redirect
  // happens before a confusing round trip.
  const expired = _session && _session.expiresAt && Date.now() > _session.expiresAt;
  const effectiveUser = expired ? null : user;
  if (expired) { _session = null; saveSession(null); }

  const page = currentPage();
  const gate = pageGate ? pageGate(effectiveUser ? effectiveUser.role : null, page) : { action: effectiveUser ? "allow" : "redirect", to: "login.html" };
  if (gate.action === "redirect") {
    window.location.href = gate.to;
    return null;
  }
  return effectiveUser;
}
