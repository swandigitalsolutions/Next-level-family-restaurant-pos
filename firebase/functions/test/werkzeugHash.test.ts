import * as fs from "fs";
import * as path from "path";
import { checkPasswordHash, generatePasswordHash } from "../src/lib/werkzeugHash";

interface Case {
  label: string;
  password: string;
  hash: string;
  wrong: string;
  werkzeug_verifies?: boolean;
  werkzeug_rejects_wrong?: boolean;
}
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "werkzeug-hashes.json"),
    "utf8",
  ),
) as { werkzeug_version: string; cases: Case[] };

describe(`Werkzeug ${fixture.werkzeug_version} hash compatibility`, () => {
  it("has fixtures the real library actually produced", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of fixture.cases) {
    describe(c.label, () => {
      it("verifies the correct password", () => {
        expect(checkPasswordHash(c.hash, c.password)).toBe(true);
      });
      it("rejects the wrong password", () => {
        expect(checkPasswordHash(c.hash, c.wrong)).toBe(false);
      });
      if (c.werkzeug_verifies !== undefined) {
        it("Werkzeug itself agreed (fixture provenance)", () => {
          expect(c.werkzeug_verifies).toBe(true);
          expect(c.werkzeug_rejects_wrong).toBe(true);
        });
      }
    });
  }
});

describe("real backend/nextlevel.db seeded accounts", () => {
  const admin = fixture.cases.find((c) => c.label === "db_admin")!;
  const owner = fixture.cases.find((c) => c.label === "db_owner")!;
  it("admin / nextlevel@123", () => {
    expect(checkPasswordHash(admin.hash, "nextlevel@123")).toBe(true);
    expect(checkPasswordHash(admin.hash, "nextlevel@1234")).toBe(false);
    expect(checkPasswordHash(admin.hash, "")).toBe(false);
  });
  it("owner / owner@123", () => {
    expect(checkPasswordHash(owner.hash, "owner@123")).toBe(true);
    expect(checkPasswordHash(owner.hash, "Owner@123")).toBe(false);
  });
});

describe("malformed / hostile input fails closed", () => {
  it.each([
    ["", "pw"],
    ["notahash", "pw"],
    ["scrypt:32768:8:1$onlyonepart", "pw"],
    ["$$", "pw"],
    ["md5$abc$def", "pw"],
    ["scrypt:bad$salt$deadbeef", "pw"],
    ["pbkdf2:sha256:notanumber$salt$deadbeef", "pw"],
    ["pbkdf2:nope:1000$salt$deadbeef", "pw"],
  ])("%s -> false", (hash, pw) => {
    expect(checkPasswordHash(hash, pw)).toBe(false);
  });
  it("non-string args -> false", () => {
    expect(checkPasswordHash(undefined as unknown as string, "pw")).toBe(false);
    expect(checkPasswordHash("x$y$z", undefined as unknown as string)).toBe(false);
  });
});

describe("generatePasswordHash round-trips", () => {
  it("scrypt default is self-verifiable and Werkzeug-shaped", () => {
    const h = generatePasswordHash("hunter2");
    expect(h).toMatch(/^scrypt:32768:8:1\$[A-Za-z0-9]{16}\$[0-9a-f]{128}$/);
    expect(checkPasswordHash(h, "hunter2")).toBe(true);
    expect(checkPasswordHash(h, "hunter3")).toBe(false);
  });
  it("pbkdf2:sha256 variant is self-verifiable", () => {
    const h = generatePasswordHash("hunter2", "pbkdf2:sha256:200000");
    expect(h).toMatch(/^pbkdf2:sha256:200000\$[A-Za-z0-9]{16}\$[0-9a-f]{64}$/);
    expect(checkPasswordHash(h, "hunter2")).toBe(true);
  });
  it("distinct salts per call", () => {
    expect(generatePasswordHash("x")).not.toBe(generatePasswordHash("x"));
  });
});
