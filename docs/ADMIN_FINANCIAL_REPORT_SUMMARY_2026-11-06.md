# PostgreSQL Admin Financial Report Summary — 2026-11-06

## Endpoint

`GET /api/v1/admin/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`

Optional seller scope:

`GET /api/v1/admin/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&seller_id=<seller-id>`

The endpoint is registered through the existing PostgreSQL admin dashboard route module and requires the `ADMIN` role. It is read-only and uses bound SQL parameters. Both dates are required, must be real calendar dates, and the inclusive range is limited to 366 days.

## Date and currency rules

- Calendar boundaries are calculated in `Asia/Dhaka`; for example, a report date begins at 00:00 Dhaka time and ends immediately before the next Dhaka midnight.
- Persisted timestamps are interpreted as PostgreSQL `timestamptz` values.
- Order metrics use `orders.created_at`; ledger metrics use `transactions.created_at`; refund metrics use `refunds.created_at`; payout metrics use `payouts.created_at`.
- Amounts are aggregated in integer paisa and returned in both paisa and BDT. Values outside JavaScript's safe-integer range are rejected rather than rounded.
- A seller-scoped report attributes merchandise and discounts from that seller's `seller_orders` row. Parent shipping is intentionally returned as `null`, because the current schema does not allocate shipping to individual sellers.

## Metric definitions

- Total orders: parent orders created in the selected period and, when supplied, containing the selected seller.
- Paid orders and paid merchandise: paid, non-cancelled orders only.
- Cancelled orders: all matching parent orders whose current status is `CANCELLED`.
- Unpaid COD: non-cancelled COD orders whose current payment status is not `PAID`.
- Gross merchandise: order subtotal, or seller sub-order subtotal for a seller-scoped report.
- Discounts: order discount, or seller-attributed coupon discount for a seller-scoped report.
- Net merchandise: gross merchandise less the attributed discount. Shipping is reported separately and is not included in net merchandise.
- Commission, seller earnings and seller reversals: immutable transaction-ledger rows created during the selected period.
- Requested refunds: refund rows created during the period whose current status is `REQUESTED`. This is a request queue metric, not proof of a completed refund.
- Payout requested/approved/rejected: payout requests created during the period, grouped by their current status. An approved request is not represented as a confirmed bank/mobile-wallet settlement.

## Verified boundary

A disposable PostgreSQL integration test seeds two sellers, multiple orders, ledger entries, refunds and payouts. It checks seller isolation and the Dhaka midnight boundary. The existing admin dashboard route and canonical storefront are not changed.

## Remaining reporting work

This is a summary API increment, not the full reporting/export feature. CSV export, formula-injection protection, paginated detail rows, explicit refund decision/capture lifecycle, courier COD remittance reconciliation, and bilingual admin reporting UI remain separate work. Production startup remains fail-closed; this increment does not authorize a public deployment.
