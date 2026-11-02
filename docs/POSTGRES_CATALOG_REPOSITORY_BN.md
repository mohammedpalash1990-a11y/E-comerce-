# PostgreSQL Catalog Repository — Migration Slice

## এই ধাপে কী যোগ হয়েছে

`apps/api/src/postgres-catalog.mjs` একটি asynchronous read repository। এটি বিদ্যমান marketplace catalog contract অনুযায়ী নিচের public read operation পরিচালনা করতে পারে:

- category ও brand তালিকা
- product search, category/brand filter, price range, sort এবং bounded pagination
- product suggestion
- product detail, image, variant ও review summary
- product review list

Repository-টি `createPostgresDatabase(pool)` adapter-এর `q().all/get()` contract ব্যবহার করে। SQLite `core.mjs` import করে না, তাই PostgreSQL-only test বা ভবিষ্যৎ server entrypoint-এ এটি আলাদাভাবে ব্যবহার করা যায়।

## গুরুত্বপূর্ণ implementation সিদ্ধান্ত

1. PostgreSQL English-language search-এর জন্য `ILIKE` ব্যবহার করা হয়েছে; SQLite `LIKE`-এর case-insensitive আচরণের কাছাকাছি ফল দেয়।
2. Product visibility আগের public API-র মতোই active product এবং APPROVED seller-এ সীমাবদ্ধ।
3. Sort expression allowlist করা; user input সরাসরি SQL order clause-এ ঢোকে না।
4. Limit সর্বোচ্চ 100-এ সীমাবদ্ধ, offset negative হলে 0 হয়।
5. PostgreSQL BIGINT string-কে response-এর আগে safe integer-এ normalize করা হয়। JavaScript safe integer-এর বাইরে হলে ভুল টাকার অঙ্ক দেখানোর বদলে error হয়।
6. Product detail response থেকে seller ownership identifier বাদ দেওয়া হয়; shop name প্রকাশ্য field হিসেবে রাখা হয়।

## কী এখনো করা হয়নি

- বিদ্যমান `routes_public.mjs` এখনো synchronous SQLite `q()` ব্যবহার করে। নতুন repository-টি এখনো HTTP route-এ wire করা হয়নি।
- Authentication, session, OTP, cart, checkout, order, seller ও admin routes PostgreSQL-এ migrate হয়নি।
- এই tests fake pg-compatible pool ব্যবহার করে; live Neon/PostgreSQL connection test নয়।
- PostgreSQL migration schema বাস্তব database-এ apply করা হয়নি।
- Customer, seller বা admin UI-তে কোনো পরিবর্তন করা হয়নি।

## Validation

Run:

```bash
node --test tests/postgres-catalog.test.mjs
npm run check
```

এই slice-এর উদ্দেশ্য হলো প্রথমে catalog read contract-কে আলাদা ও testable করা। পরের ধাপে এই repository-কে আলাদা async route registration-এ যুক্ত করে SQLite development route-র সঙ্গে response parity যাচাই করতে হবে। সব route, auth এবং transactional checkout migrate ও যাচাই না হওয়া পর্যন্ত production startup guard অক্ষত থাকবে।
