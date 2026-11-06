# Payment Gateway ও Webhook Security Contract

> **পরিধি:** এটি gateway-neutral implementation contract। কোনো live bKash, Nagad, SSLCommerz বা card gateway সংযুক্ত হয়েছে—এমন দাবি নয়।

## Payment state model
- `PENDING`: payment intent তৈরি, gateway confirmation নেই।
- `AUTHORIZED`: provider authorization দিয়েছে; capture semantics provider-specific।
- `PAID`: verified server-to-server confirmation।
- `FAILED`: provider failure বা definitive decline।
- `EXPIRED`: নির্ধারিত সময়ের মধ্যে confirmation আসেনি।
- `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`: refund lifecycle।

State transition allowlist ছাড়া client/API request দিয়ে payment status পরিবর্তন করা যাবে না। Browser redirect success page কখনো payment proof নয়।

## Payment intent
- Server order total, currency (BDT), order ownership ও payable balance পুনরায় হিসাব করবে।
- Provider request-এ unique merchant reference/idempotency key ব্যবহার করতে হবে।
- একই order-এর জন্য duplicate active payment intent সীমিত করতে হবে।
- Gateway secret শুধু server-side secret store/environment-এ থাকবে; log, HTML বা client bundle-এ নয়।

## Webhook verification
1. Raw request body signature verification-এর জন্য অক্ষত রাখতে হবে।
2. Provider-documented HMAC/signature algorithm, timestamp tolerance এবং key rotation policy প্রয়োগ করতে হবে।
3. Signature invalid, timestamp stale, malformed payload বা unknown merchant reference হলে reject করতে হবে।
4. Verified event-এর provider transaction ID, merchant reference, amount, currency ও event type যাচাই করতে হবে।
5. Amount অবশ্যই server-এর expected outstanding amount-এর সঙ্গে মিলতে হবে; floating-point নয়, integer paisa ব্যবহার করতে হবে।
6. একই provider event ID/transaction ID পুনরায় এলে idempotent acknowledgement দিতে হবে; ledger duplicate হবে না।

## Atomic persistence
একটি database transaction-এ:
- payment row lock ও current state validation
- webhook event unique insert
- provider transaction reference persist
- payment state update
- order payment state update
- immutable financial ledger entry
- audit event persist

যেকোনো persistence failure-এ পুরো transaction rollback। External provider call database transaction-এর ভিতরে দীর্ঘ সময় ধরে রাখা যাবে না।

## Refund safety
- Refund amount captured, non-refunded balance-এর বেশি হতে পারবে না।
- Refund request ও provider refund reference আলাদা state-এ track করতে হবে।
- Refund webhook একইভাবে signature-verified ও idempotent হতে হবে।
- Admin manual refund-এ actor, reason ও approval policy বাধ্যতামূলক।

## Monitoring ও operations
- Invalid signature, amount mismatch, duplicate event, unknown reference ও provider timeout আলাদা metric।
- Sensitive payload/PII redact করে structured log রাখতে হবে।
- Pending payment reconciliation job provider API-এর সঙ্গে server-side compare করবে; client status নয়।
- Secret rotation ও webhook replay runbook রাখতে হবে।

## Acceptance criteria
- Forged/unsigned webhook payment PAID করতে পারবে না।
- Amount/currency mismatch কোনো ledger entry তৈরি করবে না।
- Duplicate webhook একবারই ledger লিখবে।
- Out-of-order event পুরনো state-এ payment ফিরিয়ে নিতে পারবে না।
- Browser redirect একা order fulfilment trigger করবে না।

## বর্তমান PostgreSQL sandbox implementation
- PostgreSQL checkout এখন COD এবং sandbox online payment intent তৈরি করতে পারে।
- Online checkout-এর order/stock/payment row transaction commit হওয়ার পরে gateway initiation হয়; gateway call database transaction-এর ভিতরে চলে না।
- Customer order-এর মালিকানা যাচাই করে `POST /api/v1/customer/orders/{id}/pay` দিয়ে payment শুরু/পুনরায় শুরু করতে পারে।
- `GET /api/v1/payments/{id}/status` শুধু মালিকের payment status ও amount দেয়; provider payload প্রকাশ করে না।
- `POST /api/v1/payments/sandbox/{id}/simulate` sandbox-এ signed success/failure callback simulate করে।
- `POST /api/v1/payments/callback/{gateway}` sandbox HMAC signature, transaction ID, BDT amount ও outcome যাচাই করে; replay/duplicate success ledger-এ দ্বিতীয়বার লেখা হয় না।
- Callback-এর পর payment, order status, seller order, transaction ledger, notification, audit এবং প্রয়োজনে cancelled order-এর bounded refund request একই PostgreSQL transaction-এ সংরক্ষিত হয়।
- `PAYMENT_MODE=sandbox` দিয়ে test mode নির্বাচন করা হয়। `PAYMENT_WEBHOOK_SECRET` অবশ্যই server-side secret হিসেবে রাখতে হবে।

## Production/live integration boundary
বর্তমান implementation sandbox-only। এটি live bKash/Nagad/Rocket/SSLCOMMERZ adapter বা production webhook নয়। Production-এর আগে provider-specific raw-body signature verification, timestamp/replay tolerance, key rotation, provider event-ID idempotency, merchant reference/currency verification, timeout/reconciliation worker, refund-provider lifecycle, structured redacted monitoring এবং provider-এর official sandbox acceptance tests আবশ্যক। কোনো live gateway credential দিয়ে payment নেওয়া যাবে না। PostgreSQL production startup gate seller/admin, delivery এবং live payment integration সম্পূর্ণ যাচাই না হওয়া পর্যন্ত fail-closed থাকবে।