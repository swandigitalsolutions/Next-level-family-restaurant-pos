# Final QA Walkthrough Notes

Date: 2026-08-26

## Asset delivery

- `qa/audit_image_delivery.py` passed after conversion: `mapped_rows=186`, `mapped_unique_paths=176`, `missing=0`, `corrupt=0`, `large_over_350kb=0`, `small_under_320x240=0`.
- Runtime optimized directory: `frontend/assets/optimized`, approximately 13 MB and 210 WebP derivatives.
- Food Billing and Alcohol Billing rendered matched WebP paths from the optimized libraries.
- Flask asset responses include public cache headers with `max-age=86400` for optimized assets and `max-age=3600` for legacy assets.

## Table and mixed-bill walkthrough

1. Opened `T1` with dummy QA data: customer `QA Walkthrough`, phone `9000000000`.
2. Added food item `Chicken Lollipop` at ₹250.00 plus 5% food tax, producing a table running total of ₹262.50.
3. Opened Bar Billing, selected destination `T1`, and added `Kingfisher Premium` at ₹180.00 plus 18% tax.
4. The shared table session contained both items. The session subtotal was ₹430.00, tax ₹44.90, and grand total ₹474.90.
5. Settled the session with Cash. The backend created linked records `FOOD-000002` at ₹262.50 and `ALC-000002` at ₹212.40, then returned T1 to Available.
6. Orders & Bills confirmed both records with status `confirmed` and customer `QA Walkthrough`.

## Note

The first UI confirmation attempt surfaced a transient `Server returned an invalid response` toast while the table PUT had already succeeded. A direct retry of the settlement endpoint returned HTTP 201 and the correct split bill records. The final refreshed UI and Orders & Bills page both showed the successful settled state.
