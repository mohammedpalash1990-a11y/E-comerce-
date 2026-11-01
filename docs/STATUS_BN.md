# প্রকল্পের বর্তমান অবস্থা

## বর্তমানে কাজ করছে (Development / Demo)
- বাংলা-প্রথম customer storefront: ক্যাটাগরি, পণ্য তালিকা, সার্চ ও cart
- Customer login এবং Cash on Delivery (COD) checkout
- Checkout-এ নাম, বাংলাদেশি মোবাইল নম্বর, পূর্ণ ঠিকানা, এলাকা ও optional note সংরক্ষণ
- Checkout-এর সময় stock validation, transaction-এর মধ্যে stock deduction এবং order item সংরক্ষণ
- Customer order history: পণ্যের নাম, quantity, মূল্য ও delivery তথ্য
- Seller login, নিজের product list এবং নতুন পণ্য জমা; নতুন পণ্য admin approval না পাওয়া পর্যন্ত storefront-এ প্রকাশ হয় না
- Checkout-এ seller অনুযায়ী আলাদা sub-order তৈরি; একই customer order-এ একাধিক seller থাকলে প্রত্যেক seller শুধু নিজের পণ্যের অংশ দেখে
- Seller workspace-এ নিজের sub-order, customer delivery তথ্য, পণ্য, পরিমাণ ও sub-total দেখা যায়
- Seller fulfilment workflow: CONFIRMED → PROCESSING → SHIPPED → DELIVERED; নির্দিষ্ট পর্যায়ে CANCELLED
- Seller sub-order cancel হলে শুধু ওই seller-এর পণ্যের stock transaction-এর মধ্যে ফেরত যোগ হয়; parent order-এর aggregate status আপডেট হয়
- Admin parent order cancel করলে seller sub-order-গুলোও cancel হয় এবং stock একবারই ফেরত যোগ হয়
- Admin product moderation: pending product দেখা, approve / reject
- Admin order queue: customer ও delivery তথ্য, line items, মোট মূল্য এবং status দেখা
- Admin order queue-তে customer-এর optional delivery note-ও দেখা যায়; malformed order-status URL reject করা হয়
- Admin order status workflow: CONFIRMED → PROCESSING → SHIPPED → DELIVERED; নির্দিষ্ট পর্যায়ে CANCELLED
- অনুমোদিত অবস্থায় order cancel হলে transaction-এর মধ্যে stock ফেরত যোগ
- Node.js API, SQLite development database, demo seed account, API proxy এবং CI test workflow

## ডেমো অ্যাকাউন্ট
- Customer: 01700000003 / Customer@12345
- Seller: 01700000002 / Seller@12345
- Admin: 01700000001 / Admin@12345

## Production safety gate
- বর্তমান API SQLite runtime ব্যবহার করে; `NODE_ENV=production` দিলে API ইচ্ছাকৃতভাবে startup বন্ধ করে।
- `DATABASE_URL` এখনো runtime-এ ব্যবহৃত হয় না; PostgreSQL adapter ও migration না হওয়া পর্যন্ত production deployment করা যাবে না।
- GitHub Pages শুধু static frontend; API hosting আলাদা প্রয়োজন।

## এখনো তৈরি হয়নি / production-এ নেওয়ার আগে প্রয়োজন
1. Production PostgreSQL runtime adapter ও verified migration execution (বর্তমান API SQLite development runtime ব্যবহার করে)
2. Persistent secure session/token lifecycle, password reset ও OTP verification provider
3. Live bKash/Nagad/SSLCommerz/card gateway এবং বাস্তব courier provider credentials/integration
4. Public Node.js API hosting, persistent database storage, production secrets ও monitoring
5. Returns/dispute handling, customer support operations এবং notification delivery provider
6. Security, privacy/legal review, automated backups ও restore drill
7. সম্পূর্ণ Android/iOS customer ও seller app

## পরীক্ষা ও deployment
- GitHub Actions CI-তে Node.js 22 দিয়ে syntax checks, repository checks এবং API tests চলে।
- API tests-এ role permissions, seller product submission, admin approval, COD checkout, customer order history, admin status transition, seller fulfilment lifecycle এবং cancellation stock restoration যাচাই করা হয়।
- GitHub Pages preview static frontend demo; এটি production API hosting নয়।
- SQLite ও in-memory sessions development/demo ব্যবহারের জন্য; live customer data বা production transaction-এর জন্য নয়।

## পরবর্তী অগ্রাধিকার
- P0: PostgreSQL schema/migrations, persistent authentication/session, API security hardening
- P1: Seller fulfilment, multi-vendor sub-orders, commission এবং settlement
- P2: Payment/courier sandbox integration, returns/refunds, notifications
- P3: Production monitoring, backups, security review এবং mobile app

## Storefront preview UX সংশোধন (২০২৬-১১-০১)
- API offline থাকলে storefront আর hard-coded ৮টি নমুনা পণ্যকে live inventory হিসেবে দেখায় না; পরিষ্কার offline/preview বার্তা ও retry control দেখায়।
- পণ্য ও category API থেকে একসঙ্গে লোড হয়; cart-এর localStorage key versioned করা হয়েছে।
- Seller এবং Admin login পেজে `/health` endpoint দিয়ে API/database connection status দেখায়।
- নতুন frontend regression test যোগ হয়েছে; CI pass করেছে।

## Neon PostgreSQL প্রস্তুতি (২০২৬-১১-০১)
- Neon project `haat-bangladesh` তৈরি হয়েছে (PostgreSQL 17, Singapore region); database `haat`।
- মূল `main` branch-এ PostgreSQL schema `001_init.sql` এবং index migration `002_indexes.sql` প্রয়োগ করা হয়েছে; ২৪টি application table, ৪৫টি index ও ২টি migration record যাচাই করা হয়েছে। ৮টি প্রাথমিক marketplace category-ও seed করা হয়েছে।
- আলাদা `haat-schema-validation` branch-এও schema যাচাইয়ের জন্য migration চালানো হয়েছে।
- এটি কেবল database schema provisioning; API এখনো `node:sqlite` synchronous API ব্যবহার করে। PostgreSQL runtime adapter, route-level async conversion, seed compatibility ও end-to-end tests সম্পন্ন না হওয়া পর্যন্ত production API deploy করা যাবে না।
