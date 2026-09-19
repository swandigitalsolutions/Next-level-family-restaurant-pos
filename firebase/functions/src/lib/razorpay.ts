/**
 * Razorpay integration for the website pre-order flow (Phase 4b, revised to the
 * website team's contract). The POS owns order creation with the provider AND
 * the webhook verification — the Website project never touches payments.
 *
 * PAYMENT_PROVIDER=razorpay  -> real API (RAZORPAY_KEY_ID / _KEY_SECRET / _WEBHOOK_SECRET)
 * PAYMENT_PROVIDER=mock      -> emulator/tests: deterministic providerOrderId,
 *                              webhook signature = HMAC-SHA256(body, _WEBHOOK_SECRET)
 *
 * SAFETY: the mock provider is FAIL-CLOSED in production. It only runs inside the
 * Functions emulator, or when ALLOW_MOCK_PAYMENTS=true is explicitly set. A
 * deployed function with PAYMENT_PROVIDER unset/mock and no opt-in throws rather
 * than silently issuing fake Razorpay orders.
 */
import * as crypto from "crypto";

export const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || "mock").toLowerCase();
const KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_mock";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

const IN_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
const MOCK_ALLOWED = IN_EMULATOR || process.env.ALLOW_MOCK_PAYMENTS === "true";

export interface ProviderOrder {
  provider: "razorpay";
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
}

export async function createProviderOrder(
  amountPaise: number,
  receipt: string,
): Promise<ProviderOrder> {
  if (PAYMENT_PROVIDER === "mock") {
    if (!MOCK_ALLOWED) {
      throw new Error(
        "PAYMENT_PROVIDER is not set to 'razorpay' in a deployed environment. " +
          "Set PAYMENT_PROVIDER=razorpay + RAZORPAY_KEY_ID/_KEY_SECRET/_WEBHOOK_SECRET, " +
          "or ALLOW_MOCK_PAYMENTS=true to intentionally use the mock.",
      );
    }
    return {
      provider: "razorpay",
      providerOrderId: `order_mock_${crypto.randomBytes(8).toString("hex")}`,
      keyId: KEY_ID,
      amountPaise,
    };
  }
  // real Razorpay Orders API
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt, payment_capture: 1 }),
  });
  if (!res.ok) {
    throw new Error(`Razorpay order create failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { provider: "razorpay", providerOrderId: body.id, keyId: KEY_ID, amountPaise };
}

/** Verify the X-Razorpay-Signature header against the RAW request body. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(String(signature), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Helper for the mock provider / the Website team's test harness. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}
