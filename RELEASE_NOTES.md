# Next Level Family Restaurant ERP V2 — Production Release

This release contains the upgraded Flask/SQLite restaurant ERP with the premium owner dashboard, table-wise food and bar billing, optimized matched menu imagery, responsive all-items catalog presentation, resilient broken-image fallback, and browser-friendly asset caching.

## Run locally

From the project root, run `cd backend && python3 app.py`, then open `http://127.0.0.1:5000/`. The seeded demo login is the existing `admin` account in the included SQLite database.

## Public preview

[Open the refreshed live preview](https://5000-iq21etew2042g6a2dq5cj-d3ff34ba.us3.manus.computer)

## Release checks

The image audit passed with 186 mapped rows, 176 unique mapped paths, zero missing files, zero corrupt files, zero files above 350 KB in the optimized runtime mapping, and no undersized mapped assets. The optimized runtime library contains WebP derivatives under `frontend/assets/optimized`.

The table QA walkthrough verified opening T1, attaching a customer, adding Chicken Lollipop from Food Billing, selecting T1 from Bar Billing, adding Kingfisher Premium, calculating the combined table total, splitting the settlement into linked food and alcohol bill records, and returning T1 to Available. Temporary QA records were removed from the shipped database before packaging.

## Package contents

The production archive includes the Flask backend, SQLite database, frontend pages/styles/scripts, optimized runtime assets, and QA utilities. Large unoptimized source-photo folders are excluded from the production archive because no active page references them; keeping only the derivatives reduces handover size and preserves the fast runtime path.
