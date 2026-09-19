/**
 * GET /api/reports/export — replaces Flask export_report (admin/manager).
 * Auth: `Authorization: Bearer <Firebase ID token>` with an admin|manager claim.
 * Streams text/csv with the exact Flask column set. Audited as report.export.
 */
import { onRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { REGION, RESTAURANT_TZ, EXPORT_MAX_ROWS } from "../lib/config";
import { db as getDb } from "../lib/adminSdk";
import { writeAudit } from "../lib/audit";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection. Customer names come straight
  // from the till exactly as typed; Excel and Sheets execute a cell that
  // begins with =, +, - or @, so a "customer" named =HYPERLINK(...) turns the
  // owner's own sales report into a live attack the moment they open it. A
  // leading apostrophe keeps the text readable and inert.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function localStamp(d: Date): string {
  // YYYY-MM-DD HH:MM:SS in the restaurant timezone (matches Flask's stored strings)
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: RESTAURANT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

export const exportReport = onRequest({ region: REGION, cors: true }, async (req, res) => {
  const m = String(req.header("authorization") || "").match(/^Bearer (.+)$/i);
  if (!m) {
    res.status(401).json({ success: false, error: "Unauthorized. Please log in." });
    return;
  }
  let claims: any;
  try {
    claims = await getAuth().verifyIdToken(m[1]);
  } catch {
    res.status(401).json({ success: false, error: "Unauthorized. Please log in." });
    return;
  }
  if (!["admin", "manager"].includes(String(claims.role))) {
    res.status(403).json({ success: false, error: "You do not have permission to perform this action." });
    return;
  }

  const type = String(req.query.type || "all").toLowerCase();
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!["food", "alcohol", "all"].includes(type)) {
    res.status(400).json({ success: false, error: "type must be food, alcohol or all" });
    return;
  }
  if (from && !DATE_RE.test(from)) {
    res.status(400).json({ success: false, error: "from must be YYYY-MM-DD" });
    return;
  }
  if (to && !DATE_RE.test(to)) {
    res.status(400).json({ success: false, error: "to must be YYYY-MM-DD" });
    return;
  }

  const db = getDb();
  let q: FirebaseFirestore.Query = db.collection("bills");
  if (type !== "all") q = q.where("type", "==", type.toUpperCase());
  if (from) q = q.where("dateKey", ">=", from);
  if (to) q = q.where("dateKey", "<=", to);
  q = q.orderBy("dateKey");
  // Bounded on purpose: the whole CSV is assembled in memory, so an unbounded
  // "export everything" grows with every day the restaurant trades until it
  // exhausts the function's memory. Reading one row past the limit is how we
  // tell "exactly at the limit" from "too many".
  const snap = await q.limit(EXPORT_MAX_ROWS + 1).get();
  if (snap.size > EXPORT_MAX_ROWS) {
    res.status(413).json({
      success: false,
      error: `That range covers more than ${EXPORT_MAX_ROWS} bills. Please export a shorter date range.`,
    });
    return;
  }

  const rows = snap.docs
    .map((d) => d.data() as any)
    .sort((a, b) => {
      const ta = (a.createdAt?.toDate?.() ?? a.createdAt ?? new Date(0)).getTime();
      const tb = (b.createdAt?.toDate?.() ?? b.createdAt ?? new Date(0)).getTime();
      return ta - tb;
    });

  const header = [
    "Type", "Bill No", "Date", "Customer", "Phone",
    "Subtotal", "Discount", "Tax", "Grand Total", "Payment Method", "Status",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const created = r.createdAt?.toDate?.() ?? r.createdAt ?? new Date(0);
    lines.push(
      [
        r.type,
        r.billNo,
        localStamp(created),
        r.customerName,
        r.customerPhone,
        r.subtotal,
        r.discount,
        r.tax,
        r.grandTotal,
        r.paymentMethod,
        r.status,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  const stamp = localStamp(new Date()).replace(/[- :]/g, "").slice(0, 15);
  await writeAudit({
    actorUid: claims.uid,
    actorUsername: claims.username || claims.name || null,
    actorRole: claims.role,
    action: "report.export",
    entityType: "bills",
    entityId: null,
    details: { type, from, to, rows: rows.length },
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="sales-report-${type}-${stamp}.csv"`);
  res.status(200).send(lines.join("\r\n"));
});
