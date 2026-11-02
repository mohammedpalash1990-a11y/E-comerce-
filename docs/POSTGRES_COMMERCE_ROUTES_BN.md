# PostgreSQL Commerce HTTP Routes — বাংলা নোট

## এই ব্যাচে কী যোগ হয়েছে

- `apps/api/src/postgres-checkout.mjs`: PR #38-এর transactional checkout repository বর্তমান `main`-এ port করা হয়েছে।
- `apps/api/src/postgres-orders.mjs`: parent-first locking-সহ seller order lifecycle repository বর্তমান `main`-এ port করা হয়েছে।
- `apps/api/src/postgres-commerce-routes.mjs`: PostgreSQL-only HTTP route registration:
  - Customer: checkout, নিজের order list, নিজের order cancellation
  - Seller: নিজের sub-order list, ownership-checked status update
  - Admin: order list, parent order status update
- `tests/postgres-commerce-routes.test.mjs`: role scopes, customer ownership, seller ownership, invalid transition এবং repository dispatch-এর route regression coverage।

## গুরুত্বপূর্ণ integration boundary

এই route module-টি ইচ্ছাকৃতভাবে legacy `server.modular.mjs`-এ import করা হয়নি। ওই server এখনো SQLite `core.mjs`-এর synchronous query/transaction contract-এ চলে। PostgreSQL route-গুলো কেবল isolated PostgreSQL HTTP composition root থেকে mount করতে হবে; SQLite server-এ mount করলে async repository semantics ও legacy route registration মিশে যাবে।

এই PR PostgreSQL HTTP route handlers প্রস্তুত করে, কিন্তু নিজে থেকে production server চালু করে না। পরবর্তী ধাপে isolated PostgreSQL server-এ auth, catalog, commerce routes একত্রে mount, payment callback/refund decision routes এবং real PostgreSQL integration test যুক্ত করতে হবে। COD default ছাড়া online gateway adapter configure না করলে checkout fail-closed থাকবে।

## নিরাপত্তা ও rollout

- Customer cancellation-এ authenticated customer ownership যাচাই করা হয়।
- Seller status transition-এর আগে seller sub-order ownership যাচাই করা হয়।
- Admin endpoints-এ `ADMIN` role scope বাধ্যতামূলক।
- Online payment gateway adapter না থাকলে checkout repository online payment প্রত্যাখ্যান করে।
- Existing SQLite storefront/API অপরিবর্তিত; production fail-closed guard সরানো হয়নি।
- কোনো merge বা deployment করা হয়নি।
