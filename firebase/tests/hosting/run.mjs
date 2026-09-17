#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.join(here, "..", "..");
const jdkBin = path.join(firebaseDir, "tools", "jdk", "bin");
if (existsSync(path.join(jdkBin, "java.exe")) || existsSync(path.join(jdkBin, "java"))) {
  process.env.PATH = `${jdkBin}${path.delimiter}${process.env.PATH}`;
  process.env.JAVA_HOME = path.join(firebaseDir, "tools", "jdk");
} else if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
  console.log("SKIPPED: hosting smoke needs a JRE for the emulator.");
  process.exit(0);
}

// functions must be built (hosting rewrites invoke them)
if (spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", "functions", "run", "build"], {
  stdio: "inherit", cwd: firebaseDir, shell: process.platform === "win32",
}).status !== 0) process.exit(1);

const bin = path.join(firebaseDir, "node_modules", ".bin", process.platform === "win32" ? "firebase.cmd" : "firebase");
const cmd = `"${bin}" emulators:exec --only hosting,functions,firestore,auth --project nextlevel-pos "node --test tests/hosting/smoke.mjs"`;
const r = spawnSync(cmd, { stdio: "inherit", cwd: firebaseDir, shell: true, env: process.env });
process.exit(r.status ?? 1);
