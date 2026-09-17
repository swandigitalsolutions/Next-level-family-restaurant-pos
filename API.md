# Next Level Family Restaurant — API Reference

## Base URL

| Environment | URL |
| --- | --- |
| Local dev | `http://localhost:5000` |
| Production | your Render service URL (e.g. `https://<service-name>.onrender.com`) — see `DEPLOY.md` |

One Flask process serves both the API (`/api/*`) and the static frontend from the same origin.

## Auth models (two, deliberately separate)

1. **Session cookie** — used by the staff web app itself. `POST /api/login` sets an
   HttpOnly session cookie; every subsequent request must include it
   (`credentials: "include"` from a browser). Role-gated via `login_required` /
   `require_role(...)`.
2. **Static API key** — used by **server-to-server** integrations (no cookie, no
   browser involved). Send header `X-API-Key: <key>`. Checked before any session
   logic runs. Valid keys come from the `WEBSITE_API_KEYS` environment variable
   (comma-separated allowlist — rotate by adding a new key, removing the old one,
   redeploying). No key or a key not in the list → `401 {"error": "unauthorized"}`.
   Currently gates every route under `/api/website/*`. CORS is intentionally
   closed for these routes — they're not meant to be called from a browser.

## Website integration

### `GET /api/website/menu`

Read-only, food-only live menu for the restaurant's public website. Server-to-server only.

**Auth:** `X-API-Key: <key>` (see above). No query params in v1.

**Response — `200 application/json`**
```json
{
  "currency": "INR",
  "updatedAt": "2026-09-05T14:18:52Z",
  "categories": [
    {
      "id": 3,
      "name": "Starters",
      "sortOrder": 1,
      "items": [
        {
          "id": 42,
          "name": "Paneer 65",
          "description": "Curry-leaf tempered",
          "price": 259,
          "available": true
        }
      ]
    }
  ]
}
```

**Rules implemented:**
- Food only — alcohol categories/items are never included.
- Categories: `status = 'active'` only, ordered by `sort_order` then `name`. Items nested inside, same ordering rule (by name, within their category).
- Items: every `status = 'active'` item is returned regardless of stock.
  `available = status='active' AND (stock_qty IS NULL OR stock_qty > 0)` — the
  website is expected to grey out unavailable dishes rather than hide them.
- `price`: plain number, rupees, no formatting.
- `id` (category and item): the real, stable database ids.
- `updatedAt`: ISO 8601 UTC (`...Z`), the max `updated_at` across every category
  and item actually returned in this response.
- `description`: nullable (`food_items.description`, added for this endpoint —
  also used by the customer-facing QR menu at `/menu/<qr_token>`).

**Test:**
```bash
curl -s http://localhost:5000/api/website/menu -H "X-API-Key: <key>" | jq
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5000/api/website/menu   # 401, no key
```

**Deferred:** `POST /api/website/orders` and order-status endpoints are not built
yet — pending the dine-in pre-order / reservations design.

## Full route table

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET | `/api/website/menu` | Public food menu for the website integration | API key |
| POST | `/api/login` | Session login | public |
| POST | `/api/logout` | Session logout | login |
| GET | `/api/me` | Current session user | login |
| GET | `/api/health` | Liveness | public |
| GET/POST | `/api/staff`, PUT/DELETE `/api/staff/<id>` | Staff account CRUD | admin |
| GET/POST | `/api/food/categories`, PUT/DELETE `/api/food/categories/<id>` | Food category CRUD | GET: login · writes: admin/manager |
| GET/POST | `/api/food/items`, PUT/DELETE `/api/food/items/<id>` | Food item CRUD (price, stock_qty, description) | same |
| GET/POST | `/api/alcohol/categories`, PUT/DELETE `/api/alcohol/categories/<id>` | Alcohol category CRUD | same |
| GET/POST | `/api/alcohol/items`, PUT/DELETE `/api/alcohol/items/<id>` | Alcohol item CRUD | same |
| GET/POST | `/api/tables`, PUT `/api/tables/<id>` | Dining table CRUD | GET: login · writes: admin/manager |
| POST | `/api/tables/<id>/open` | Open a table session | login |
| GET/PUT | `/api/table-sessions/<id>` | View/save a table's running cart | login |
| POST | `/api/table-sessions/<id>/settle` | Close a table → creates bill(s) | login |
| POST/GET | `/api/food/bills`, GET `/api/food/bills/<id>` | Food bill create/list/view | login |
| POST/GET | `/api/alcohol/bills`, GET `/api/alcohol/bills/<id>` | Alcohol bill create/list/view | login |
| GET | `/api/orders` | Combined, paginated bill list (search/type/date) | login |
| GET | `/api/dashboard` | Sales aggregates | login |
| GET | `/api/audit-log` | Activity trail | admin |
| GET | `/api/reports/export` | CSV export | admin/manager |
| GET | `/menu/<qr_token>` | Customer-facing menu page (HTML) | public |
| GET | `/api/qr/menu/<qr_token>` | Customer-facing menu data, scoped to one table | public |
| POST | `/api/qr/orders` | Customer places an order against a table | public |
| GET | `/api/qr/orders/<public_ref>` | Order status by opaque public ref | public |
| GET | `/api/qr/tables/<qr_token>/orders` | Today's orders for that table | public |
| GET/POST | `/api/qr-ordering/tables`, `/tables/<id>/qr.svg`, `/tables/<id>/regenerate-qr` | Staff-side QR/table management | login (writes: admin/manager) |
| GET | `/api/qr-ordering/orders` | Staff order queue, filterable | login |
| GET | `/api/qr-ordering/pulse` | New-order polling (12s interval on the Live Orders screen) | login |
| POST | `/api/qr-ordering/orders/<id>/status` | Advance order status | login |
| POST | `/api/qr-ordering/orders/<id>/push-to-bill` | Fold a QR order into a table's bill | login |

## Environment variables relevant to the API

| Key | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Unset → falls back to bundled SQLite. |
| `SECRET_KEY` | Session cookie signing key. Required (no default) in production. |
| `WEBSITE_API_KEYS` | Comma-separated allowlist for `X-API-Key` on `/api/website/*`. |
| `CORS_ORIGINS` | Comma-separated allowlist for browser-based cross-origin calls. Leave unset for server-to-server callers — CORS doesn't apply to them. |
| `RENDER` / `PRODUCTION` | Set `true` to enable Secure cookies + `ProxyFix` behind Render's proxy. |
| `TZ` | Restaurant's local timezone for "today" calculations. Default `Asia/Kolkata`. |
