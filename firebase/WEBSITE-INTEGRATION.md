# Website ↔ POS integration contract

**Answer to: "Website online pre-ordering — backend contract needed."**

## 0. Stack

**Firebase.** Hosting + Cloud Functions (v2, region `asia-south1`, Node 20) +
Firestore. There is no Flask/Supabase anymore. Consequences for you:

- The realtime "Website Order Received" staff notification is a Firestore
  `onSnapshot` listener inside the POS app — **you do nothing** for it.
- Payment verification is a **Razorpay webhook that Razorpay calls on the POS**
  (`POST /api/razorpay/webhook`). The Website has **no webhook** and never
  verifies payments.

This Firebase project is the **single source of truth** for menu, prices,
availability, the Order ID, every amount, and billing. The Website never touches
Firestore and never sees staff auth. It calls the HTTP endpoints below
server-to-server with a shared **`X-API-Key`**.

Base URL: `https://<project>.web.app` (local emulator `http://127.0.0.1:5000`).
CORS is **closed** on every endpoint — server-to-server only.

Responses are the bare JSON object shown below (no `{success,data}` envelope).
Errors are `{ "error": "message" }` with a `4xx`/`5xx` status.

---

## The flow

```
POS Catalog ──► GET /api/website/menu ──► your cart / checkout UI
     │
     ▼
POST /api/website/orders   (items + customer only — NO amounts)
     │  server re-prices from the live catalog, mints WEB-000123,
     │  creates the order PENDING_PAYMENT / UNPAID,
     │  creates a Razorpay order for the 50% advance
     ▼
{ ref:"WEB-000123", …, payment:{ providerOrderId, keyId, amountPaise } }
     │
     ▼  open Razorpay Checkout in the browser with providerOrderId + keyId
Customer pays the advance
     │
     ▼  Razorpay ──► POST /api/razorpay/webhook (POS)
POS verifies signature + amount == advancePaise
     │  paymentStatus → ADVANCE_PAID, status → CONFIRMED, confirmedAt set
     │  → order appears on POS "Website Orders" board
     │  → realtime "Website Order Received" chime + popup fires for staff
     ▼
GET /api/website/orders/WEB-000123   (poll every 8s until status == "CONFIRMED")
     │
     ▼
POS: staff find WEB-000123 → Add Items if needed → Settle Bill
     → immutable POS bill(s) that keep WEB-000123 as their reference
```

`WEB-000123` is generated **only** inside the `POST /orders` transaction from a
gap-safe counter (`counters/websiteOrder`, prefix `WEB`, 6-digit zero-pad). It is
unique, collision-safe, immutable, **never client-supplied**, and is the primary
reference everywhere: the customer confirmation page, the POS board search, and
each settled bill's `websiteOrderNo` field + search tokens.

---

## 1. `GET /api/website/menu`

Auth: `X-API-Key`. Food only, `status = active`.

```json
{ "currency": "INR",
  "updatedAt": "2026-09-06T10:00:00Z",
  "categories": [
    { "id": 3, "legacyId": 3, "name": "Starters", "sortOrder": 1,
      "items": [
        { "id": 42, "legacyId": 42, "name": "Paneer Tikka",
          "description": null,
          "imageUrl": "https://…/paneer.jpg",   // string | null
          "pricePaise": 22000,
          "price": 220,                          // rupees, convenience copy
          "available": true }                    // active AND (stockQty null OR > 0)
      ] } ] }
```

`id` is an opaque stable key (numeric `legacyId` for migrated items, Firestore
string id for items created after the migration). Poll this (or cache briefly) —
catalog price / availability edits in the POS show up here automatically.

---

## 2. `POST /api/website/orders`

Auth: `X-API-Key`. **This is the only place the Website creates an order.**

**Idempotency (recommended).** Send an `Idempotency-Key` header matching
`^[A-Za-z0-9._:-]{8,128}$` (e.g. a UUID). Replaying the same key with the same
body returns the **same** WebsiteOrder — never a second `WEB-xxxxxx`, never a
second Razorpay provider order — even under concurrent delivery. Same key +
different body → `422`. A key is not consumed by a `422`/`400` (a corrected
retry with the same key works). Without the header the endpoint behaves as
before (each call is a new order).

