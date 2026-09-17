// Shared setup for the Firestore rules specs. One emulator, one ruleset;
// each spec file gets its own RulesTestEnvironment and clears data in `before`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RULES = readFileSync(path.join(here, "..", "..", "firestore.rules"), "utf8");

export async function makeEnv(projectId) {
  const env = await initializeTestEnvironment({ projectId, firestore: { rules: RULES } });
  await env.clearFirestore();
  return env;
}

export const asRole = (env, uid, role) => env.authenticatedContext(uid, { role }).firestore();
export const anon = (env) => env.unauthenticatedContext().firestore();
export const noRole = (env, uid) => env.authenticatedContext(uid, {}).firestore();
