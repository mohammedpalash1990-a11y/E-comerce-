# প্রকল্পের বর্তমান অবস্থা

## MVP-তে আছে
- কাস্টমার storefront, category filter, search, cart
- customer registration/login এবং order history
- seller product submission ও seller order view
- admin seller/product moderation এবং audit log
- COD checkout, seller-wise sub-order, commission calculation ও stock deduction
- API integration tests, OpenAPI contract, Prisma target schema, Docker/CI scaffolding

## পরীক্ষার অবস্থা
বর্তমান development environment-এ API integration test suite-এর ৫টি test পাস করেছে। CI workflow-ও যুক্ত আছে।

## এখনো production-ready নয়
1. API development adapter SQLite ব্যবহার করে; PostgreSQL production adapter ও migrations সম্পন্ন করতে হবে।
2. bKash/Nagad/SSLCommerz বা card gateway live নয়; COD-ই একমাত্র enabled method।
3. Courier API, tracking, label, COD remittance reconciliation live নয়।
4. Mobile app scaffold আছে; সম্পূর্ণ Android/iOS app implementation নয়।
5. Docker image/compose deployment বাস্তবে target hosting-এ যাচাই করতে হবে।
6. Rate limiting, secrets rotation, backup/restore, observability, penetration test এবং privacy/legal review প্রয়োজন।

## পরবর্তী কাজের অগ্রাধিকার
P0: PostgreSQL adapter + migration + automated integration tests।
P1: payment gateway sandbox integration, courier sandbox integration, refunds/returns।
P2: mobile app, analytics, customer support, finance ledger and payout approvals।
