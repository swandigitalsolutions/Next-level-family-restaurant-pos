// Test entrypoint run inside `firebase emulators:exec` (functions + Firestore + Auth).
// Flag-free so Windows shell quoting can't drop a --flag.
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = [
  here, // tests/integration/*  (primitives, idempotency — root firebase-admin, db injected)
  path.join(here, "..", "..", "functions", "test", "emulator"), // Phase 4 — functions' firebase-admin
];

const files = [];
for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (f.endsWith(".test.mjs")) files.push(path.join(d, f));
  }
}
if (!files.length) {
  console.error("no *.test.mjs found");
  process.exit(1);
}

const stream = run({ files, concurrency: false, timeout: 180_000 });
stream.on("test:fail", () => {
  process.exitCode = 1;
});
stream.compose(spec()).pipe(process.stdout);
