# Phase 3 — Firestore ETL reconciliation

- source: `../backend/nextlevel.db`
- target: `dry`
- generated: 2026-09-06T09:46:33.063Z
- duration: 7 ms
- result: **PASS** (16/16 checks)

## Count reconciliation

| collection | source rows | planned docs | target docs | ok |
| --- | ---: | ---: | ---: | :--: |
| users | 2 | 2 | — | ✅ |
| userCredentials | 2 | 2 | — | ✅ |
| categories | 18 | 18 | — | ✅ |
| catalog | 108 | 108 | — | ✅ |
| tables | 15 | 15 | — | ✅ |
| tableSessions | 0 | 0 | — | ✅ |
| bills | 0 | 0 | — | ✅ |
| qrOrders | 0 | 0 | — | ✅ |
| auditLog | 0 | 0 | — | ✅ |
| counters | 3 | 3 | — | ✅ |

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
- ✅ seed source: generic checks only (no transactional fixture markers)

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
