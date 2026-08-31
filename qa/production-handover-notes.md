# Next Level Family Restaurant ERP — Production Handover

## Corrected food billing experience

Food Billing now renders all **78 food products** in a readable, spacious “All Items” gallery. The item-level image map is loaded before shared runtime code on Food Billing and Menu Studio, and every map entry points to an existing local asset. The corrected library contains exact or semantically matched real dish photographs for starters, soups, curries, rice, breads, South Indian dishes, desserts, and beverages. Five rice items retain the existing item-named curated assets as their fallback because those files are already local and rice-specific.

The user-reported mismatch class is guarded explicitly: Chicken Lollipop uses a lollipop image, Chicken 65 uses a Chicken 65 image, Mutton Seekh Kebab uses a seekh-kebab image, Paneer Tikka uses a paneer-tikka image, and the named dessert/rice items use named dish assets.

## Table-wise billing

Food Billing includes a dining-floor section with twelve default tables, availability status, seats, customer context, open-session amount, and actions to open or continue billing. Staff can add tables, open a table with customer details, add food items to the table cart, save the running session, and settle the table bill with payment method and discount. Bar Billing includes a billing-destination selector so beverage items can be attached to an open table session before settlement. The backend persists restaurant tables, table sessions, session line items, and finalized table context.

## Validation performed

The project passes Python compilation and JavaScript syntax checks. The production verifier confirms 78 food assignments, zero missing image files, 12 default tables, the required table-session tables, and zero leftover QA sessions. Browser verification confirmed the All Items gallery renders 78 items, the T1 open-table workflow updates the running bill, and Bar Billing exposes the open-table selector.

## Run locally

From the project root:

```bash
sudo pip3 install -r backend/requirements.txt
cd backend
python3 app.py
```

Then open `http://127.0.0.1:5000/pages/login.html`. The default demo login remains the credentials already included in the original project README.
