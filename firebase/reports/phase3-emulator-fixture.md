# Phase 3 — Firestore ETL reconciliation

- source: `scripts/fixtures/etl-source.sqlite`
- target: `emulator` (+ auth users)
- generated: 2026-09-06T09:47:07.097Z
- duration: 2585 ms
- result: **PASS** (37/37 checks)

## Count reconciliation

| collection | source rows | planned docs | target docs | ok |
| --- | ---: | ---: | ---: | :--: |
| users | 2 | 2 | 2 | ✅ |
| userCredentials | 2 | 2 | 2 | ✅ |
| categories | 4 | 4 | 4 | ✅ |
| catalog | 5 | 5 | 5 | ✅ |
| tables | 3 | 3 | 3 | ✅ |
| tableSessions | 2 | 2 | 2 | ✅ |
| bills | 4 | 4 | 4 | ✅ |
| qrOrders | 2 | 2 | 2 | ✅ |
| auditLog | 3 | 3 | 3 | ✅ |
| counters | 3 | 3 | 3 | ✅ |

## Structural checks

- ✅ nested:bill items
- ✅ nested:session items
- ✅ nested:qr items
- ✅ counters: exactly 3
- ✅ counters: foodBill/alcoholBill/qrOrder present
- ✅ counters: value >= max issued bill/order number
- ✅ users: at least one admin
- ✅ users: no profile carries passwordHash
- ✅ userCredentials: every doc has a Werkzeug hash + usernameLower
- ✅ auditLog: no doc contains a password hash
- ✅ catalog: food items have taxRate 0, alcohol carry brand/bottleSize
- ✅ catalog: categoryId points at an existing category doc
- ✅ tables: openSessionId (when set) points at an open session
- ✅ tableSessions: every settled session lists its bill ids and has settledAt
- ✅ bills: session-linked bills carry source=table and a sess_ ref
- ✅ fixture: user u_1 admin / u_2 staff
- ✅ fixture: cred u_1 usernameLower admin
- ✅ fixture: item_food_3 price 280 -> cat_food_2 'Main Course'
- ✅ fixture: item_food_2 stock null (untracked)
- ✅ fixture: item_food_1 stock 10
- ✅ fixture: item_alc_1 taxRate 18 brand Kingfisher 650ml
- ✅ fixture: table tbl_1 -> openSessionId sess_1; tbl_2 null
- ✅ fixture: sess_1 open, 2 items, alc line -> item_alc_1
- ✅ fixture: sess_1 subtotal 580 / tax 75.8 / grandTotal 655.8
- ✅ fixture: sess_2 settled, settledBillIds [bill_food_2, bill_alc_2]
- ✅ fixture: bill_food_1 FOOD/counter, 2 items, grandTotal 714, createdBy u_2, dateKey 2026-09-01, hour 13
- ✅ fixture: bill_food_1 searchTokens has 'ram' + 'food-000001'
- ✅ fixture: bill_food_2 -> sess_2, split discount food+alc == 100
- ✅ fixture: bill_alc_1 ALCOHOL, line taxRate 18
- ✅ fixture: qr ..01 SERVED, pushedToBill, -> sess_1, line -> item_food_1, tableNo 'Table 01'
- ✅ fixture: qr ..02 NEW, not pushed
- ✅ fixture: audit_2 table.settle, entityId remapped -> sess_2, details.discount 100
- ✅ fixture: audit_3 entityId remapped -> item_food_3
- ✅ fixture: audit_1 actorUid -> u_2
- ✅ fixture(target): bill_food_2 grandTotal 275.08 persisted
- ✅ fixture(target): counter foodBill persisted >= 2
- ✅ fixture(target): sess_1 items persisted (2)

## Deterministic id scheme

| collection | id |
| --- | --- |
| users | `u_<users.id>` |
| userCredentials | `u_<users.id>` |
| categories | `cat_food_<id> / cat_alc_<id>` |
| catalog | `item_food_<id> / item_alc_<id>` |
| tables | `tbl_<id>` |
| tableSessions | `sess_<id>` |
| bills | `bill_food_<id> / bill_alc_<id>` |
| qrOrders | `<public_ref>` |
| auditLog | `audit_<id>` |
| counters | `foodBill / alcoholBill / qrOrder` |
