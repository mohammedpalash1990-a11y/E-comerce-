# PostgreSQL Catalog HTTP API Integration — Phase Report (বাংলা)

## ১. সারসংক্ষেপ
এই ধাপে asynchronous PostgreSQL catalog repository (`createPostgresCatalogRepository`) কে সরাসরি marketplace API-এর HTTP routes-এ সফলভাবে সংযুক্ত (integrate) করা হয়েছে:
- `GET /api/v1/categories` — শ্রেণী তালিকা
- `GET /api/v1/brands` — ব্র্যান্ড তালিকা
- `GET /api/v1/products` — পণ্য অনুসন্ধান (search), ক্যাটাগরি ও ব্র্যান্ড ফিল্টার, মূল্য ফিল্টার (`min_price`, `max_price`), সর্টিং (`price_asc`, `price_desc`, `newest`), এবং bounded pagination (`limit`, `offset`)
- `GET /api/v1/products/suggest` — লাইভ টাইপঅ্যাহেড সাজেশন
- `GET /api/v1/products/:id` — পণ্যের বিবরণ, ছবি, ভেরিয়েন্ট এবং রেটিং সারাংশ (অভ্যন্তরীণ বিক্রেতা তথ্য গোপন রেখে)
- `GET /api/v1/products/:id/reviews` — পণ্যের গ্রাহক রিভিউ তালিকা

## ২. আর্কিটেকচার ও বাস্তবায়নের বিবরণ
1. **Dependency Injection ও Adapter Pattern:**
   - `apps/api/src/routes_public.mjs`-এ `createSqliteCatalogRepository` এবং options-এর মাধ্যমে catalog repository ইনজেকশন সমর্থন করা হয়েছে।
   - ডিফল্ট মোডে বা লোকাল ডেভেলপমেন্টে SQLite রানটাইম সম্পূর্ণ সচল ও অক্ষত থাকে।
   - `apps/api/src/server.modular.mjs`-এ `createApiApp(options)` এক্সপোর্ট করা হয়েছে যা PostgreSQL database adapter দেওয়া হলে স্বয়ংক্রিয়ভাবে `createPostgresCatalogRepository` ইনজেক্ট করে।
2. **রেসপন্স প্যারিটি (Parity):**
   - SQLite এবং PostgreSQL উভয়েরই পাবলিক রেসপন্স শেইপ (পয়সা থেকে BDT রূপান্তর, ইন-স্টক স্ট্যাটাস, সর্টিং নিয়মাবলি) এক রাখা হয়েছে।

## ৩. টেস্ট কভারেজ ও যাচাইকরণ
- `tests/postgres-catalog-routes.test.mjs`-এ নতুন টেস্ট সুইট তৈরি করা হয়েছে যা রুট লেভেলে categories, brands, product listing, search, filters, sorting, suggestions, product details, এবং reviews যাচাই করে।
- বিদ্যমান সব টেস্ট (`npm test` এবং `npm run check`) সহ মোট ৫৭টি টেস্ট সফলভাবে উত্তীর্ণ।

## ৪. অবশিষ্ট মাইগ্রেশন রিকোয়ারমেন্টস (Remaining API Migration Requirements)
পরবর্তী ধাপে প্রোডাকশন-রেডি হওয়ার জন্য নিচের রুট ও মডিউলগুলোতে পর্যায়ক্রমে কাজ বাকি রয়েছে:
1. **Authentication & Session:**
   - গ্রাহক ও বিক্রেতা রেজিস্ট্রেশন, লগইন, পাসওয়ার্ড হ্যাশিং ভেরিফিকেশন, সেশন ও ওটিপি টেবিল অপারেশনকে async PostgreSQL ট্রানজ্যাকশনে স্থানান্তর।
2. **Cart & Wishlist:**
   - Customer cart_items এবং wishlist রিড/রাইট অপারেশনকে async adapter-এ আনা।
3. **Checkout & Multi-Vendor Orders:**
   - ক্যাশ অন ডেলিভারি (COD) ও অনলাইন পেমেন্ট অর্ডার ক্রিয়েশন, স্টক লকিং (`SELECT FOR UPDATE`), ট্রানজ্যাকশনাল ডিডাকশন এবং সাব-অর্ডার জেনারেশন।
4. **Payments & Gateways:**
   - বিকাশ (bKash), নগদ (Nagad), কার্ড গেটওয়ে কলব্যাক হ্যান্ডলিং, সিগনেচার ভেরিফিকেশন, রিফান্ড ও রিভার্সাল।
5. **Seller Dashboard API:**
   - বিক্রেতা পণ্য তৈরি, বিবরণ/ছবি আপডেট, স্টক ও ইনভেন্টরি ম্যানেজমেন্ট, সাব-অর্ডার ফুলফিলমেন্ট (`SHIPPED`, `DELIVERED`), পেআউট রিকোয়েস্ট।
6. **Admin Dashboard API:**
   - পণ্য অনুমোদন/রিভিউ কিউ, বিক্রেতা অনুমোদন, গ্লোবাল অর্ডার স্ট্যাটাস ট্রানজিশন, ক্যান্সেলেশন স্টক রিস্টোর, রাজস্ব ও কমিশন লেজার অডিট ট্রেইল।
