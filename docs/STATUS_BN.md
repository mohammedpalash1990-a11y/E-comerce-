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

## এখনো তৈরি হয়নি / production-এ নেওয়ার আগে প্রয়োজন
1. Production PostgreSQL adapter, Prisma migration এবং deployment database
2. Persistent secure session/token lifecycle, password reset, OTP verification এবং rate limiting
3. Seller onboarding/KYC, product editing, inventory controls ও seller-wise fulfilment
4. Multi-vendor cart থেকে seller-wise sub-order split এবং commission/settlement ledger
5. Customer address book, returns/refunds, dispute handling ও notification system
6. bKash/Nagad/SSLCommerz/card payment gateway এবং courier API integration
7. Admin user management, finance, payout ও audit log
8. Monitoring, automated backups, restore drill, privacy/legal review ও security testing
9. সম্পূর্ণ Android/iOS customer ও seller app

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
