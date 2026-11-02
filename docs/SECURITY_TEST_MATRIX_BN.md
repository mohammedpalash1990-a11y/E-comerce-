# HAAT authorization regression matrix (বাংলা)

এই নথি `tests/security-boundaries.test.mjs`-এর automated regression coverage ব্যাখ্যা করে। এটি source-level এবং local SQLite integration test; penetration test বা production certification নয়।

## এই test batch-এ যাচাই

| Trust boundary | Expected behaviour | Automated check |
|---|---|---|
| HTTP response hardening | nosniff, frame denial, no-referrer | `/health` response headers |
| CORS allowlist | configured HTTPS origin accepted | allowed preflight returns 204 |
| CORS rejection | unknown origin receives no CORS grant | denied preflight returns 403 |
| Authentication | customer/seller/admin protected routes require a session | missing token returns 401 |
| Role authorization | customer cannot enter admin/seller routes; seller cannot enter customer/admin routes | wrong role returns 403 |
| Seller product isolation | seller sees only their own products | second seller receives empty list / 404 for foreign product |
| Seller sub-order isolation | seller cannot read or transition another seller's sub-order | foreign sub-order returns 404 |
| Customer order privacy | customer cannot read, track or cancel another customer's order | foreign order returns 404 |
| Admin visibility | authorized admin can see the customer order | admin order queue includes the order |

## Run

```bash
npm test
npm run check
```

## Remaining security work (not covered by this batch)

1. PostgreSQL-backed integration and concurrent transaction tests are still required before production.
2. Payment webhook replay, signature, amount mismatch and duplicate callback cases need provider-like integration tests.
3. Rate-limit behaviour needs deterministic clock/isolated-IP tests and a distributed store before multi-instance deployment.
4. Session rotation, expiry and revocation need explicit expiry-boundary tests.
5. Upload scanning, object storage permissions, CSP and production TLS configuration require deployment-level verification.
6. A third-party security review and privacy/legal review remain release gates.

**Release rule:** passing this file does not make HAAT production-ready. Keep the production startup guard until PostgreSQL runtime, all role workflows, provider integrations and operational controls are independently verified.
