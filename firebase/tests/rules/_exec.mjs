/**
 * Test entrypoint invoked inside `firebase emulators:exec`. Runs every
 * firebase/tests/rules/*.test.mjs under node:test with the spec reporter.
 * Kept flag-free (`node _exec.mjs`) so Windows shell quoting can't drop a `--flag`.
 */
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join(here, f));

if (files.length === 0) {
  console.error("no *.test.mjs specs found in", here);
  process.exit(1);
}

const stream = run({ files, concurrency: false, timeout: 120_000 });
stream.on("test:fail", () => {
  process.exitCode = 1;
});
stream.compose(spec()).pipe(process.stdout);
