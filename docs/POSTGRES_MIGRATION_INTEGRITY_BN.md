# PostgreSQL migration integrity (বাংলা)

## কী যোগ হয়েছে

- প্রতিটি নতুন PostgreSQL migration file-এর exact UTF-8 content থেকে SHA-256 checksum তৈরি হয়।
- Migration apply করার একই transaction-এ filename, applied timestamp এবং checksum সংরক্ষণ হয়।
- পরবর্তী startup-এ ইতোমধ্যে applied migration-এর checksum বর্তমান ফাইলের সঙ্গে মেলানো হয়।
- Applied migration edit হয়ে গেলে runner fail-closed করে; application silently continue করে না।
- পুরোনো schema_migrations টেবিলে checksum column না থাকলে nullable column additive ভাবে যোগ হয়।
- পুরোনো row-গুলোর checksum NULL রাখা হয় এবং unverifiedLegacy তালিকায় দেখানো হয়। বর্তমান ফাইলকে পুরোনো applied content বলে ভুল করে certify করা হয় না।

## কেন এটি গুরুত্বপূর্ণ

একটি applied migration পরে edit করলে নতুন environment ও পুরোনো environment আলাদা schema পেতে পারে। Checksum drift detection সেই ঝুঁকি startup-এই প্রকাশ করে। Schema পরিবর্তন দরকার হলে পুরোনো migration edit না করে নতুন forward-only migration যোগ করতে হবে।

## Verification

```bash
node --test tests/postgres-migrations.test.mjs
npm run check
```

## সীমাবদ্ধতা

- Legacy migration-গুলোর historical checksum আগে সংরক্ষিত ছিল না; তাই সেগুলো retroactively verify করা সম্ভব নয়।
- এটি migration runner-এর integrity guard; PostgreSQL runtime adapter এখনো route layer-এ wired নয়।
- Production startup guard সরানো হয়নি এবং live database migration স্বয়ংক্রিয়ভাবে চালানো হয়নি।
