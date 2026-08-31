# Deploying to Render

One Flask service serves both the API (`/api/*`) and the static frontend
(`/pages`, `/css`, `/js`, `/assets`) from the same origin, so a single Render
Web Service is all you need.

Data is stored in **PostgreSQL** when `DATABASE_URL` is set (recommended: a free
Supabase project). Without it the app runs on the bundled SQLite file, which on
Render's free plan resets on every restart.

## What changed for deployment

| File | Purpose |
| --- | --- |
| `backend/database.py` | Runs on SQLite **or** Postgres. A small compat layer maps the existing `conn.execute("... ?")` / `cursor.lastrowid` style onto psycopg, translates a few SQLite-only SQL functions, and creates + seeds the schema on boot. |
| `backend/requirements.txt` | Added `gunicorn` and `psycopg[binary]` |
| `backend/app.py` | `init_db()` on import (gunicorn has no `__main__`), `/healthz`, Secure cookies + `ProxyFix` when `RENDER=true` |
| `render.yaml` | Blueprint for one free web service (optional — you can fill the same values into the dashboard) |
| `Procfile`, `runtime.txt`, root `requirements.txt` | Support the dashboard/native path; pin Python 3.12.6 |
| `.env.example` | Documents every variable |

## Step 1 — Create the database (Supabase, free, no card)

1. Create a project at supabase.com.
2. **Project Settings → Database → Connection string**.
3. Choose the **Transaction pooler** URI (it is IPv4 and reachable from Render;
   the "Direct connection" is IPv6-only on the free plan). It looks like:
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`
4. Replace `<password>` with your database password. Keep this string secret.

(Neon or Render's own PostgreSQL work too — any Postgres URL is fine. Render's
free Postgres is deleted 30 days after creation; Supabase's free tier is not.)

## Step 2 — Create the Render Web Service (manual)

**New +** → **Web Service** → connect this GitHub repo, then:

| Field | Value |
| --- | --- |
| Language | `Python 3` |
| Branch | `main` |
| Root Directory | *(blank)* |
| Build Command | `pip install -r backend/requirements.txt` |
| Start Command | `gunicorn --chdir backend app:app --bind 0.0.0.0:$PORT --workers 2 --preload --timeout 60` |
| Instance Type | `Free` |
| Health Check Path (Advanced) | `/healthz` |

### Environment variables

| Key | Value |
| --- | --- |
| `SECRET_KEY` | click **Generate** |
| `DATABASE_URL` | the Supabase Transaction pooler URI from Step 1 |
| `PYTHON_VERSION` | `3.12.6` |
| `RENDER` | `true` |
| `TZ` | `Asia/Kolkata` |

Click **Deploy Web Service**. On first boot the app creates its tables in the
Postgres database and seeds the menu + admin user. When live, the service URL
opens `/pages/login.html`.

## Default login

`admin` / `nextlevel@123` — **change it immediately**. With `DATABASE_URL` set you can
do this from the Supabase SQL editor:

```sql
-- generate a hash locally:  python -c "from werkzeug.security import generate_password_hash as g; print(g('YOUR_NEW_PASSWORD'))"
UPDATE users SET password_hash = '<paste-hash>' WHERE username = 'admin';
```

## Test the Postgres path locally (optional)

```
cd backend
pip install -r requirements.txt
DATABASE_URL="postgresql://...pooler.supabase.com:6543/postgres" python app.py
# open http://127.0.0.1:5000/
```

With no `DATABASE_URL`, `python app.py` uses the bundled SQLite file exactly as
before.

## Notes

- The free web service sleeps after ~15 min idle and cold-starts in ~50s. The
  **data is safe** regardless — it lives in Postgres, not on the instance.
- `--preload` runs `init_db()` once in the gunicorn master before workers fork;
  an advisory lock also guards the first-boot schema creation.
- The compat layer covers what this codebase uses. If you add new SQL with
  other SQLite-specific functions, add a rule in `_translate` in
  `backend/database.py`.
