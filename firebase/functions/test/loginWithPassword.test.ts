import type { CallableRequest } from "firebase-functions/v2/https";
import * as fs from "fs";
import * as path from "path";

// --- mock the Firestore + Auth boundary; keep werkzeugHash real -------------
jest.mock("../src/lib/authService", () => ({
  setRoleClaim: jest.fn(async () => undefined),
  mintCustomToken: jest.fn(async (uid: string) => `custom-token-for-${uid}`),
}));

const throttleStore = new Map<string, { count: number; lockedAt: number }>();
jest.mock("../src/lib/repo", () => ({
  findCredentialByUsername: jest.fn(),
  getUserByUid: jest.fn(),
  throttleGet: jest.fn(async (k: string) => throttleStore.get(k) ?? null),
  throttleBump: jest.fn(async (k: string) => {
    const e = throttleStore.get(k) ?? { count: 0, lockedAt: 0 };
    throttleStore.set(k, { count: e.count + 1, lockedAt: Date.now() });
  }),
  throttleClear: jest.fn(async (k: string) => void throttleStore.delete(k)),
}));

import { handleLogin } from "../src/callable/loginWithPassword";
import * as repo from "../src/lib/repo";
import * as authService from "../src/lib/authService";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "werkzeug-hashes.json"), "utf8"),
);
const ADMIN_HASH: string = fixture.cases.find((c: any) => c.label === "db_admin").hash;
const OWNER_HASH: string = fixture.cases.find((c: any) => c.label === "db_owner").hash;

const findCred = repo.findCredentialByUsername as jest.Mock;
const getUser = repo.getUserByUid as jest.Mock;

function req(data: any, ip = "203.0.113.9"): CallableRequest<any> {
  return {
    data,
    rawRequest: { headers: { "x-forwarded-for": ip }, ip },
    acceptsStreaming: false,
  } as unknown as CallableRequest<any>;
}

const adminProfile = {
  uid: "uid-admin",
  username: "admin",
  usernameLower: "admin",
  fullName: "Administrator",
  phone: "",
  role: "admin",
  status: "active",
};

beforeEach(() => {
  throttleStore.clear();
  jest.clearAllMocks();
  findCred.mockImplementation(async (u: string) =>
    u === "admin"
      ? { uid: "uid-admin", usernameLower: "admin", passwordHash: ADMIN_HASH }
      : u === "owner"
        ? { uid: "uid-owner", usernameLower: "owner", passwordHash: OWNER_HASH }
        : null,
  );
  getUser.mockImplementation(async (uid: string) =>
    uid === "uid-admin"
      ? adminProfile
      : uid === "uid-owner"
        ? { ...adminProfile, uid: "uid-owner", username: "owner", role: "owner" }
        : null,
  );
});

describe("loginWithPassword — verifies the SERVER-ONLY credential hash", () => {
  it("mints a custom token with the role claim on the right password", async () => {
    const out = await handleLogin(req({ username: "  ADMIN ", password: "nextlevel@123" }));
    expect(out).toEqual({
      token: "custom-token-for-uid-admin",
      user: { id: "uid-admin", username: "admin", full_name: "Administrator", role: "admin" },
    });
    expect(repo.findCredentialByUsername).toHaveBeenCalledWith("admin");
    expect(authService.mintCustomToken).toHaveBeenCalledWith("uid-admin", "admin");
    expect(authService.setRoleClaim).toHaveBeenCalledWith("uid-admin", "admin");
    expect(repo.throttleClear).toHaveBeenCalled();
    expect(repo.throttleBump).not.toHaveBeenCalled();
  });

  it("owner logs in and carries the owner role", async () => {
    const out = await handleLogin(req({ username: "owner", password: "owner@123" }));
    expect(out.user.role).toBe("owner");
    expect(authService.mintCustomToken).toHaveBeenCalledWith("uid-owner", "owner");
  });

  it("rejects a wrong password with a generic message and bumps the throttle", async () => {
    await expect(handleLogin(req({ username: "admin", password: "nope" }))).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Invalid username or password",
    });
    expect(repo.throttleBump).toHaveBeenCalledTimes(1);
    expect(authService.mintCustomToken).not.toHaveBeenCalled();
  });

  it("rejects an unknown username with the SAME generic message", async () => {
    await expect(handleLogin(req({ username: "ghost", password: "whatever" }))).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Invalid username or password",
    });
    expect(repo.throttleBump).toHaveBeenCalledTimes(1);
  });

  it("rejects a credential whose profile is missing (no leak)", async () => {
    findCred.mockResolvedValueOnce({ uid: "orphan", usernameLower: "admin", passwordHash: ADMIN_HASH });
    getUser.mockResolvedValueOnce(null);
    await expect(handleLogin(req({ username: "admin", password: "nextlevel@123" }))).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Invalid username or password",
    });
  });

  it("refuses a deactivated account even with the right password", async () => {
    getUser.mockResolvedValueOnce({ ...adminProfile, status: "inactive" });
    await expect(handleLogin(req({ username: "admin", password: "nextlevel@123" }))).rejects.toMatchObject({
      code: "permission-denied",
      message: "This account has been deactivated. Contact your administrator.",
    });
    expect(authService.mintCustomToken).not.toHaveBeenCalled();
  });

  it("requires both fields", async () => {
    await expect(handleLogin(req({ username: "", password: "x" }))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(handleLogin(req({ username: "admin", password: "" }))).rejects.toMatchObject({ code: "invalid-argument" });
    expect(findCred).not.toHaveBeenCalled();
  });

  it("locks out after 6 failures from one IP, then unlocks after the window", async () => {
    for (let i = 0; i < 6; i++) {
      await expect(handleLogin(req({ username: "admin", password: "bad" }))).rejects.toMatchObject({ code: "unauthenticated" });
    }
    await expect(handleLogin(req({ username: "admin", password: "nextlevel@123" }))).rejects.toMatchObject({
      code: "resource-exhausted",
    });
    const callsWhileLocked = findCred.mock.calls.length;
    await expect(handleLogin(req({ username: "admin", password: "nextlevel@123" }))).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(findCred.mock.calls.length).toBe(callsWhileLocked);

    const key = [...throttleStore.keys()][0];
    throttleStore.set(key, { count: 6, lockedAt: Date.now() - 6 * 60 * 1000 });
    const out = await handleLogin(req({ username: "admin", password: "nextlevel@123" }));
    expect(out.token).toBe("custom-token-for-uid-admin");
  });

  it("throttles per IP, not globally", async () => {
    for (let i = 0; i < 6; i++) {
      await handleLogin(req({ username: "admin", password: "bad" }, "10.0.0.1")).catch(() => undefined);
    }
    await expect(handleLogin(req({ username: "admin", password: "nextlevel@123" }, "10.0.0.1"))).rejects.toMatchObject({ code: "resource-exhausted" });
    const out = await handleLogin(req({ username: "admin", password: "nextlevel@123" }, "10.0.0.2"));
    expect(out.token).toBe("custom-token-for-uid-admin");
  });
});
