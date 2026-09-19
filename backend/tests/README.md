# Flask track — test suite

```
cd backend
pip install -r requirements.txt pytest
pytest tests -q
```

That runs everything against a throwaway SQLite database and needs no setup.

## Running against Postgres (what production actually uses)

The concurrency tests are skipped on SQLite, because SQLite serialises writes
on one file and therefore cannot reproduce the races that matter (two cashiers
settling one table, a double-tapped "Save"). Point the suite at a **disposable**
Postgres cluster to run them:

```
# one-time: start a scratch cluster on port 55432
initdb -D /tmp/nlpg -U postgres -A trust
pg_ctl -D /tmp/nlpg -o "-p 55432" -l /tmp/nlpg.log start

TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres pytest tests -q
```

Each test creates and drops its own database on that cluster, with the session
`TimeZone` forced to **UTC** on purpose — that is what Supabase's transaction
pooler leaves in place in production, and every date/hour the app reports must
still come out in the restaurant's own clock regardless.

> Never point `TEST_DATABASE_URL` at the live database. The fixture creates and
> drops databases on whatever cluster it is given.

## What is covered

| File | Covers |
|---|---|
| `test_billing.py` | bill totals, tax-only-on-alcohol, discount limits, pro-rata discount split, gap-free bill numbers, retry-safe bill creation, settle-twice safety, stock decrement |
| `test_auth_and_public.py` | role boundaries (admin/manager/staff/owner), login throttling, the website API key, QR re-pricing and limits, JSON-only errors, connection release on failure, CSV formula injection |
| `test_concurrency.py` | 6–8 simultaneous requests: bill-number races, double settlement, double table-open, same-key retries, double push-to-bill (Postgres only) |
