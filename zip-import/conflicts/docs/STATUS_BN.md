# প্রকল্পের বর্তমান অবস্থা (Part 1: Backend সম্পন্ন, Part 2: Frontend বাকি)

## Part 1 — Backend (তৈরি ও Automated Test সফল)
- Auth: Customer/Seller register, ফোন বা ইমেইল দিয়ে login, scrypt hash, DB-তে hashed session (৭ দিন মেয়াদ), logout, forgot/reset password (OTP), change password, profile update, phone/email verification OTP
- Role-based access: Customer / Seller / Admin আলাদা API; Seller ও Customer নিজের ডেটাই দেখে; suspend করলে session বাতিল
- Customer: address book, wishlist, server-side cart, coupon, shipping charge, COD + অনলাইন পেমেন্ট checkout, order list/detail/tracking, cancel, review (ডেলিভারির পর)
- Multi-vendor: একটি Parent Order + প্রতি Seller-এর আলাদা Suborder
- Seller: dashboard, product add/edit/archive (edit করলে আবার approval), ছবি, variants, stock, order management, courier booking, finance, payout request
- Admin: dashboard, customers, sellers (approve/reject/suspend/commission), products moderation, categories/brands, orders, refunds, payouts, finance report, transactions, audit log, coupons
- Payment: bKash/Nagad/Rocket/SSLCommerz **Sandbox** adapter; শুধু signed callback দিয়েই PAID হয়; duplicate callback নতুন transaction বানায় না
- Courier: Pathao/Steadfast/RedX **Sandbox** adapter (charge, booking, tracking ID, status, failed delivery, return)
- Security: rate limit, CORS allow-list, security headers, input validation, parameterized SQL, body size limit, production-এ demo account বন্ধ
- Automated test: ১২টি (Customer/Seller/Admin workflow, security, payment, refund, cancellation, rate limit)

## Part 2 — এখনো বাকি
1. Frontend (index/seller/admin.html) নতুন API-এর সঙ্গে যুক্ত করা: register, forgot password, cart, address, wishlist, dashboards ইত্যাদি (পুরনো UI এখনো নতুন API-র সঙ্গে চলে, তবে নতুন ফিচারের স্ক্রিন নেই)
2. PostgreSQL: `apps/api/migrations/postgres` schema আছে, কিন্তু runtime এখনো SQLite — data layer port করা বাকি
3. Live payment/courier: Merchant credentials পেলে Live adapter
4. SMS/Email provider (OTP পাঠানোর জন্য)
5. Deploy (Backend host + persistent DB + HTTPS), GitHub push ও CI যাচাই — আমার sandbox-এ network নেই

## ডেমো অ্যাকাউন্ট (শুধু development)
- Admin: 01700000001 / Admin@12345
- Seller: 01700000002 / Seller@12345
- Customer: 01700000003 / Customer@12345
