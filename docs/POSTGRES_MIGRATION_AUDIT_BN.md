# PostgreSQL Runtime Migration Audit (বাংলা)

**অডিটের ভিত্তি:** `main` branch-এর বর্তমান API source; ১ নভেম্বর ২০২৬। এটি static source audit, runtime compatibility test নয়।

## বর্তমান অবস্থা

- API runtime এখনও `node:sqlite`-এর `DatabaseSync` ব্যবহার করে।
- `core.mjs`-এ database open, PRAGMA, migration এবং transaction সব synchronous।
- Route handler-গুলো `q(sql).get/all/run(...)` synchronous return value ধরে কাজ করে।
- `tx(fn)`-এর callback synchronous; PostgreSQL driver-এর async query/transaction contract-এর সঙ্গে এটি সরাসরি compatible নয়।
- `server.modular.mjs`-এ session lookup-ও synchronous।
- Root `package.json`-এ PostgreSQL driver dependency নেই; repository root-এ npm lockfile-ও নেই।
- Production startup guard ইচ্ছাকৃতভাবে বন্ধ রাখা হয়নি। PostgreSQL adapter বাস্তবায়িত ও যাচাই না হওয়া পর্যন্ত production startup block থাকবে।

## Static call-site inventory

নিচের সংখ্যা source text-এ call-pattern গণনা; এগুলো unique query বা endpoint-এর সংখ্যা নয়।

| Module | `q(...)` call pattern | `tx(...)` call pattern |
|---|---:|---:|
| `core.mjs` | 4 | 1 |
| `server.modular.mjs` | 3 | 0 |
| `orders.mjs` | 34 | 1 |
| `routes_customer.mjs` | 43 | 4 |
| `routes_public.mjs` | 38 | 5 |
| `routes_seller.mjs` | 33 | 6 |
| `routes_admin.mjs` | 77 | 8 |
| `routes_payments.mjs` | 10 | 1 |
| `seed.mjs` | 7 | 0 |
| **মোট** | **249** | **26** |

আরও migration-sensitive pattern:
- `core.mjs`-এ `db.prepare` 2টি এবং `db.exec` 7টি occurrence (migration ও PRAGMA সহ)।
- Route/module source-এ `.changes` property ব্যবহারের 9টি occurrence আছে; PostgreSQL result-এর `rowCount` semantics অনুযায়ী প্রতিটি callsite যাচাই করতে হবে।
- পূর্ববর্তী compatibility pass-এ চিহ্নিত `rowid` ও `INSERT OR IGNORE` pattern বর্তমান audited modules-এ নেই। এটি সম্পূর্ণ PostgreSQL compatibility প্রমাণ করে না।

## Migration blockers এবং করণীয়

1. **Async boundary:** `q().get/all/run`-এর প্রতিটি caller-কে async/await-এ রূপান্তর করতে হবে; route handler, helper, seed ও auth/session lookup-ও অন্তর্ভুক্ত।
2. **Transaction boundary:** `tx(fn)`-কে checked-out PostgreSQL client-ভিত্তিক async transaction করতে হবে। একই transaction-এর সব query-কে একই client ব্যবহার করাতে হবে; callback error হলে rollback নিশ্চিত করতে হবে।
3. **Result contract:** `changes`-এর বদলে PostgreSQL `rowCount`, এবং insert ID-এর জন্য explicit `RETURNING id` ব্যবহার/পরীক্ষা করতে হবে। বর্তমান `lastInsertRowid` shim-কে insert ID-এর নির্ভরযোগ্য বিকল্প ধরা যাবে না।
4. **SQL dialect:** placeholders, conflict handling, boolean/integer differences, date/time, JSON, aggregate return types এবং migration DDL যাচাই করতে হবে।
5. **Numeric safety:** PostgreSQL `BIGINT` driver থেকে string হতে পারে। paisa/stock/count arithmetic-এ safe integer boundary ও serialization policy স্থির করতে হবে।
6. **Migration/seed:** SQLite schema migration ও PostgreSQL migration আলাদা থাকবে; PostgreSQL migration direct (non-pooled) connection দিয়ে versioned ও idempotentভাবে চালাতে হবে।
7. **Verification:** unit + API + end-to-end tests PostgreSQL branch-এ চালাতে হবে; concurrent stock deduction, duplicate payment callback, order cancellation/refund, seller balance এবং transaction rollback-এর integration tests বাধ্যতামূলক।
8. **Production gate:** উপরোক্ত সব যাচাই সফল না হওয়া পর্যন্ত production guard অপরিবর্তিত থাকবে।

## নিরাপদ বাস্তবায়ন ক্রম

- ধাপ A: PostgreSQL query/transaction adapter এবং test harness তৈরি; SQLite test runtime সচল রাখা।
- ধাপ B: public catalog + auth/session read paths async-এ migrate করা।
- ধাপ C: customer cart/checkout/order creation ও stock locking migrate করা।
- ধাপ D: seller/admin/payment/refund flows migrate করা।
- ধাপ E: production-like Neon validation branch-এ migration ও concurrency tests চালানো।
- ধাপ F: deployment configuration, health checks, backup/restore drill এবং go-live checklist সম্পন্ন করে তবেই production gate পরিবর্তনের সিদ্ধান্ত।

**সিদ্ধান্ত:** বর্তমান codebase-এ শুধু `pg` dependency যোগ করা বা `DATABASE_URL` সেট করলেই PostgreSQL runtime চালু হবে না। এটি একটি cross-cutting async migration; ধাপে ধাপে test-সহ করতে হবে।
