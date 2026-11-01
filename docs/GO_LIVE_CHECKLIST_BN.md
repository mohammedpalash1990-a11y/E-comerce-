# HAAT release checklist (বাংলা)

## A. Frontend
- [ ] Storefront, seller এবং admin page HTTPS-এ load হয়।
- [ ] Seller/admin login form-এ কোনো demo password prefilled নেই।
- [ ] Product title, seller name, customer name এবং address untrusted HTML হিসেবে render হয় না।
- [ ] Mobile layout, cart quantity এবং empty states পরীক্ষা করা হয়েছে।

## B. API / infrastructure
- [ ] Node.js API আলাদা Node host-এ চলছে; GitHub Pages-কে API host হিসেবে ব্যবহার করা হয়নি।
- [ ] `GET /health` healthy response দেয়।
- [ ] `HAAT_API_BASE`-এ API origin দেওয়া আছে; শেষে `/api/v1` যোগ করা হয়নি।
- [ ] `CORS_ORIGINS`-এ শুধু অনুমোদিত HTTPS origin আছে।
- [ ] Persistent database/storage, backups এবং restore test সম্পন্ন।
- [ ] Production PostgreSQL adapter ও migrations বাস্তবে চালিয়ে যাচাই করা হয়েছে।

## C. Security / business operations
- [ ] Demo seed accounts এবং sample credentials production থেকে বাদ।
- [ ] Password reset, OTP, session expiry/revocation এবং rate-limit behaviour পরীক্ষা।
- [ ] Payment webhook signature, idempotency এবং refund reconciliation পরীক্ষা।
- [ ] Courier sandbox থেকে production credentials-এ যাওয়ার আগে provider approval সম্পন্ন।
- [ ] Seller KYC, payout approval, refund এবং audit trail বাস্তব scenario-তে পরীক্ষা।
- [ ] Privacy, consumer protection, tax এবং support process review সম্পন্ন।

## D. Go-live gate
- [ ] CI, API integration tests এবং browser E2E সব pass।
- [ ] Security review / penetration test সম্পন্ন।
- [ ] Monitoring, alerting, incident response এবং rollback plan প্রস্তুত।

**এই checklist-এর সব production gate পূরণ না হওয়া পর্যন্ত HAAT-কে production-ready বলা যাবে না।**
