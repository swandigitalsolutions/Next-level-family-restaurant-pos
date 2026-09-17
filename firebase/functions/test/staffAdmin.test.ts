import type { CallableRequest } from "firebase-functions/v2/https";

jest.mock("../src/lib/repo", () => ({
  getUserByUid: jest.fn(),
  usernameTaken: jest.fn(async () => false),
  countActiveAdmins: jest.fn(async () => 1),
  createUserProfile: jest.fn(async () => undefined),
  updateUserProfile: jest.fn(async () => undefined),
  listUserProfiles: jest.fn(async () => []),
  writeCredential: jest.fn(async () => undefined),
  updateCredential: jest.fn(async () => undefined),
  writeAudit: jest.fn(async () => undefined),
}));
jest.mock("../src/lib/authService", () => ({
  createAuthUser: jest.fn(async () => ({ uid: "new-uid" })),
  setRoleClaim: jest.fn(async () => undefined),
  setDisabled: jest.fn(async () => undefined),
}));

import {
  handleListStaff,
  handleCreateStaff,
  handleUpdateStaff,
  handleDeactivateStaff,
} from "../src/callable/staffAdmin";
import * as repo from "../src/lib/repo";
import * as authService from "../src/lib/authService";
import { checkPasswordHash } from "../src/lib/werkzeugHash";

function asRole(role: string | null, uid = "caller-1") {
  return {
    data: {},
    auth: role ? { uid, token: { role, username: "boss", uid } } : undefined,
    rawRequest: { headers: {}, ip: "127.0.0.1" },
    acceptsStreaming: false,
  } as unknown as CallableRequest<any>;
}
const withData = (r: CallableRequest<any>, data: any) => ({ ...r, data });

beforeEach(() => jest.clearAllMocks());

describe("listStaff", () => {
  it("is admin-only", async () => {
    for (const role of [null, "staff", "manager", "owner"]) {
      await expect(handleListStaff(asRole(role))).rejects.toMatchObject({
        code: expect.stringMatching(/unauthenticated|permission-denied/),
      });
    }
  });

  it("returns only sanitized fields — never a passwordHash", async () => {
    (repo.listUserProfiles as jest.Mock).mockResolvedValue([
      { uid: "u1", username: "admin", usernameLower: "admin", fullName: "Admin", phone: "1", role: "admin", status: "active" },
      { uid: "u2", username: "cash", usernameLower: "cash", fullName: "Cash", phone: "2", role: "staff", status: "inactive" },
    ]);
    const out = await handleListStaff(asRole("admin"));
    expect(out.staff).toEqual([
      { id: "u1", username: "admin", full_name: "Admin", phone: "1", role: "admin", status: "active" },
      { id: "u2", username: "cash", full_name: "Cash", phone: "2", role: "staff", status: "inactive" },
    ]);
    for (const row of out.staff) {
      expect(row).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(row)).not.toMatch(/scrypt:|pbkdf2:/);
    }
  });
});

