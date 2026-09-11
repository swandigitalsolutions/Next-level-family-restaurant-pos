import "./_env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRole, assertSignedIn, HttpError } from "../src/lib/authz";
import { VALID_ROLES, MANAGE_ROLES, BILLING_ROLES, CAFE_ROLES, KITCHEN_ROLES, AUDIT_ROLES } from "../src/lib/config";
import { fakeEvent } from "./_helpers";

// Pure authorization-logic matrix — no DB needed. Every handler's assertRole/
// assertManager/etc. call is a thin wrapper over exactly this function, so
// this table is the single source of truth for "does role X reach surface Y"
// across all 20 Lambda handlers.

test("unauthenticated (no JWT claims) is always rejected", () => {
  assert.throws(() => assertSignedIn(fakeEvent({}) as any), HttpError);
});

test("unrecognized role claim is rejected (fails closed)", () => {
  assert.throws(() => assertSignedIn(fakeEvent({ role: "not_a_real_role" }) as any), HttpError);
});

const matrix: Array<[string, readonly string[]]> = [
  ["MANAGE_ROLES (catalog/tables CRUD)", MANAGE_ROLES],
  ["BILLING_ROLES (food/alcohol billing, QR/website boards)", BILLING_ROLES],
  ["CAFE_ROLES (outside cafe till)", CAFE_ROLES],
  ["KITCHEN_ROLES (kitchen screen)", KITCHEN_ROLES],
  ["AUDIT_ROLES (audit log — admin+owner ONLY, manager excluded)", AUDIT_ROLES],
];

for (const [label, allowed] of matrix) {
  test(`${label}: every allowed role passes, every other role is denied`, () => {
    for (const role of VALID_ROLES) {
      const event = fakeEvent({ role }) as any;
      if (allowed.includes(role)) {
        assert.doesNotThrow(() => assertRole(event, allowed as any), `${role} should be allowed`);
      } else {
        assert.throws(() => assertRole(event, allowed as any), HttpError, `${role} should be denied`);
      }
    }
  });
}

test("owner is excluded from every operational surface (view-only dashboard + audit)", () => {
  for (const roles of [MANAGE_ROLES, BILLING_ROLES, CAFE_ROLES, KITCHEN_ROLES]) {
    assert.ok(!roles.includes("owner" as any), "owner must never appear in an operational role list");
  }
});

test("manager is excluded from audit (deliberate: manager has no audit access)", () => {
  assert.ok(!AUDIT_ROLES.includes("manager" as any));
});

test("legacy role aliases normalize correctly at the claim boundary", () => {
  const staffEvent = fakeEvent({ role: "staff" }) as any; // normalizeRole maps this in config.ts
  // fakeEvent sets custom:role verbatim; assertRole calls normalizeRole internally via roleOf()
  assert.doesNotThrow(() => assertRole(staffEvent, BILLING_ROLES as any));
  const cafeEvent = fakeEvent({ role: "cafe" }) as any;
  assert.doesNotThrow(() => assertRole(cafeEvent, CAFE_ROLES as any));
});