Request — the **only** things the Website sends, no amounts ever:

```json
{ "items": [ { "id": "<menu item id>", "qty": 2 } ],
  "customer": { "name": "Asha", "phone": "9811111111", "email": "a@x.com" },
  "fulfillment": { "type": "pickup",
                   "pickupAt": "2026-09-10T12:30:00.000Z",   // ISO-8601, optional
                   "notes": "extra napkins" } }              // optional
```

The backend: re-prices every line from the live catalog; rejects unknown /
inactive / sold-out items (**`422 {error}`**, nothing created, no counter burn);
computes `subtotalPaise`, `taxPaise`, `totalPaise`,
`advancePaise = round(totalPaise / 2)`, `balancePaise = totalPaise - advancePaise`
— all integer paise; mints the Order ID; creates the order
`PENDING_PAYMENT` / `UNPAID`; creates a Razorpay order for `advancePaise`.

Response `201` — the **WebsiteOrder** object:

```json
{ "ref": "WEB-000123",
  "status": "PENDING_PAYMENT",
  "paymentStatus": "UNPAID",
  "items": [ { "id": "42", "name": "Paneer Tikka",
               "unitPricePaise": 22000, "qty": 2, "lineTotalPaise": 44000 } ],
  "subtotalPaise": 62000, "taxPaise": 3240, "totalPaise": 65240,
  "advancePaise": 32620, "balancePaise": 32620, "amountPaidPaise": 0,
  "customer": { "name": "Asha", "phone": "9811111111", "email": "a@x.com" },
  "fulfillment": { "type": "pickup", "pickupAt": "2026-09-10T12:30:00.000Z", "notes": "extra napkins" },
  "createdAt": "2026-09-06T10:00:00.000Z",
  "confirmedAt": null,
  "payment": { "provider": "razorpay",
               "amountPaise": 32620,
               "providerOrderId": "order_NXs…",   // pass to Razorpay Checkout
               "keyId": "rzp_live_…" } }          // public key for the browser
```

`422` on: empty cart, qty outside 1–50, unknown / inactive / sold-out item,
`fulfillment.type != "pickup"`, unparseable `pickupAt`.
`401` on a missing / unknown `X-API-Key`.

---

## 3. `GET /api/website/orders/{ref}`

Auth: `X-API-Key`. Returns the **same WebsiteOrder object** as above, current.
Poll every 8 s until `status == "CONFIRMED"` (or `PAYMENT_FAILED`). `404 {error}`
if `ref` is unknown.

After staff add items in the POS, `totalPaise` and `balancePaise` grow (re-priced
at current catalog prices). `amountPaidPaise` reflects the verified advance.

---

## 4. Payment verification — `POST /api/razorpay/webhook` (POS side, FYI)

Configure this URL as the Razorpay webhook in the **POS** Razorpay account with
events `payment.captured`, `payment.failed`, `order.paid`. The Website does not
call it.

- Header `X-Razorpay-Signature` is verified as
  `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` (hex, timing-safe). Bad or
  missing signature → `401`, nothing changes. (No secret configured also fails.)
- The order is found **by** its stored `payment.providerOrderId`; the webhook's
  `order_id` must equal it exactly — any mismatch is rejected without touching
  any order.
- `payment.captured` / `order.paid` **and** `amountPaise == order.advancePaise`
  **and** the order is still `PENDING_PAYMENT`
  → `paymentStatus = ADVANCE_PAID`, `status = CONFIRMED`, `confirmedAt` set →
  the order joins the POS board and the realtime staff notification fires.
- amount ≠ `advancePaise` (while pending) → `PAYMENT_FAILED` / `FAILED`, mismatch recorded.
- `payment.failed` (while pending) → `PAYMENT_FAILED` / `FAILED`.
- An order that has already left `PENDING_PAYMENT` is **never reverted** by a
  later stray webhook.
