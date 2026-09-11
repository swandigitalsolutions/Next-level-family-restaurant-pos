/**
 * Postgres connection pool for Lambda. Credentials come from Secrets Manager
 * (rotated), fetched once per cold start and cached across warm invocations —
 * mirrors firebase/functions/src/lib/adminSdk.ts's "init once, reuse" pattern.
 *
 * RDS Proxy sits in front of the instance (see aws/infra/lib/database-stack.ts)
 * so Lambda's connection-per-invocation concurrency doesn't exhaust Postgres
 * max_connections the way raw RDS would under burst traffic.
 */
import { Pool, PoolClient } from "pg";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

let pool: Pool | undefined;
let cachedSecret: { host: string; port: number; dbname: string; username: string; password: string } | undefined;

async function loadSecret(): Promise<typeof cachedSecret> {
  if (cachedSecret) return cachedSecret;
  // Local/CI test escape hatch ONLY — never used by a deployed Lambda (which
  // always has DB_SECRET_ARN set by the CDK stack and no reason to set this).
  // Lets integration tests point at a disposable local Postgres without a
  // real Secrets Manager secret.
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    cachedSecret = {
      host: u.hostname, port: Number(u.port || 5432), dbname: u.pathname.replace(/^\//, "") || "posdb",
      username: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    };
    return cachedSecret;
  }
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error("DB_SECRET_ARN env var not set — see aws/infra CDK DatabaseStack output");
  }
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const parsed = JSON.parse(res.SecretString || "{}");
  cachedSecret = {
    host: process.env.DB_PROXY_ENDPOINT || parsed.host,
    port: Number(parsed.port || 5432),
    dbname: process.env.DB_NAME || "posdb",
    username: parsed.username,
    password: parsed.password,
  };
  return cachedSecret;
}

export async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const s = await loadSecret();
  pool = new Pool({
    host: s!.host,
    port: s!.port,
    database: s!.dbname,
    user: s!.username,
    password: s!.password,
    // Real RDS Proxy always requires TLS; a local test Postgres started
    // without SSL configured does not speak it at all.
    ssl: process.env.DATABASE_URL ? false : { rejectUnauthorized: true },
    max: 5, // Lambda: keep small per-container; RDS Proxy multiplexes across containers
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

/** Run `fn` inside a SERIALIZABLE transaction with automatic retry on
 * 40001 (serialization_failure) / 40P01 (deadlock_detected) — the Postgres
 * analogue of Firestore's automatic transaction-contention retry. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  opts: { retries?: number; isolation?: "SERIALIZABLE" | "READ COMMITTED" } = {},
): Promise<T> {
  const retries = opts.retries ?? 5;
  const isolation = opts.isolation ?? "SERIALIZABLE";
  const p = await getPool();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = await p.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      const retryable = e && (e.code === "40001" || e.code === "40P01");
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * Math.pow(2, attempt) + Math.random() * 20));
        continue;
      }
      throw e;
    } finally {
      client.release();
    }
  }
  throw new Error("withTransaction: exhausted retries");
}
