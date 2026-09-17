// ETL write target. `dry` = plan only. `emulator` = Admin SDK against the local
// Firestore/Auth emulators. `live` = a real project, gated hard.

const COLLECTIONS = [
  "users",
  "userCredentials",
  "categories",
  "catalog",
  "tables",
  "tableSessions",
  "bills",
  "qrOrders",
  "auditLog",
  "counters",
];

export async function makeTarget({ mode, projectId, allowLive }) {
  if (mode === "dry") {
    return {
      mode,
      async writeCollection() {},
      async close() {},
      async verifyCount() {
        return null;
      },
      async getDoc() {
        return undefined;
      },
      async createAuthUsers() {
        return { created: 0, updated: 0 };
      },
    };
  }

  if (mode === "live" && !allowLive) {
    throw new Error(
      "refusing to write a live project. Re-run with --target emulator, or pass " +
        "--i-understand-this-writes-production (Phase 6 only).",
    );
  }
  if (mode === "emulator" && !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — run this under `firebase emulators:exec`.",
    );
  }
  if (mode === "live" && process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("--target live but FIRESTORE_EMULATOR_HOST is set. Aborting to avoid confusion.");
  }

  const { initializeApp, getApps, deleteApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getAuth } = await import("firebase-admin/auth");

  const app =
    getApps().find((a) => a.name === "etl") ||
    initializeApp({ projectId: projectId || process.env.GCLOUD_PROJECT || "demo-nextlevel-etl" }, "etl");
  const db = getFirestore(app);
  const auth = getAuth(app);

  return {
    mode,
    db,
    async writeCollection(name, docs) {
      const writer = db.bulkWriter();
      for (const { id, data } of docs) {
        writer.set(db.collection(name).doc(String(id)), data); // no merge -> idempotent overwrite
      }
      await writer.close();
    },
    async close() {
      await deleteApp(app).catch(() => {});
    },
    async verifyCount(name) {
      const snap = await db.collection(name).count().get();
      return snap.data().count;
    },
    async getDoc(name, id) {
      const d = await db.collection(name).doc(String(id)).get();
      return d.exists ? d.data() : undefined;
    },
    async createAuthUsers(authUsers) {
      if (!process.env.FIREBASE_AUTH_EMULATOR_HOST && mode === "emulator") {
        throw new Error("FIREBASE_AUTH_EMULATOR_HOST not set — start the auth emulator too.");
      }
      let created = 0;
      let updated = 0;
      for (const u of authUsers) {
        try {
          await auth.createUser({ uid: u.uid, displayName: u.displayName, disabled: !!u.disabled });
          created++;
        } catch (e) {
          if (String(e?.code || e).includes("already-exists") || String(e).includes("auth/uid-already-exists")) {
            await auth.updateUser(u.uid, { displayName: u.displayName, disabled: !!u.disabled });
            updated++;
          } else {
            throw e;
          }
        }
        await auth.setCustomUserClaims(u.uid, { role: u.role });
      }
      return { created, updated };
    },
  };
}

export { COLLECTIONS };