describe("createStaff", () => {
  it("only admins may call", async () => {
    for (const role of [null, "staff", "manager", "owner"]) {
      await expect(
        handleCreateStaff(withData(asRole(role), { username: "abc", password: "secret1", full_name: "A" })),
      ).rejects.toMatchObject({ code: expect.stringMatching(/unauthenticated|permission-denied/) });
    }
    expect(authService.createAuthUser).not.toHaveBeenCalled();
  });

  it("writes the hash to userCredentials only — NOT to the profile — and returns nothing sensitive", async () => {
    const out = await handleCreateStaff(
      withData(asRole("admin"), { username: "Cashier.1", password: "secret1", full_name: "Cash One", phone: "9", role: "billing" }),
    );
    expect(out).toEqual({ id: "new-uid", username: "cashier.1", full_name: "Cash One", phone: "9", role: "billing", status: "active" });
    expect(out).not.toHaveProperty("passwordHash");

    // profile doc: no credential material
    const profileArg = (repo.createUserProfile as jest.Mock).mock.calls[0][0];
    expect(profileArg).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(profileArg)).not.toMatch(/scrypt:|pbkdf2:/);

    // credential doc: gets the verifiable Werkzeug hash, keyed by uid + usernameLower
    expect(repo.writeCredential).toHaveBeenCalledTimes(1);
    const [uid, hash, usernameLower] = (repo.writeCredential as jest.Mock).mock.calls[0];
    expect(uid).toBe("new-uid");
    expect(usernameLower).toBe("cashier.1");
    expect(hash).toMatch(/^scrypt:|^pbkdf2:/);
    expect(checkPasswordHash(hash, "secret1")).toBe(true);

    expect(authService.setRoleClaim).toHaveBeenCalledWith("new-uid", "billing");
    expect((repo.writeAudit as jest.Mock).mock.calls[0][0]).toMatchObject({ action: "staff.create", entityId: "new-uid" });
    // audit details never carry the hash
    expect(JSON.stringify((repo.writeAudit as jest.Mock).mock.calls[0][0])).not.toMatch(/scrypt:|pbkdf2:/);
  });

  it("enforces username regex, password length, role and uniqueness", async () => {
    await expect(handleCreateStaff(withData(asRole("admin"), { username: "aa", password: "secret1", full_name: "x" }))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(handleCreateStaff(withData(asRole("admin"), { username: "okname", password: "short", full_name: "x" }))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(handleCreateStaff(withData(asRole("admin"), { username: "okname", password: "secret1", full_name: "x", role: "superuser" }))).rejects.toMatchObject({ code: "invalid-argument" });
    (repo.usernameTaken as jest.Mock).mockResolvedValueOnce(true);
    await expect(handleCreateStaff(withData(asRole("admin"), { username: "okname", password: "secret1", full_name: "x" }))).rejects.toMatchObject({ code: "already-exists" });
    expect(repo.writeCredential).not.toHaveBeenCalled();
  });
});

describe("updateStaff", () => {
  const existingAdmin = { uid: "u-admin", username: "admin", usernameLower: "admin", fullName: "Admin", phone: "", role: "admin", status: "active" };

  it("blocks demoting the last active admin", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue(existingAdmin);
    (repo.countActiveAdmins as jest.Mock).mockResolvedValue(0);
    await expect(
      handleUpdateStaff(withData(asRole("admin"), { uid: "u-admin", role: "manager" })),
    ).rejects.toMatchObject({ code: "failed-precondition", message: "At least one active admin account must remain" });
    await expect(
      handleUpdateStaff(withData(asRole("admin"), { uid: "u-admin", status: "inactive" })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(repo.updateUserProfile).not.toHaveBeenCalled();
    expect(repo.updateCredential).not.toHaveBeenCalled();
  });

  it("allows demoting an admin when another active admin remains, and follows the claim", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue(existingAdmin);
    (repo.countActiveAdmins as jest.Mock).mockResolvedValue(1);
    const out = await handleUpdateStaff(withData(asRole("admin"), { uid: "u-admin", role: "manager" }));
    expect(out).toMatchObject({ role: "manager", status: "active" });
    expect(out).not.toHaveProperty("passwordHash");
    expect(authService.setRoleClaim).toHaveBeenCalledWith("u-admin", "manager");
    expect((repo.writeAudit as jest.Mock).mock.calls[0][0].details).toMatchObject({ role: { from: "admin", to: "manager" } });
    expect(repo.updateCredential).not.toHaveBeenCalled();
  });

  it("password reset routes to updateCredential (never updateUserProfile) as a verifiable hash", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue({ ...existingAdmin, role: "staff" });
    await handleUpdateStaff(withData(asRole("admin"), { uid: "u-admin", password: "brandnew1" }));

    const profilePatch = (repo.updateUserProfile as jest.Mock).mock.calls[0][1];
    expect(profilePatch).not.toHaveProperty("passwordHash");

    expect(repo.updateCredential).toHaveBeenCalledTimes(1);
    const [uid, credPatch] = (repo.updateCredential as jest.Mock).mock.calls[0];
    expect(uid).toBe("u-admin");
    expect(checkPasswordHash(credPatch.passwordHash, "brandnew1")).toBe(true);
  });

  it("rejects a short password and an invalid status", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue({ ...existingAdmin, role: "staff" });
    await expect(handleUpdateStaff(withData(asRole("admin"), { uid: "u-admin", password: "abc" }))).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(handleUpdateStaff(withData(asRole("admin"), { uid: "u-admin", status: "banished" }))).rejects.toMatchObject({ code: "invalid-argument" });
    expect(repo.updateCredential).not.toHaveBeenCalled();
  });

  it("404s an unknown uid", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue(null);
    await expect(handleUpdateStaff(withData(asRole("admin"), { uid: "nope" }))).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("deactivateStaff", () => {
  it("you cannot deactivate yourself", async () => {
    await expect(
      handleDeactivateStaff(withData(asRole("admin", "self"), { uid: "self" })),
    ).rejects.toMatchObject({ code: "failed-precondition", message: "You cannot remove your own account" });
  });

  it("blocks removing the last active admin", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue({ uid: "other-admin", username: "a2", role: "admin", status: "active", fullName: "", phone: "", usernameLower: "a2" });
    (repo.countActiveAdmins as jest.Mock).mockResolvedValue(0);
    await expect(
      handleDeactivateStaff(withData(asRole("admin", "me"), { uid: "other-admin" })),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("soft-deletes + disables the auth user + audits (credential left intact)", async () => {
    (repo.getUserByUid as jest.Mock).mockResolvedValue({ uid: "victim", username: "v", role: "staff", status: "active", fullName: "", phone: "", usernameLower: "v" });
    const out = await handleDeactivateStaff(withData(asRole("admin", "me"), { uid: "victim" }));
    expect(out).toEqual({ message: "Staff account deactivated" });
    expect(repo.updateUserProfile).toHaveBeenCalledWith("victim", { status: "inactive" });
    expect(authService.setDisabled).toHaveBeenCalledWith("victim", true);
    expect(repo.updateCredential).not.toHaveBeenCalled();
    expect((repo.writeAudit as jest.Mock).mock.calls[0][0]).toMatchObject({ action: "staff.deactivate" });
  });

  it("non-admins are rejected", async () => {
    await expect(handleDeactivateStaff(withData(asRole("manager"), { uid: "x" }))).rejects.toMatchObject({ code: "permission-denied" });
  });
});
