/**
 * Exercises the REAL onCall wrappers (auth-context parsing, HttpsError
 * marshalling) via firebase-functions-test in offline mode — no emulator, no
 * credentials. repo + authService are still mocked so nothing touches Firestore.
 */
jest.mock("../src/lib/authService", () => ({
  setRoleClaim: jest.fn(async () => undefined),
  mintCustomToken: jest.fn(async (uid: string) => `tok-${uid}`),
  createAuthUser: jest.fn(async () => ({ uid: "created-uid" })),
  setDisabled: jest.fn(async () => undefined),
}));
const throttle = new Map<string, { count: number; lockedAt: number }>();
jest.mock("../src/lib/repo", () => ({
  findCredentialByUsername: jest.fn(async () => null),
  getUserByUid: jest.fn(async () => null),
  usernameTaken: jest.fn(async () => false),
  countActiveAdmins: jest.fn(async () => 2),
  listUserProfiles: jest.fn(async () => []),
  createUserProfile: jest.fn(async () => undefined),
  updateUserProfile: jest.fn(async () => undefined),
  writeCredential: jest.fn(async () => undefined),
  updateCredential: jest.fn(async () => undefined),
  writeAudit: jest.fn(async () => undefined),
  throttleGet: jest.fn(async (k: string) => throttle.get(k) ?? null),
  throttleBump: jest.fn(async (k: string) => {
    const e = throttle.get(k) ?? { count: 0, lockedAt: 0 };
    throttle.set(k, { count: e.count + 1, lockedAt: Date.now() });
  }),
  throttleClear: jest.fn(async (k: string) => void throttle.delete(k)),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fft = require("firebase-functions-test")();
import { loginWithPassword } from "../src/callable/loginWithPassword";
import { createStaff } from "../src/callable/staffAdmin";

afterAll(() => fft.cleanup());
beforeEach(() => throttle.clear());

describe("onCall wrappers (real dispatch path)", () => {
  it("loginWithPassword surfaces a clean HttpsError for a bad login", async () => {
    const wrapped = fft.wrap(loginWithPassword);
    await expect(
      wrapped({ data: { username: "ghost", password: "x" }, rawRequest: { headers: {}, ip: "1.1.1.1" } }),
    ).rejects.toMatchObject({ code: "unauthenticated", message: "Invalid username or password" });
  });

  it("createStaff rejects an unauthenticated caller through the wrapper", async () => {
    const wrapped = fft.wrap(createStaff);
    await expect(
      wrapped({ data: { username: "abc", password: "secret1", full_name: "A" } }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("createStaff rejects a non-admin claim through the wrapper", async () => {
    const wrapped = fft.wrap(createStaff);
    await expect(
      wrapped({
        data: { username: "abc", password: "secret1", full_name: "A" },
        auth: { uid: "u1", token: { role: "manager" } },
      }),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});
