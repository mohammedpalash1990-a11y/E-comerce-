# Seller Inventory Workflow — বাংলা অপারেশনাল কন্ট্রাক্ট

> **পরিধি:** এই নথি implementation specification; এটি কোনো live seller inventory feature চালু করে না।

## লক্ষ্য
Seller যেন নিজের অনুমোদিত পণ্যের stock দেখতে, নিরাপদে stock correction জমা দিতে এবং প্রতিটি পরিবর্তনের কারণ ও audit trail যাচাই করতে পারেন। Seller কখনো অন্য seller-এর inventory পরিবর্তন করতে পারবেন না।

## ভূমিকা ও অনুমতি
- **Seller:** নিজের product-এর available/reserved stock দেখতে পারবেন; correction request জমা দিতে পারবেন।
- **Admin:** exceptional correction approve/reject করতে পারবেন; সব seller-এর inventory audit করতে পারবেন।
- **System:** checkout reservation, cancellation restoration এবং delivery completion-এর stock movement atomically লিখবে।
- Client-supplied seller ID বা stock total কখনো authorization-এর উৎস হবে না; authenticated principal থেকে seller scope resolve করতে হবে।

## Stock model
- `on_hand`: physical/recorded stock
- `reserved`: confirmed checkout-এ সাময়িকভাবে আটকে রাখা quantity
- `available = on_hand - reserved`
- সব quantity positive integer; fractional বা negative quantity reject।
- Checkout-এর সময় available stock conditional update এবং transaction row lock দিয়ে নিশ্চিত করতে হবে।
- Cancellation restoration একই order-item movement দ্বিতীয়বার প্রয়োগ করতে পারবে না।

## Adjustment workflow
1. Seller product ও current stock দেখে adjustment reason, signed delta এবং reference submit করবেন।
2. API seller ownership পুনরায় যাচাই করবে; client থেকে পাঠানো current stock গ্রহণ করবে না।
3. সাধারণ stock increase/decrease-এর জন্য configurable threshold; threshold ছাড়ালে admin approval আবশ্যক।
4. Adjustment transaction-এ stock row lock, bounds check, movement insert ও audit event একসঙ্গে commit হবে।
5. Duplicate request idempotency key দিয়ে একবারই কার্যকর হবে।
6. Rejection-এ stock অপরিবর্তিত থাকবে এবং reason audit-এ থাকবে।

## Required movement fields
`id, product_id, seller_id, actor_id, movement_type, quantity_delta, reason_code, reference_type, reference_id, idempotency_key, created_at`। Movement immutable; correction করতে বিপরীত movement লিখতে হবে।

## Concurrency ও security invariants
- একই product-এর concurrent checkout ও adjustment serialize করতে হবে।
- Stock কখনো শূন্যের নিচে যাবে না।
- Seller scope প্রতিটি read এবং write-এ enforce হবে।
- Admin override-এর জন্য actor, reason এবং before/after quantity বাধ্যতামূলক।
- Client কখনো reserved stock সরাসরি পরিবর্তন করতে পারবে না।
- Audit failure হলে stock mutation rollback হবে।

## Acceptance criteria
- অন্য seller-এর product ID দিয়ে read/write করলে 404/403।
- একই idempotency key পুনরায় পাঠালে দ্বিতীয় movement তৈরি হবে না।
- concurrent checkout-এ মোট reservation available stock অতিক্রম করবে না।
- adjustment + checkout conflict-এ কোনো partial update থাকবে না।
- cancellation পুনরাবৃত্তি করলেও stock একবারই ফেরত আসবে।
- সব movement admin audit report-এ actor ও reason-সহ দেখা যাবে।

## Integration boundary
বর্তমান PostgreSQL checkout/order repositories stock reservation ও cancellation restoration-এর groundwork দেয়; seller-facing adjustment endpoint, UI, migration, audit integration এবং live PostgreSQL concurrency test আলাদা implementation task।