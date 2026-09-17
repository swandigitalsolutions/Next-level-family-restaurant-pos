/* Verifies the client route-gating logic (hosting/js/page-gate.js). 6 roles. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pageGate } = require("../../hosting/js/page-gate.js") as {
  pageGate: (role: string | null, page: string) => { action: string; to?: string };
};

const allow = { action: "allow" };
const toDash = { action: "redirect", to: "dashboard.html" };
const toLogin = { action: "redirect", to: "login.html" };
const toKitchen = { action: "redirect", to: "kitchen.html" };
const toCafe = { action: "redirect", to: "cafe-billing.html" };

describe("pageGate — 6-role route gating (admin, owner, manager, billing, kitchen, cafe_billing)", () => {
  it("not signed in -> login (except the login page itself)", () => {
    expect(pageGate(null, "dashboard.html")).toEqual(toLogin);
    expect(pageGate(null, "billing.html")).toEqual(toLogin);
    expect(pageGate(null, "login.html")).toEqual(allow);
    expect(pageGate(undefined as unknown as null, "orders.html")).toEqual(toLogin);
  });

  it("signed-in user is bounced off the login page to their home", () => {
    for (const r of ["admin", "manager", "billing", "owner"]) {
      expect(pageGate(r, "login.html")).toEqual(toDash);
    }
    expect(pageGate("kitchen", "login.html")).toEqual(toKitchen);
    expect(pageGate("cafe", "login.html")).toEqual(toCafe);
  });

  it("owner sees the dashboard and the logs only", () => {
    expect(pageGate("owner", "dashboard.html")).toEqual(allow);
    expect(pageGate("owner", "audit.html")).toEqual(allow);
    for (const p of ["billing.html", "orders.html", "menu.html", "staff.html", "qr-orders.html", "qr-tables.html", "cafe-billing.html", "kitchen.html"]) {
      expect(pageGate("owner", p)).toEqual(toDash);
    }
  });

  it("kitchen role sees only the kitchen screen", () => {
    expect(pageGate("kitchen", "kitchen.html")).toEqual(allow);
    for (const p of ["dashboard.html", "billing.html", "orders.html", "cafe-billing.html", "staff.html"]) {
      expect(pageGate("kitchen", p)).toEqual(toKitchen);
    }
  });

  it("cafe_billing role sees only the cafe billing page", () => {
    expect(pageGate("cafe_billing", "cafe-billing.html")).toEqual(allow);
    for (const p of ["dashboard.html", "billing.html", "kitchen.html", "menu.html"]) {
      expect(pageGate("cafe_billing", p)).toEqual(toCafe);
    }
  });

  it("staff.html is admin-only; audit.html is admin + owner ONLY (manager excluded)", () => {
    for (const r of ["manager", "billing"]) {
      expect(pageGate(r, "staff.html")).toEqual(toDash);
    }
    expect(pageGate("billing", "audit.html")).toEqual(toDash);
    expect(pageGate("manager", "audit.html")).toEqual(toDash); // manager has NO audit access
    expect(pageGate("owner", "audit.html")).toEqual(allow);
    expect(pageGate("admin", "staff.html")).toEqual(allow);
    expect(pageGate("admin", "audit.html")).toEqual(allow);
  });

  it("cleanUrls: extensionless page names resolve the same as *.html (no redirect loop)", () => {
    expect(pageGate(null, "login")).toEqual(allow); // was: redirect(login.html) -> loop
    expect(pageGate("admin", "login")).toEqual(toDash);
    expect(pageGate("billing", "dashboard")).toEqual(allow);
    expect(pageGate("billing", "menu")).toEqual(toDash);
    expect(pageGate("kitchen", "dashboard")).toEqual(toKitchen);
    expect(pageGate("owner", "audit")).toEqual(allow);
    expect(pageGate(null, "orders")).toEqual(toLogin);
  });

  it("legacy aliases: 'staff'->billing, 'cafe'->cafe_billing", () => {
    expect(pageGate("staff", "menu.html")).toEqual(toDash);
    expect(pageGate("staff", "billing.html")).toEqual(allow);
    expect(pageGate("staff", "qr-orders.html")).toEqual(allow);
    expect(pageGate("staff", "dashboard.html")).toEqual(allow);
    expect(pageGate("cafe", "cafe-billing.html")).toEqual(allow);
    expect(pageGate("cafe", "billing.html")).toEqual(toCafe);
  });

  it("billing cashier: blocked from menu.html + qr-tables.html + kitchen/cafe", () => {
    expect(pageGate("billing", "menu.html")).toEqual(toDash);
    expect(pageGate("billing", "qr-tables.html")).toEqual(toDash);
    expect(pageGate("billing", "kitchen.html")).toEqual(toDash);
    expect(pageGate("billing", "cafe-billing.html")).toEqual(toDash);
    expect(pageGate("billing", "billing.html")).toEqual(allow);
    expect(pageGate("billing", "alcohol-billing.html")).toEqual(allow);
    expect(pageGate("billing", "orders.html")).toEqual(allow);
    expect(pageGate("billing", "qr-orders.html")).toEqual(allow);
    expect(pageGate("billing", "website-orders.html")).toEqual(allow);
    expect(pageGate("billing", "dashboard.html")).toEqual(allow);
  });

  it("manager reaches catalog + qr-tables + kitchen + cafe, but not staff.html", () => {
    expect(pageGate("manager", "menu.html")).toEqual(allow);
    expect(pageGate("manager", "qr-tables.html")).toEqual(allow);
    expect(pageGate("manager", "billing.html")).toEqual(allow);
    expect(pageGate("manager", "kitchen.html")).toEqual(allow);
    expect(pageGate("manager", "cafe-billing.html")).toEqual(allow);
    expect(pageGate("manager", "staff.html")).toEqual(toDash);
  });

  it("admin can reach everything", () => {
    for (const p of ["dashboard.html", "billing.html", "alcohol-billing.html", "cafe-billing.html", "orders.html", "menu.html", "staff.html", "audit.html", "qr-tables.html", "qr-orders.html", "kitchen.html", "website-orders.html"]) {
      expect(pageGate("admin", p)).toEqual(allow);
    }
  });
});
