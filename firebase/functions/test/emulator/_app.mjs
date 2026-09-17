// Initialise the DEFAULT admin app exactly once, so the compiled Cloud Function
// handlers (which call getFirestore()/getAuth() on the default app) and the test
// code share one emulator connection. Import for side effect.
import { initializeApp, getApps } from "firebase-admin/app";

if (!getApps().some((a) => a.name === "[DEFAULT]")) {
  initializeApp({ projectId: "demo-nextlevel-int" });
}
