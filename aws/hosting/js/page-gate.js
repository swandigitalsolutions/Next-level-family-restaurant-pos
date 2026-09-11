/*
 * page-gate.js — pure client-side route gating.
 *
 * pageGate(role, page) -> { action: "allow" }
 *                       | { action: "redirect", to: "<file>.html" }
 *
 * 6 roles: "admin" | "manager" | "owner" | "billing" | "kitchen" | "cafe_billing"
 *          (plus null/undefined = not signed in). Legacy aliases accepted:
 *          "staff" -> "billing", "cafe" -> "cafe_billing".
 *
 *   admin        — every page
 *   manager      — every page except staff.html AND audit.html
 *   owner        — dashboard.html + audit.html only (view dashboard + logs)
 *   billing      — cashier: dashboard, food/alcohol billing, orders, live QR
 *                  orders, website orders. NOT menu.html / qr-tables.html /
 *                  staff.html / audit.html / kitchen.html / cafe-billing.html
 *   kitchen      — kitchen.html only
 *   cafe_billing — cafe-billing.html only
 *
 * UMD: usable as a <script> global (window.PageGate) and via require() in tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PageGate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var BILLING_BLOCKED_PAGES = ["menu.html", "qr-tables.html"];
  var ADMIN_ONLY_PAGES = ["staff.html"];
  var AUDIT_ROLES = ["admin", "owner"]; // manager is deliberately excluded

  // The page each role lands on after login / when redirected off a denied page.
  var HOME = {
    admin: "dashboard.html",
    manager: "dashboard.html",
    owner: "dashboard.html",
    billing: "dashboard.html",
    kitchen: "kitchen.html",
    cafe_billing: "cafe-billing.html",
  };

  function norm(role) {
    var r = String(role || "").toLowerCase();
    if (r === "staff") return "billing";
    if (r === "cafe") return "cafe_billing";
    return r;
  }
  function redirect(to) {
    return { action: "redirect", to: to };
  }
  function home(role) {
    return HOME[role] || "dashboard.html";
  }

  function pageGate(role, page) {
    // cleanUrls serves "/pages/login" (no extension). Normalise so every
    // `p === "x.html"` comparison below still works.
    var p = String(page || "");
    if (p && p.indexOf(".") === -1) p += ".html";
    var r = norm(role);

    // an already-authenticated user never sits on the login screen
    if (p === "login.html") {
      return r ? redirect(home(r)) : { action: "allow" };
    }
    // no session -> back to login
    if (!r) return redirect("login.html");

    // single-page roles
    if (r === "kitchen") return p === "kitchen.html" ? { action: "allow" } : redirect("kitchen.html");
    if (r === "cafe_billing") return p === "cafe-billing.html" ? { action: "allow" } : redirect("cafe-billing.html");
    if (r === "owner") {
      return p === "dashboard.html" || p === "audit.html" ? { action: "allow" } : redirect("dashboard.html");
    }

    // staff.html — admin only
    if (ADMIN_ONLY_PAGES.indexOf(p) !== -1 && r !== "admin") {
      return redirect(home(r));
    }
    // audit.html — admin / manager / owner
    if (p === "audit.html" && AUDIT_ROLES.indexOf(r) === -1) {
      return redirect(home(r));
    }
    // kitchen / cafe screens — only their own role (or admin/manager)
    if (p === "kitchen.html" && ["admin", "manager"].indexOf(r) === -1) return redirect(home(r));
    if (p === "cafe-billing.html" && ["admin", "manager"].indexOf(r) === -1) return redirect(home(r));

    // billing cashier cannot reach catalog / QR-table management
    if (r === "billing" && BILLING_BLOCKED_PAGES.indexOf(p) !== -1) {
      return redirect("dashboard.html");
    }

    return { action: "allow" };
  }

  return {
    pageGate: pageGate,
    BILLING_BLOCKED_PAGES: BILLING_BLOCKED_PAGES,
    ADMIN_ONLY_PAGES: ADMIN_ONLY_PAGES,
    // legacy export name kept for any old import
    STAFF_BLOCKED_PAGES: BILLING_BLOCKED_PAGES,
  };
});
