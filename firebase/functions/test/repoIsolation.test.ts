/**
 * Proves the data-access layer keeps credential material out of the
 * client-readable `users` collection and out of every value returned to callers.
 * The real repo functions run against a spying Firestore fake.
 */
const writes: Array<{ col: string; id?: string; data?: any; add?: any; opts?: any }> = [];

const leakyUserDoc = {
  id: "u1",
  data: () => ({
    username: "admin",
    usernameLower: "admin",
    fullName: "Administrator",
    phone: "1",
    role: "admin",
    status: "active",
    // A stray hash in the profile doc MUST NOT survive the mapping layer.
    passwordHash: "scrypt:32768:8:1$leak$deadbeef",
    secretNote: "should not be exposed either",
  }),
};

function makeCollection(col: string) {
  const emptyQuery = {
    where: () => emptyQuery,
    limit: () => emptyQuery,
    orderBy: () => ({ get: async () => ({ docs: [leakyUserDoc] }) }),
    get: async () => ({ empty: true, docs: [] }),
  };
  return {
    doc: (id: string) => ({
      set: async (data: any, opts: any) => {
        writes.push({ col, id, data, opts });
      },
      get: async () => ({ exists: false, data: () => undefined }),
      delete: async () => {
        writes.push({ col, id, data: "<delete>" });
      },
    }),
    where: () => emptyQuery,
    orderBy: () => emptyQuery.orderBy(),
    add: async (data: any) => {
      writes.push({ col, add: data });
      return { id: "generated" };
    },
  };
}

jest.mock("../src/lib/adminSdk", () => ({
  db: () => ({ collection: (c: string) => makeCollection(c) }),
  FieldValue: { serverTimestamp: () => "SERVER_TS", increment: (n: number) => ({ __inc: n }) },
  Timestamp: class {},
}));

import {
  createUserProfile,
  updateUserProfile,
  writeCredential,
  updateCredential,
  listUserProfiles,
} from "../src/lib/repo";

beforeEach(() => {
  writes.length = 0;
});

describe("repo credential isolation", () => {
  it("createUserProfile writes to `users` with NO passwordHash", async () => {
    await createUserProfile({
      uid: "u1",
      username: "cash",
      usernameLower: "cash",
      fullName: "Cash",
      phone: "9",
      role: "billing",
      status: "active",
    });
    const w = writes.find((x) => x.col === "users");
    expect(w).toBeTruthy();
    expect(w!.id).toBe("u1");
    expect(w!.data).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(w!.data)).not.toMatch(/scrypt:|pbkdf2:/);
    expect(writes.some((x) => x.col === "userCredentials")).toBe(false);
  });

  it("updateUserProfile merge patch never carries a hash", async () => {
    await updateUserProfile("u1", { fullName: "New", role: "manager", status: "active" });
    const w = writes.find((x) => x.col === "users");
    expect(w!.data).not.toHaveProperty("passwordHash");
    expect(w!.opts).toEqual({ merge: true });
  });

  it("writeCredential / updateCredential target `userCredentials` only", async () => {
    await writeCredential("u1", "scrypt:32768:8:1$s$h", "cash");
    await updateCredential("u1", { passwordHash: "pbkdf2:sha256:600000$s$h" });
    const creds = writes.filter((x) => x.col === "userCredentials");
    expect(creds).toHaveLength(2);
    expect(creds.every((c) => c.id === "u1")).toBe(true);
    expect(writes.some((x) => x.col === "users")).toBe(false);
  });

  it("listUserProfiles strips passwordHash (and any unknown field) via the allowlist mapping", async () => {
    const out = await listUserProfiles();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      uid: "u1",
      username: "admin",
      usernameLower: "admin",
      fullName: "Administrator",
      phone: "1",
      role: "admin",
      status: "active",
      createdAt: undefined,
    });
    expect(out[0]).not.toHaveProperty("passwordHash");
    expect(out[0]).not.toHaveProperty("secretNote");
    expect(JSON.stringify(out)).not.toMatch(/scrypt:|pbkdf2:|deadbeef/);
  });
});
