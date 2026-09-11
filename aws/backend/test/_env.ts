/**
 * Test bootstrap: points every handler's lib/db.ts at the disposable local
 * Postgres cluster (see aws/docs/TESTING.md for how it's started) instead of
 * Secrets Manager. Imported first (side-effect only) by every test file.
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres@localhost:55432/posdb";
process.env.RESTAURANT_TZ = "Asia/Kolkata";
process.env.PAYMENT_PROVIDER = "mock";
process.env.ALLOW_MOCK_PAYMENTS = "true";
process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
process.env.WEBSITE_API_KEYS = "test-website-key";
process.env.FUNCTIONS_EMULATOR = "true";
