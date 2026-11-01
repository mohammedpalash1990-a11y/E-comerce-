# PostgreSQL Domain Repositories — Inventory, Checkout ও Order/Payment

## এই পরিবর্তনের সীমা

এই branch-এ তিনটি আলাদা async repository তৈরি করা হয়েছে। এগুলো PostgreSQL adapter (createPostgresDatabase) ব্যবহার করে এবং SQLite development runtime-কে পরিবর্তন করে না।

- postgres-inventory.mjs: stock read, locked adjustment, exact stock set ও movement ledger।
- postgres-checkout.mjs: server-side cart, coupon validation, price calculation, seller sub-order creation এবং transactional stock reservation।
- postgres-orders-payments.mjs: customer-owned order read, tracking, seller/admin status transition, payment initiation state এবং verified gateway callback handling।

বর্তমান customer storefront, seller/admin HTML, synchronous SQLite route modules, auth/session resolver বা catalog repository এই branch-এ পরিবর্তন করা হয়নি।

## Inventory ledger

Migration 004_inventory_movements.sql একটি append-only stock movement table যোগ করে। প্রতিটি stock change-এ আগের stock, পরিবর্তনের পরের stock, delta, reason, actor, reference ও timestamp থাকে। CHECK(stock_after = stock_before + delta) ভুল ledger row আটকায়। product_id delete হলে historical ledger নষ্ট না করতে delete restrict করা হয়েছে।

Stock adjust/set করার সময় repository প্রথমে product row FOR UPDATE lock করে, negative বা unsafe stock reject করে, product update ও ledger/audit insert একই transaction-এ করে। Zero delta-তে কোনো write হয় না।

## Cart ও checkout invariants

- Cart quantity 1–1000; একক product-এর stock অতিক্রম করা যায় না।
- Checkout-এ cart row ও product row transaction-এর মধ্যে lock হয়।
- পণ্য active, approved seller-এর এবং পর্যাপ্ত stock-সহ না হলে checkout বন্ধ হয়।
- Price/discount, coupon, shipping ও totals integer paisa-তে হিসাব হয়; unsafe integer reject হয়।
- Stock deduction conditional update এবং inventory movement insert একই transaction-এ হয়।
- Seller অনুযায়ী পৃথক seller_orders এবং line-level order_items তৈরি হয়।
- Coupon usage, cart clearing, order rows, payment row, audit/event ও stock movement একই transaction-এর মধ্যে থাকে; মাঝপথে error হলে সব rollback করতে হবে।

shippingForPaisa(area, subtotalPaisa) অবশ্যই API composition layer থেকে inject করতে হবে। বিদ্যমান sandbox gateway module-এর shipping policy adapter হিসেবে reuse করা উচিত; নতুন shipping policy এখানে hard-code করা হয়নি।

Online method-এর checkout order ও payment row PENDING অবস্থায় তৈরি করে। Third-party gateway initiation database transaction-এর বাইরে করতে হবে। Gateway সফলভাবে transaction ID/redirect URL দিলে তবেই setPaymentInitiated() দিয়ে সেই gateway transaction store করতে হবে। Gateway call ব্যর্থ হলে order/payment retry বা cancellation flow controller স্তরে নির্ধারণ করতে হবে।

## Orders ও payments

- Customer order query-তে order_id + user_id দুটোই বাধ্যতামূলক; অন্য customer-এর order null হিসেবে ফেরে।
- Seller sub-order transition-এ seller_id + sub_order_id scope বাধ্যতামূলক।
- Cancellation-এ stock restore ও positive inventory movement একই transaction-এ লেখা হয়।
- Delivery-তে seller earning ও platform commission ledger insert ON CONFLICT(kind,ref) DO NOTHING দিয়ে idempotent।
- COD order সব sub-order delivered হলে payment-কে PAID করে।
- Online callback handler কেবল signature/amount verification সম্পন্ন হওয়ার পরে recordVerifiedPaymentCallback() ডাকবে। এই repository নিজে webhook signature verify করে না এবং কোনো live gateway call করে না।
- Payment success ledger reference payment id; repeated callback একই payment transaction দ্বিতীয়বার লেখে না।

## Wiring / integration status

এটি repository foundation; API routes এখনো নতুন repository-তে switch করা হয়নি। পরবর্তী integration-এ:
1. async route handlers এবং DI options যোগ করতে হবে;
2. auth/session থেকে verified user id inject করতে হবে;
3. gateway signature verify controller স্তরে রাখতে হবে;
4. live Neon branch-এ migration 004 apply ও schema check করতে হবে;
5. PostgreSQL integration tests-এ concurrent checkout, coupon race, stock contention, cancel/refund এবং duplicate webhook পরীক্ষা করতে হবে।

Production startup guard অপরিবর্তিত থাকবে। এই PR merge হলেও marketplace production-ready হবে না।

## Tests

নতুন tests:
- node --test tests/postgres-inventory.test.mjs
- node --test tests/postgres-checkout.test.mjs
- node --test tests/postgres-orders-payments.test.mjs

প্রতিটি test fake pg-compatible adapter ব্যবহার করে। এগুলো SQL contract ও transaction orchestration পরীক্ষা করে; live PostgreSQL/Neon integration-এর বিকল্প নয়।
