#!/usr/bin/env node
/**
 * Emulator-backed integration tests (Admin SDK against Firestore + Auth
 * emulators): the gap-safe counter, the stock-decrement primitive, and ETL
 * idempotency. Needs the portable JRE at firebase/tools/jdk/ (or a system java).
 * Requires `functions` to be built first (imports functions/lib/**).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.join(here, "..", "..");
const jdkBin = path.join(firebaseDir, "tools", "jdk", "bin");

function ensureJava() {
  if (existsSync(path.join(jdkBin, "java.exe")) || existsSync(path.join(jdkBin, "java"))) {
    process.env.PATH = `${jdkBin}${path.delimiter}${process.env.PATH}`;
    process.env.JAVA_HOME = path.join(firebaseDir, "tools", "jdk");
    return true;
  }
  return spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;
}

if (!ensureJava()) {
  console.log("SKIPPED: integration tests need a JRE (firebase/tools/jdk/ or system java).");
  process.exit(0);
}

// ensure functions are compiled
const build = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["--prefix", "functions", "run", "build"],
  { stdio: "inherit", cwd: firebaseDir, shell: process.platform === "win32" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const isWin = process.platform === "win32";
const firebaseBin = path.join(firebaseDir, "node_modules", ".bin", isWin ? "firebase.cmd" : "firebase");
// functions emulator too: onBillWrite trigger + the HTTP endpoints (qrApi / websiteMenu / exportReport).
const command = `"${firebaseBin}" emulators:exec --only functions,firestore,auth --project demo-nextlevel-int "node tests/integration/_exec.mjs"`;
const r = spawnSync(command, { stdio: "inherit", cwd: firebaseDir, shell: true, env: process.env });
process.exit(r.status ?? 1);
