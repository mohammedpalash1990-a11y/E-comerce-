# PostgreSQL runtime hardening — test batch (বাংলা)

এই পরিবর্তন async PostgreSQL adapter-কে production-ready ঘোষণা করে না। এটি adapter ও SQL compatibility helper-এর failure-path regression coverage বাড়ায়। বর্তমান synchronous SQLite route handler অপরিবর্তিত।

## এই ব্যাচে সম্পন্ন ১০টি hardening check

1. Invalid pool configuration — query/connect interface না থাকলে adapter তৈরি হবে না।
2. Invalid SQL input — empty বা non-string SQL pool-এ পৌঁছাবে না।
3. Bind-count validation — placeholder ও parameter count না মিললে database round-trip হবে না।
4. Nested transaction success — savepoint release হবে, outer transaction অকাল commit হবে না।
5. Nested transaction failure — savepoint rollback ও release হবে।
6. Outer rollback propagation — nested savepoint সফল হলেও outer failure পুরো transaction rollback করবে।
7. Synchronous callback result — callback-এর return value commit-এর পর ফেরত আসবে।
8. BEGIN failure cleanup — connection checkout হলে BEGIN ব্যর্থ হলেও client release হবে।
9. COMMIT failure recovery — commit ব্যর্থ হলে rollback চেষ্টা করে client release হবে।
10. Savepoint uniqueness — একই outer transaction-এ sequential nested transaction আলাদা savepoint নাম পাবে।

## অতিরিক্ত SQL parser regression

PostgreSQL nested block comment (`/* ... /* ... */ ... */`) এখন সঠিকভাবে track করা হয়। Comment-এর ভিতরের `?` placeholder হিসেবে গণনা হয় না; comment শেষ হওয়ার পরের placeholder স্বাভাবিকভাবে `$1`, `$2`-তে রূপান্তরিত হয়।

## যাচাই

```bash
node --test tests/postgres-runtime.test.mjs tests/postgres-sql.test.mjs
npm run check
```

## সীমাবদ্ধতা ও release gate

- Route modules এখনো synchronous SQLite API ব্যবহার করে; async PostgreSQL adapter route layer-এ wired নয়।
- এই test batch fake pg-compatible pool ব্যবহার করে; Neon বা অন্য live PostgreSQL database-এ integration test নয়।
- Payment, inventory concurrency, idempotency, webhook signature/replay, connection-pool saturation এবং production observability আলাদা যাচাই দাবি করে।
- Production startup safety guard এবং canonical customer storefront / seller-admin UI অপরিবর্তিত রাখতে হবে।
- Production enablement-এর আগে route-by-route async repository conversion, real PostgreSQL integration suite, migration rehearsal এবং deployment rollback test আবশ্যক।