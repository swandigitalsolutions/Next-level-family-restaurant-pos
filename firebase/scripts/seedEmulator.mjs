#!/usr/bin/env node
/**
 * Seed the local Firestore + Auth emulators with the same starting data as
 * backend/database.py _seed(): 15 tables, admin/owner users (+ credentials +
 * custom claims), the food + alcohol menu, and the bill-number counters.
 *
 * Implemented as: run the Phase 3 ETL against the bundled backend/nextlevel.db
 * (which *is* the seed) with --target emulator --create-auth-users, wrapped in
 * `firebase emulators:exec` so the emulators are up.
 *
 *   node scripts/seedEmulator.mjs            # uses ../backend/nextlevel.db
 *   node scripts/seedEmulator.mjs --source scripts/fixtures/etl-source.sqlite
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.join(here, "..");
const jdkBin = path.join(firebaseDir, "tools", "jdk", "bin");
if (existsSync(path.join(jdkBin, "java.exe")) || existsSync(path.join(jdkBin, "java"))) {
  process.env.PATH = `${jdkBin}${path.delimiter}${process.env.PATH}`;
  process.env.JAVA_HOME = path.join(firebaseDir, "tools", "jdk");
} else if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
  console.error("No JRE found (need firebase/tools/jdk/ or a system java) — cannot start the emulators.");
  process.exit(1);
}

const argv = process.argv.slice(2);
const si = argv.indexOf("--source");
const source = si >= 0 ? argv[si + 1] : path.join(firebaseDir, "..", "backend", "nextlevel.db");

const isWin = process.platform === "win32";
const firebaseBin = path.join(firebaseDir, "node_modules", ".bin", isWin ? "firebase.cmd" : "firebase");
const project = "demo-nextlevel-seed";
const inner = `node scripts/etl-firestore.mjs --source "${source}" --target emulator --create-auth-users --project ${project} --report reports/phase3-seed-reconciliation.md`;
const cmd = `"${firebaseBin}" emulators:exec --only firestore,auth --project ${project} "${inner}"`;

const r = spawnSync(cmd, { stdio: "inherit", cwd: firebaseDir, shell: true, env: process.env });
process.exit(r.status ?? 1);
