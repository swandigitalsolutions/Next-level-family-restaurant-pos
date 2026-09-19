/**
 * Werkzeug-compatible password hashing, so the Firebase auth path verifies the
 * EXACT hashes already stored by the Flask app (backend/database.py uses
 * werkzeug.security.generate_password_hash / check_password_hash).
 *
 * Reference: Werkzeug 3.0.3 werkzeug/security.py
 *   pwhash format:  "<method>$<salt>$<hexdigest>"   (split on the first 2 "$")
 *   scrypt : method "scrypt[:n:r:p]"  -> hashlib.scrypt(pw, salt, n, r, p,
 *            maxmem=132*n*r*p)  with the default dklen=64  (128 hex chars)
 *   pbkdf2 : method "pbkdf2[:hash[:iterations]]" -> hashlib.pbkdf2_hmac(hash,
 *            pw, salt, iterations)  with dklen = digest size of <hash>
 *   compare: hmac.compare_digest on the hex strings
 *
 * Node's crypto.scryptSync / pbkdf2Sync call the same primitives (OpenSSL), so
 * given identical inputs the bytes are identical. maxmem only gates whether the
 * call is permitted, it does not change the result.
 */

import * as crypto from "crypto";

const SALT_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DEFAULT_PBKDF2_ITERATIONS = 600000;

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function digestSize(hashName: string): number {
  // Throws for an unknown algorithm — caller turns that into "does not verify".
  return crypto.createHash(hashName).digest().length;
}

/** Recompute the hex digest for `password` using the parameters in `method`. */
function hashInternal(method: string, salt: string, password: string): string {
  const [algo, ...args] = method.split(":");
  const saltBuf = Buffer.from(salt, "utf8");
  const pwBuf = Buffer.from(password, "utf8");

  if (algo === "scrypt") {
    let n = 32768;
    let r = 8;
    let p = 1;
    if (args.length > 0) {
      if (args.length !== 3) throw new Error("'scrypt' takes 3 arguments.");
      [n, r, p] = args.map((x) => parseInt(x, 10));
      if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
        throw new Error("'scrypt' takes 3 integer arguments.");
      }
    }
    const maxmem = 132 * n * r * p;
    return crypto
      .scryptSync(pwBuf, saltBuf, 64, { N: n, r, p, maxmem })
      .toString("hex");
  }

  if (algo === "pbkdf2") {
    let hashName = "sha256";
    let iterations = DEFAULT_PBKDF2_ITERATIONS;
    if (args.length === 1) {
      hashName = args[0];
    } else if (args.length === 2) {
      hashName = args[0];
      iterations = parseInt(args[1], 10);
    } else if (args.length > 2) {
      throw new Error("'pbkdf2' takes 2 arguments.");
    }
    if (!Number.isInteger(iterations) || iterations <= 0) {
      throw new Error("invalid pbkdf2 iterations");
    }
    const dklen = digestSize(hashName);
    return crypto
      .pbkdf2Sync(pwBuf, saltBuf, iterations, dklen, hashName)
      .toString("hex");
  }

  throw new Error(`Invalid hash method '${algo}'.`);
}

/**
 * Werkzeug check_password_hash. Returns false for a malformed hash string or an
 * unsupported method (Werkzeug would raise on the latter; in an auth path we
 * fail closed instead).
 */
export function checkPasswordHash(pwhash: string, password: string): boolean {
  if (typeof pwhash !== "string" || typeof password !== "string") return false;
  const first = pwhash.indexOf("$");
  if (first < 0) return false;
  const second = pwhash.indexOf("$", first + 1);
  if (second < 0) return false;

  const method = pwhash.slice(0, first);
  const salt = pwhash.slice(first + 1, second);
  const hashval = pwhash.slice(second + 1);
  if (!method || !salt || !hashval) return false;

  try {
    const derived = hashInternal(method, salt, password);
    return timingSafeEqualHex(derived, hashval);
  } catch {
    return false;
  }
}

/**
 * Werkzeug generate_password_hash. Matches the Flask default
 * (backend/database.py -> scrypt:32768:8:1, 16-char salt from SALT_CHARS), so a
 * hash produced here is accepted by the Flask app too. Set PASSWORD_HASH_METHOD
 * to "pbkdf2:sha256" for parity with a dev box that lacks scrypt.
 */
export function generatePasswordHash(
  password: string,
  method: string = process.env.PASSWORD_HASH_METHOD || "scrypt",
  saltLength = 16,
): string {
  const saltBytes = crypto.randomBytes(saltLength);
  let salt = "";
  for (let i = 0; i < saltLength; i++) {
    salt += SALT_CHARS[saltBytes[i] % SALT_CHARS.length];
  }
  const [algo] = method.split(":");
  const digest = hashInternal(method, salt, password);
  // hashInternal echoes back canonical params; rebuild the stored method string.
  let canonical = method;
  if (algo === "scrypt" && method === "scrypt") canonical = "scrypt:32768:8:1";
  if (algo === "pbkdf2") {
    const parts = method.split(":");
    const h = parts[1] || "sha256";
    const it = parts[2] || String(DEFAULT_PBKDF2_ITERATIONS);
    canonical = `pbkdf2:${h}:${it}`;
  }
  return `${canonical}$${salt}$${digest}`;
}