- Idempotent per Razorpay payment id (and per order for `order.paid`); a repeat
  delivery is a no-op. Always returns `200` once the signature is valid so
  Razorpay stops retrying.

---

## 5. POS "Website Orders" page

Realtime board. Staff search by `ref` (`WEB-000123`) — the primary lookup — or by
name / phone, and see: customer name / phone / email, every ordered line + qty,
`status`, `paymentStatus`, advance paid, balance due, and bill status
(`unbilled` / `billed` + bill numbers). **Add Items** re-prices from the current
catalog in paise and grows the balance safely (server-side, transactional).
**Settle Bill** runs the existing POS billing/stock/bill-number machinery,
produces the proper immutable food/alcohol bill(s), decrements stock, and each
bill keeps `websiteOrderNo = "WEB-000123"`. Duplicate settlement is blocked.

---

## State machines (separate, POS-controlled)

| | states | who moves it |
|---|---|---|
| `status` | `PENDING_PAYMENT → CONFIRMED → PREPARING → READY → COMPLETED`; `CANCELLED`; `PAYMENT_FAILED` | `PENDING_PAYMENT→CONFIRMED` / `→PAYMENT_FAILED`: **Razorpay webhook only**. `CONFIRMED→PREPARING→READY` and `→CANCELLED`: staff. `→COMPLETED`: **Settle Bill only**. |
| `paymentStatus` | `UNPAID → ADVANCE_PAID`; `FAILED`; `REFUNDED` | `ADVANCE_PAID` / `FAILED`: Razorpay webhook. `REFUNDED`: manual/ops. |

The Website only ever reads these — it never sets a status.

---

## 6. Auth

`X-API-Key` is a **static allow-list** (`WEBSITE_API_KEYS`, comma-separated),
checked **first**, before anything else, on every `/api/website/*` request and on
the Razorpay webhook path it does not apply to (that one uses the Razorpay
signature). No cookies, no session, no CORS. Optionally, setting
`ENFORCE_APP_CHECK=true` additionally requires a Firebase App Check token
(`X-Firebase-AppCheck` header).

## 7. Payment provider

**Razorpay.** `POST /orders` returns `payment.providerOrderId` (`order_…`) and
`payment.keyId` (public `rzp_live_…`) so you can open Razorpay Checkout in the
browser for `payment.amountPaise`. Your server-to-server contract with the POS is
unchanged whether the POS runs `PAYMENT_PROVIDER=razorpay` (real) or `mock`
(local/testing — deterministic `order_mock_…` ids, webhook signed with the same
HMAC rule).

## Config (POS Functions env / secrets — see DEPLOY.md)

| var | meaning |
|---|---|
| `WEBSITE_API_KEYS` | comma-separated allow-list for `X-API-Key` |
| `PAYMENT_PROVIDER` | `razorpay` (real) or `mock` (local/testing) |
| `RAZORPAY_KEY_ID` | public key id, returned to the Website as `payment.keyId` |
| `RAZORPAY_KEY_SECRET` | server secret for the Razorpay Orders API (real mode) |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC secret for `X-Razorpay-Signature` verification |
| `ENFORCE_APP_CHECK` | `true` to also require an App Check token (not normally used server-to-server) |

The mock provider is **fail-closed** in a deployed function: `PAYMENT_PROVIDER`
must be `razorpay` (or `ALLOW_MOCK_PAYMENTS=true` set on a non-production test
project), otherwise `POST /orders` errors instead of issuing a fake Razorpay
order.

**On your side** the switch from the mock is: point the two `fetch()` calls in
`lib/pos-order-api.ts` at `POST /api/website/orders` and
`GET /api/website/orders/{ref}`, open Razorpay Checkout with the returned
`providerOrderId` + `keyId`, then poll the GET until `CONFIRMED`. Delete
`app/mockpos/`. Do not merge or modify the Website project into this repo — it
stays a separate deployable.
