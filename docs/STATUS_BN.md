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

## PostgreSQL compatibility groundwork (২০২৬-১১-০১)
- API route SQL থেকে SQLite-specific `rowid` ordering সরিয়ে deterministic `created_at + id` ordering করা হয়েছে।
- `INSERT OR IGNORE`-এর বদলে portable `ON CONFLICT DO NOTHING` ব্যবহার করা হয়েছে।
- Product price filter-এর scalar SQLite `MIN(a,b)` expression portable SQL `CASE`-এ বদলানো হয়েছে।
- `tests/postgres-compat.test.mjs`-এ এসব regression guard যোগ করা হয়েছে।
- এগুলো PostgreSQL migration সহজ করে, কিন্তু database adapter এখনো SQLite; তাই এগুলোকে PostgreSQL runtime support বলা যাবে না।

## Storefront preview UX সংশোধন (২০২৬-১১-০১)
- API offline থাকলে storefront আর hard-coded ৮টি নমুনা পণ্যকে live inventory হিসেবে দেখায় না; পরিষ্কার offline/preview বার্তা ও retry control দেখায়।
- পণ্য ও category API থেকে একসঙ্গে লোড হয়; cart-এর localStorage key versioned করা হয়েছে।
- Seller এবং Admin পেজে সবসময় দৃশ্যমান `/health` endpoint status থাকে; Admin Console-এ dashboard KPI, pending seller approvals, product approvals ও product thumbnail দেখানো হয়।
- Seller product submission form-এ description ও HTTPS image URL যোগ করা হয়েছে; seller list এবং customer storefront-এ image preview দেখায়।
- নতুন frontend regression test যোগ হয়েছে; CI pass করেছে।

## Neon PostgreSQL প্রস্তুতি (২০২৬-১১-০১)
- Neon project `haat-bangladesh` তৈরি হয়েছে (PostgreSQL 17, Singapore region); database `haat`।
- মূল `main` branch-এ PostgreSQL schema `001_init.sql`, index migration `002_indexes.sql` ও category seed migration `003_seed_categories.sql` প্রয়োগ করা হয়েছে; ২৪টি application table, ৪৫টি index ও ৩টি migration record যাচাই করা হয়েছে। ৮টি প্রাথমিক marketplace category-ও idempotent migration দিয়ে seed করা হয়েছে।
- আলাদা `haat-schema-validation` branch-এও schema যাচাইয়ের জন্য migration চালানো হয়েছে।
- এটি কেবল database schema provisioning; API এখনো `node:sqlite` synchronous API ব্যবহার করে। PostgreSQL runtime adapter, route-level async conversion, seed compatibility ও end-to-end tests সম্পন্ন না হওয়া পর্যন্ত production API deploy করা যাবে না।


## PostgreSQL async adapter groundwork (২০২৬-১১-০১)
- `apps/api/src/postgres-runtime.mjs`-এ pg-compatible Pool-এর জন্য async `q().get/all/run` facade, transaction-scoped client routing, nested savepoint এবং rollback/release handling যোগ হয়েছে।
- `apps/api/src/postgres-migrations.mjs`-এ session advisory lock-সহ ordered, versioned migration runner যোগ হয়েছে; বিদ্যমান Neon `schema_migrations.applied_at TEXT` schema-র সঙ্গে সামঞ্জস্য রাখতে explicit ISO timestamp লেখা হয়।
- `apps/api/src/postgres-types.mjs`-এ PostgreSQL BIGINT-কে JavaScript safe-integer সীমার মধ্যে parse করার helper যোগ হয়েছে; overflow হলে error দেয়।
- Fake Pool-ভিত্তিক test-এ query binding, transaction isolation, nested savepoint, rollback, migration ordering/idempotence/failure, এবং BIGINT parsing যাচাই করা হয়েছে। GitHub Actions-এর test ও build check সর্বশেষ যাচাইকৃত adapter commit-এ pass করেছে।
- **সীমাবদ্ধতা:** এই adapter এখনো `core.mjs` বা API server-এ wired নয়; route-গুলোর ২৪৯টি synchronous query call pattern ও ২৬টি synchronous transaction call pattern async conversion চায়। তাই production guard অপরিবর্তিত এবং PostgreSQL production runtime এখনো চালু নয়।
- বিস্তারিত: `docs/POSTGRES_MIGRATION_AUDIT_BN.md` এবং `docs/POSTGRES_RUNTIME_ADAPTER_BN.md`।


## PostgreSQL checkout ও inventory groundwork (২০২৬-১১-০২)
- `apps/api/src/postgres-checkout.mjs`-এ async PostgreSQL checkout repository যোগ হয়েছে: cart বা request item validation, duplicate product quantity aggregation, deterministic product-row locking (`FOR UPDATE`), server-side price calculation, conditional stock reservation (`UPDATE ... WHERE stock>=? RETURNING`), seller-wise sub-order split, commission calculation, payment row, cart cleanup, event/audit/notification hooks—সব এক transaction-এ।
- `tests/postgres-checkout.test.mjs`-এ COD checkout, stock reservation, duplicate line aggregation, insufficient stock rollback, online gateway missing guard এবং unapproved seller rejection-এর regression coverage যোগ হয়েছে।
- **সীমাবদ্ধতা:** repository এখনো `routes_customer.mjs`-এ wired নয়; বর্তমান customer checkout route SQLite-নির্ভর। Coupon validation, shipping calculation এবং online gateway integration adapter হিসেবে inject করতে হবে। এটি production PostgreSQL enable করার অনুমতি নয়; route integration ও live PostgreSQL transaction tests বাকি।

