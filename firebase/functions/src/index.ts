/**
 * Cloud Functions entrypoint — Next Level Family Restaurant POS.
 *
 * Phase 1: infrastructure.  Phase 2: authentication.
 * Phase 4: billing / settlement / QR / catalog / tables / reports / rollups /
 *          website menu — a full port of backend/app.py.
 * Reads (menus, orders list, bill view, dashboard) are direct Firestore queries
 * from the client (Phase 5), governed by firestore.rules.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "./lib/config";

if (getApps().length === 0) {
  initializeApp();
}
setGlobalOptions({ region: REGION, maxInstances: 10 });

/** Liveness probe (mirrors Flask GET /api/health / /healthz). */
export const healthCheck = onRequest((_req, res) => {
  res.status(200).json({ status: "ok", phase: 4, time: new Date().toISOString() });
});

// ---- Phase 2: authentication ----------------------------------------------
export { loginWithPassword } from "./callable/loginWithPassword";
export {
  listStaff,
  createStaff,
  updateStaff,
  deactivateStaff,
} from "./callable/staffAdmin";

// ---- Phase 4: billing + table sessions -----------------------------------
export { createBill, openTable, settleTable } from "./callable/billing";

// ---- Phase 4: catalog + categories -------------------------------------
export {
  upsertCategory,
  deleteCategory,
  upsertCatalogItem,
  deleteCatalogItem,
} from "./callable/catalogAdmin";

// ---- Phase 4: dining tables + QR tokens -------------------------------
export { createTable, updateTable, regenerateQrToken } from "./callable/tablesAdmin";

// ---- Phase 4: staff-side QR order ops --------------------------------
export { setQrOrderStatus, pushQrOrderToBill } from "./callable/qrOrdersAdmin";

// ---- Phase 7: kitchen screen ---------------------------------------
export { acceptOrderToKitchen, setKitchenTicketStatus } from "./callable/kitchen";

// ---- Phase 4: HTTP endpoints ---------------------------------------
export { websiteMenu } from "./http/websiteMenu";
export { qrApi } from "./http/qrApi";
export { exportReport } from "./http/exportReport";

// ---- Phase 4b: Website pre-order channel + Razorpay ----------------
export { websiteApi } from "./http/websiteApi";
export { razorpayWebhook } from "./http/paymentWebhook";
export {
  setWebsiteOrderStatus,
  addItemsToWebsiteOrder,
  settleWebsiteOrder,
} from "./callable/websiteOrdersAdmin";

// ---- Phase 4: dashboard rollups ---------------------------------
export { onBillWrite, rebuildStats } from "./triggers/stats";
