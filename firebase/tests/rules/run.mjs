#!/usr/bin/env node
/**
 * Firestore Security Rules test runner.
 *
 * @firebase/rules-unit-testing drives the Firestore emulator, which needs a JRE.
 * We ship a portable one at firebase/tools/jdk/ (gitignored). If neither that nor
 * a system `java` is found, exit 0 with a SKIPPED notice.
 *
 * When Java is present: start the Firestore emulator via `firebase emulators:exec`
 * and run every firebase/tests/rules/*.test.mjs under node's built-in test runner.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.join(here, "..", "..");
const portableJavaExe = path.join(firebaseDir, "tools", "jdk", "bin", "java.exe");
const portableJavaBin = path.join(firebaseDir, "tools", "jdk", "bin");

function ensureJava() {
  if (existsSync(portableJavaExe) || existsSync(path.join(portableJavaBin, "java"))) {
    process.env.PATH = `${portableJavaBin}${path.delimiter}${process.env.PATH}`;
    process.env.JAVA_HOME = path.join(firebaseDir, "tools", "jdk");
    return true;
  }
  return spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;
}

if (!ensureJava()) {
  console.log(
    "SKIPPED: Firestore rules tests need a JRE for the emulator.\n" +
      "  Drop a portable one at firebase/tools/jdk/ (bin/java[.exe]) or install a JDK, then re-run.\n" +
      "  Specs: firebase/tests/rules/*.test.mjs",
  );
  process.exit(0);
}

const isWin = process.platform === "win32";
const firebaseBin = path.join(
  firebaseDir,
  "node_modules",
  ".bin",
  isWin ? "firebase.cmd" : "firebase",
);

// One shell string: `firebase emulators:exec` takes the inner command as a single
// argument. The inner command is flag-free so Windows shell quoting can't mangle it.
const inner = "node tests/rules/_exec.mjs";
const command = `"${firebaseBin}" emulators:exec --only firestore --project demo-nextlevel-rules "${inner}"`;

const r = spawnSync(command, {
  stdio: "inherit",
  cwd: firebaseDir,
  shell: true,
  env: process.env,
});
process.exit(r.status ?? 1);