- `apps/api/src/postgres-orders.mjs`-এ PostgreSQL order lifecycle repository যোগ হয়েছে: parent-first row locking, seller sub-order status transition, cancellation-এ stock restore, delivered order-এর seller earning/commission ledger, COD payment capture, এবং paid order cancellation-এ capped refund request।
- `tests/postgres-orders.test.mjs`-এ cancellation idempotency, COD delivery ledger, paid online refund এবং invalid transition regression test যোগ হয়েছে।
- **সীমাবদ্ধতা:** order lifecycle repository-টিও এখনো SQLite-ভিত্তিক customer/seller/admin route-এ wired নয়; live PostgreSQL integration ও route migration বাকি।


## PostgreSQL OTP regression coverage (২০২৬-১১-০২)
- `tests/postgres-auth-boundaries.test.mjs`-এ valid OTP একবার consume, replay rejection, পাঁচটি failed attempt-এর ceiling এবং expired code-এর attempt counter অপরিবর্তিত থাকার regression coverage যোগ হয়েছে।
- Test harness বর্তমান repository contract অনুযায়ী OTP issuance-এর user-row lock এবং transaction statements-ও handle করে; এটি deterministic adapter test, live PostgreSQL concurrency proof নয়।
- Production startup fail-closed থাকবে; এই test coverage একা PostgreSQL production readiness প্রমাণ করে না।

## সর্বশেষ যাচাইকৃত অবস্থা — ২০২৬-১১-০৬

এই অংশটি উপরের পুরোনো PostgreSQL status নোটগুলোকে supersede করে।

- Neon project `haat-bangladesh`, database `haat`, Singapore region-এর main branch বর্তমানে reachable এবং ready।
- Read-only যাচাইয়ে PostgreSQL database-এ ২৭টি table এবং `schema_migrations`-এ ৭টি applied migration record পাওয়া গেছে: `001_init.sql`, `002_indexes.sql`, `003_seed_categories.sql`, `005_auth_integrity_indexes.sql`, `006_inventory_movements.sql`, `007_coupon_redemption_controls.sql`, `007_inventory_approval_queue.sql`। দুটি আলাদা `007_*` migration বর্তমানে ledger-এ আছে; ভবিষ্যৎ migration naming-এ unique sequence ব্যবহার করতে হবে।
- `008_workspace_query_indexes.sql` migration মূল Neon branch-এ এখনো apply করা হয়নি। এর ১৮টি index temporary Neon branch-এ তৈরি ও যাচাই করা হয়েছে; ১৮টিই valid এবং ১৪টি table cover করে। মূল database-এ প্রয়োগের আগে অনুমোদন প্রয়োজন।
- ৮টি category seed করা আছে। যাচাইয়ের সময় `products` ও `users` table-এ কোনো row ছিল না; তাই database-কে populated marketplace বা live customer database বলা যাবে না।
- আলাদা `apps/api/src/postgres-server.mjs` entrypoint PostgreSQL pool, migration runner, auth, catalog, customer, cart, coupon, seller/admin ও commerce route modules compose করে। `DATABASE_URL` এই explicit entrypoint-এ ব্যবহৃত হয়; default SQLite runtime আলাদা রাখা হয়েছে।
- PostgreSQL API-র production startup gate এখনো ইচ্ছাকৃতভাবে বন্ধ। Seller/admin, commerce, payment এবং sandbox courier route modules server-এ mounted; PR #106-এর seller courier workflow main-এ merged। কিন্তু real PostgreSQL HTTP/checkout/order/inventory flow-এর disposable-database verification, production payment/courier provider adapters, backup/restore drill এবং deployment security checks এখনো সম্পূর্ণ প্রমাণিত নয়। এই guard bypass করা যাবে না।
- Live PostgreSQL integration test-গুলো `POSTGRES_TEST_DATABASE_URL` ছাড়া skip হয়; সাধারণ CI pass-কে real Neon transaction/HTTP integration proof হিসেবে ধরা যাবে না।
- বর্তমান public link GitHub Pages-এর static preview; Render-এ Marketplace API service এখনো provision/deploy করা হয়নি। তাই public storefront preview-কে live order-taking marketplace হিসেবে ব্যবহার করা যাবে না।
- পরবর্তী P0: remaining PostgreSQL route parity ও real PostgreSQL HTTP checkout/order/inventory tests; এরপর customer/seller/admin browser flow integration, তারপর private staging deploy ও security review। Real payment/courier integration, production secrets, monitoring, backup/restore এবং launch acceptance এখনো বাকি।
