#!/usr/bin/env node
/**
 * Superseded in Phase 3 by ./etl-firestore.mjs (SQLite/dry/emulator).
 * The Postgres `pg` reader + `--target live` path land in Phase 6.
 */
console.error(
  "Use ./etl-firestore.mjs instead:\n" +
    "  node scripts/etl-firestore.mjs --source <sqlite> --target dry\n" +
    "  npm run etl:emulator\n" +
    "  npm run seed",
);
process.exit(1);
