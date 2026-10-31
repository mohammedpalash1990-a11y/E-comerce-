# প্রকল্পের বর্তমান অবস্থা

## GitHub-এ বর্তমানে যা আছে
- বাংলা-প্রথম customer storefront: category ও product list, search
- Node.js API: health, category/product list, development login, COD order creation
- SQLite development database এবং demo seed account
- Checkout-এ stock validation ও deduction
- API proxy-সহ web server
- PostgreSQL-এর প্রাথমিক Prisma schema, OpenAPI starter, Docker/CI scaffolding

## এখনো তৈরি হয়নি
1. পূর্ণ seller onboarding, product submission, inventory management ও seller order fulfilment
2. Admin moderation, user management, finance, commission ও payout workflows
3. এক অর্ডারকে seller-wise sub-order-এ ভাগ করা এবং settlement ledger
4. Customer address book, order history, returns/refunds ও notifications
5. bKash/Nagad/SSLCommerz/card payment gateway এবং courier API
6. SQLite adapter থেকে production PostgreSQL adapter-এ migration; Prisma schema validate/migrate
7. সম্পূর্ণ Android/iOS app

## পরীক্ষা
বর্তমান GitHub branch-এ একটি API smoke test রাখা হয়েছে। CI-তে Node.js 22 দিয়ে `npm run check` চলে। এই scaffold-এর সব deployment path এখনো বাস্তবে যাচাই করা হয়নি।

## Production blockers
- SQLite development adapter; production PostgreSQL adapter ও migration প্রয়োজন
- In-memory demo session; production-grade secure session/token lifecycle প্রয়োজন
- COD ছাড়া payment method live নয়
- Courier, tracking, returns/refunds এবং reconciliation নেই
- Rate limiting, monitoring, backup/restore, privacy/legal review ও penetration test প্রয়োজন

## পরবর্তী অগ্রাধিকার
P0: PostgreSQL adapter, schema validation/migrations, robust authentication and role authorization.
P1: Seller workflows, admin moderation, multi-seller orders, commissions and payout ledger.
P2: Payment/courier sandbox integration, returns/refunds, notifications and mobile app.


## অর্ডার পরিচালনা
- কাস্টমার COD checkout-এ নাম, বাংলাদেশি মোবাইল, পূর্ণ ঠিকানা ও এলাকা বাধ্যতামূলক।
- Admin Console-এ সাম্প্রতিক অর্ডার, গ্রাহক ও ডেলিভারি তথ্য দেখা যায়।
- অর্ডারের অবস্থা নির্দিষ্ট ধাপে পরিবর্তন করা যায়; অনুমোদিত অবস্থায় বাতিল হলে স্টক ফেরত যোগ হয়।
- Seller-wise fulfilment, multi-vendor order splitting ও settlement পরবর্তী কাজ।
