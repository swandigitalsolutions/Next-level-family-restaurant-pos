/*
 * auth.js — staff authentication for the migrated pages.
 * Replaces the session-cookie bits of frontend/js/common.js (requireAuth,
 * logout) and frontend/js/login.js, keeping the username+password UX.
 *
 * Requires page-gate.js to be loaded first (classic <script>, sets window.PageGate).
 */
import {
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, functions, db } from "./firebase-init.js";

const pageGate = (globalThis.PageGate && globalThis.PageGate.pageGate) || null;

/** staff->billing, cafe->cafe_billing; unknowns pass through. Mirrors functions/src/lib/config.ts. */
function normalizeRole(r) {
  const s = String(r || "billing").trim().toLowerCase();
  if (s === "staff") return "billing";
  if (s === "cafe") return "cafe_billing";
  return s;
}

function currentPage() {
  return (location.pathname.split("/").pop() || "").toLowerCase();
}

/** Shape mirrors the old GET /api/me payload. */
async function toSessionUser(fbUser) {
  if (!fbUser) return null;
  const res = await fbUser.getIdTokenResult();
  return {
    id: fbUser.uid,
    uid: fbUser.uid,
    username: fbUser.displayName || String(res.claims.username || ""),
    full_name: fbUser.displayName || "",
    role: normalizeRole(res.claims.role),
  };
}

/** login.js replacement: callable -> custom token -> Firebase sign-in. */
export async function loginWithPassword(username, password) {
  const call = httpsCallable(functions, "loginWithPassword");
  let data;
  try {
    ({ data } = await call({ username, password }));
  } catch (err) {
    // Firebase wraps HttpsError; surface the human message like the old API did.
    throw new Error(err?.message || "Login failed. Please try again.");
  }
  await signInWithCustomToken(auth, data.token);
  return data.user;
}

export async function logout() {
  try {
    await signOut(auth);
  } catch (e) {
    /* ignore */
  }
  window.location.href = "login.html";
}

let _deactivationWatch = null;
function watchDeactivation(uid) {
  if (_deactivationWatch) return;
  _deactivationWatch = onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      const status = snap.exists() ? snap.data().status : "inactive";
      if (status && status !== "active") logout();
    },
    () => {
      /* rules deny non-self reads; ignore */
    },
  );
}

/**
 * requireAuth() replacement. Resolves the signed-in user, applies the same
 * role-based page gating as common.js, redirecting when needed. Returns the
 * session user or null (after having triggered a redirect).
 */
export function requireAuth() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      unsub();
      const user = await toSessionUser(fbUser);
      const gate = pageGate
        ? pageGate(user ? user.role : null, currentPage())
        : { action: user ? "allow" : "redirect", to: "login.html" };

      if (gate.action === "redirect") {
        window.location.href = gate.to;
        resolve(null);
        return;
      }
      if (user) watchDeactivation(user.uid);
      resolve(user);
    });
  });
}

/** Subscribe to auth changes (for pages that need live updates). */
export function onAuthReady(cb) {
  return onAuthStateChanged(auth, async (fbUser) => cb(await toSessionUser(fbUser)));
}
