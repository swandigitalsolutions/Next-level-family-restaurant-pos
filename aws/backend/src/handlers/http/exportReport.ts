/**
 * GET /api/reports/export — Lambda port of
 * firebase/functions/src/http/exportReport.ts. Auth: `Authorization: Bearer
 * <Cognito ID token>` with an admin|manager role claim, verified directly
 * here (this route is NOT behind the API Gateway Cognito authorizer in
 * api-stack.ts because it needs to render its own CSV error body instead of
 * the authorizer's generic 401 JSON — matches the Firebase version's own
 * inline `verifyIdToken` call). Streams text/csv with the exact original
 * column set. Audited as report.export.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { getPool } from "../../lib/db";
import { writeAudit } from "../../lib/audit";
import { RESTAURANT_TZ, normalizeRole, EXPORT_MAX_ROWS } from "../../lib/config";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Neutralise spreadsheet formula injection. Customer names arrive from the
  // till exactly as typed; Excel and Sheets execute a cell that starts with
  // =, +, - or @, so a "customer" named =HYPERLINK(...) turns the owner's own
  // sales report into a live attack the moment they open it. A leading
  // apostrophe keeps the text readable and inert.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function localStamp(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: RESTAURANT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
function getVerifier() {
  return (verifier ??= CognitoJwtVerifier.create({ userPoolId: process.env.COGNITO_USER_POOL_ID!, tokenUse: "id", clientId: process.env.COGNITO_CLIENT_ID! }));
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const m = String(event.headers?.authorization || "").match(/^Bearer (.+)$/i);
  const json = (status: number, body: unknown) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!m) return json(401, { success: false, error: "Unauthorized. Please log in." });

  let claims: any;
  try {
    claims = await getVerifier().verify(m[1]);
  } catch {
    return json(401, { success: false, error: "Unauthorized. Please log in." });
  }
  const role = normalizeRole(claims["custom:role"]);
  if (!["admin", "manager"].includes(role)) return json(403, { success: false, error: "You do not have permission to perform this action." });

  const qs = event.queryStringParameters || {};
  const type = String(qs.type || "all").toLowerCase();
  const from = String(qs.from || "");
  const to = String(qs.to || "");
  if (!["food", "alcohol", "all"].includes(type)) return json(400, { success: false, error: "type must be food, alcohol or all" });
  if (from && !DATE_RE.test(from)) return json(400, { success: false, error: "from must be YYYY-MM-DD" });
  if (to && !DATE_RE.test(to)) return json(400, { success: false, error: "to must be YYYY-MM-DD" });

  const pool = await getPool();
  const where: string[] = []; const params: unknown[] = [];
  if (type !== "all") { params.push(type.toUpperCase()); where.push(`type = $${params.length}`); }
  if (from) { params.push(from); where.push(`date_key >= $${params.length}`); }
  if (to) { params.push(to); where.push(`date_key <= $${params.length}`); }
  // Bounded on purpose: the whole CSV is assembled in memory and API Gateway
  // hard-caps a Lambda response at 6MB, so an unbounded "export everything"
  // eventually fails with an opaque platform error. Fetching one row beyond
  // the limit is how we tell "exactly at the limit" from "too many".
  params.push(EXPORT_MAX_ROWS + 1);
  const sql = `SELECT * FROM bills ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date_key, created_at LIMIT $${params.length}`;
  const rows = (await pool.query(sql, params)).rows;
  if (rows.length > EXPORT_MAX_ROWS) {
    return json(413, {
      success: false,
      error: `That range covers more than ${EXPORT_MAX_ROWS} bills. Please export a shorter date range.`,
    });
  }

  const header = ["Type", "Bill No", "Date", "Customer", "Phone", "Subtotal", "Discount", "Tax", "Grand Total", "Payment Method", "Status"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([r.type, r.bill_no, localStamp(new Date(r.created_at)), r.customer_name, r.customer_phone, r.subtotal, r.discount, r.tax, r.grand_total, r.payment_method, r.status].map(csvCell).join(","));
  }

  const stamp = localStamp(new Date()).replace(/[- :]/g, "").slice(0, 15);
  await writeAudit({ actorUid: claims["custom:pos_uid"] || claims.sub, actorUsername: claims["cognito:username"] || null, actorRole: role, action: "report.export", entityType: "bills", entityId: null, details: { type, from, to, rows: rows.length } });

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="sales-report-${type}-${stamp}.csv"` },
    body: lines.join("\r\n"),
  };
};
