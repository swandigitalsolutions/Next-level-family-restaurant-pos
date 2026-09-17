/*
 * firebase-init.js — one-time Firebase Web SDK bootstrap for every staff page.
 * ES module, no bundler (matches the existing no-build frontend). Loaded once;
 * re-imports return the same singletons.
 */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFunctions,
  connectFunctionsEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import {
  firebaseConfig,
  FUNCTIONS_REGION,
  USE_EMULATORS,
  EMULATOR_PORTS,
} from "./firebase-config.js";

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// --- App Check (production) -------------------------------------------------
// DEPLOY.md step 4: once a reCAPTCHA v3 site key exists, set it in
// firebase-config.js as RECAPTCHA_SITE_KEY and uncomment this block. It protects
// the public qrApi / websiteMenu surface (gated server-side by ENFORCE_APP_CHECK).
//
// import { initializeAppCheck, ReCaptchaV3Provider } from
//   "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js";
// import { RECAPTCHA_SITE_KEY } from "./firebase-config.js";
// if (!USE_EMULATORS && RECAPTCHA_SITE_KEY) {
//   initializeAppCheck(app, {
//     provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
//     isTokenAutoRefreshEnabled: true,
//   });
// }

export const auth = getAuth(app);
export const functions = getFunctions(app, FUNCTIONS_REGION);
export const db = getFirestore(app);

if (USE_EMULATORS && !globalThis.__NL_EMU_WIRED__) {
  globalThis.__NL_EMU_WIRED__ = true;
  const host = "127.0.0.1";
  connectAuthEmulator(auth, `http://${host}:${EMULATOR_PORTS.auth}`, { disableWarnings: true });
  connectFunctionsEmulator(functions, host, EMULATOR_PORTS.functions);
  connectFirestoreEmulator(db, host, EMULATOR_PORTS.firestore);
  // eslint-disable-next-line no-console
  console.info("[firebase-init] connected to local emulators");
}
