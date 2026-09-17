/*
 * firebase-config.js — Firebase Web SDK config for the POS staff app.
 *
 * Project: nextlevel-pos (web app "pos-staff", registered 2026-09-10).
 * A Web API key is NOT a secret — it identifies the project and is protected by
 * Firestore Security Rules + App Check. Committing it is standard practice.
 * May still be overridden at runtime via window.__FIREBASE_CONFIG__.
 */
export const firebaseConfig = (typeof window !== "undefined" && window.__FIREBASE_CONFIG__) || {
  apiKey: "AIzaSyAIubiEDfh9fae0LcqRCC1dRQG9sqV3KK4",
  authDomain: "nextlevel-pos.firebaseapp.com",
  projectId: "nextlevel-pos",
  storageBucket: "nextlevel-pos.firebasestorage.app",
  messagingSenderId: "469526079388",
  appId: "1:469526079388:web:d920d19779b2956c0a0a59",
};

/** asia-south1 to match the deployed Functions region. */
export const FUNCTIONS_REGION = "asia-south1";

/** Local emulator run when served from localhost / 127.0.0.1 / *.local. */
export const USE_EMULATORS =
  typeof location !== "undefined" &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

export const EMULATOR_PORTS = { auth: 9099, functions: 5001, firestore: 8080 };
