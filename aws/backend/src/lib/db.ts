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

/** Drop the cached credentials and pool so the next call reconnects.
 *
 * The database secret is rotated. A warm Lambda container caches the old
 * password forever, so from the moment of a rotation every invocation in that
 * container fails authentication - and the container can stay warm for hours.
 * The symptom is a POS that works on some requests and not others, with no
 * deploy to blame. Any authentication failure now throws that cache away. */
async function resetConnection(): Promise<void> {
  cachedSecret = undefined;
  const dying = pool;
  pool = undefined;
  if (dying) await dying.end().catch(() => {});
}

/** Postgres error codes that mean "these credentials are no longer valid". */
function isAuthError(e: any): boolean {
  return e && (e.code === "28P01" || e.code === "28000" || /password authentication failed/i.test(String(e?.message)));
}

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
  const created = new Pool({
    host: s!.host,
    port: s!.port,
    database: s!.dbname,
    user: s!.username,
    password: s!.password,
    // Real RDS Proxy always requires TLS; a local test Postgres started
    // without SSL configured does not speak it at all.
    ssl: process.env.DATABASE_URL ? false : buildTls(),
    max: 5, // Lambda: keep small per-container; RDS Proxy multiplexes across containers
    idleTimeoutMillis: 30_000,
    // Without these, a Lambda whose database has gone away simply sits there
    // until the function's own timeout - burning the full billed duration and
    // leaving the till spinning - and one pathological query can hold a row
    // lock for as long as it likes. Both are bounded now.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5_000),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15_000),
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 20_000),
  });

  // `pg` emits 'error' on IDLE clients when the server hangs up on them -
  // an RDS Proxy failover, an idle-timeout reap, a deploy on the database.
  // An 'error' event with no listener is an UNCAUGHT EXCEPTION in Node, which
  // kills the whole Lambda container, including any other request it is
  // serving at that moment. Absorbing it here turns a crash into a log line;
  // the pool discards the dead client and opens a fresh one by itself.
  created.on("error", (e) => {
    // eslint-disable-next-line no-console
    console.error("postgres idle client error (pool will recover)", e);
  });

  pool = created;
  return pool;
}

/** TLS settings for RDS Proxy.
 *
 * RDS/RDS Proxy present certificates signed by the Amazon RDS CA, which is NOT
 * in Node's default trust store - so `rejectUnauthorized: true` on its own
 * fails to verify and every connection is refused. Point DB_CA_BUNDLE at the
 * bundled Amazon root (see aws/docs/DEPLOY.md) to verify properly. Verification
 * can only be turned off by setting DB_TLS_INSECURE=true explicitly, so it can
 * never happen by accident. */
function buildTls(): { rejectUnauthorized: boolean; ca?: string } {
  if (process.env.DB_TLS_INSECURE === "true") {
    // eslint-disable-next-line no-console
    console.warn("DB_TLS_INSECURE=true — the database connection is NOT verifying its certificate");
    return { rejectUnauthorized: false };
  }
  const caPath = process.env.DB_CA_BUNDLE;
  if (caPath) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs") as typeof import("fs");
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, "utf8") };
  }
  const caPem = process.env.DB_CA_PEM;
  if (caPem) return { rejectUnauthorized: true, ca: caPem };
  return { rejectUnauthorized: true };
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
  for (let attempt = 0; attempt <= retries; attempt++) {
    const p = await getPool();
    let client: PoolClient;
    try {
      client = await p.connect();
    } catch (e: any) {
      // Could not even get a connection. If the credentials were rotated out
      // from under this warm container, drop them and try once more with fresh
      // ones rather than failing every request until the container recycles.
      if (isAuthError(e) && attempt < retries) {
        await resetConnection();
        continue;
      }
      throw e;
    }
    let brokenClient = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      if (isAuthError(e) && attempt < retries) {
        brokenClient = true;
        await resetConnection();
        continue;
      }
      const retryable = e && (e.code === "40001" || e.code === "40P01");
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * Math.pow(2, attempt) + Math.random() * 20));
        continue;
      }
      throw e;
    } finally {
      // Destroy rather than reuse a client whose connection we no longer trust.
      client.release(brokenClient ? true : undefined);
    }
  }
  throw new Error("withTransaction: exhausted retries");
}
