# Security Policy

This repository is a development MVP. Do not use it to process real customer information or payments until a security review is complete.

- Never commit secrets or production credentials.
- Rotate all demo passwords and JWT secrets before deployment.
- Report vulnerabilities privately to the repository owner; do not publish exploit details in an issue.
- Required before production: rate limiting, brute-force controls, secure cookie/session strategy, CSRF review, dependency scanning, audit-log retention, encrypted backups, access review and penetration testing.


## Additional deployment safeguards
- The public storefront escapes product names before inserting server-provided catalogue data into HTML.
- Seller and admin demo credentials are not prefilled in login forms. Development credentials documented in README must never be reused on a hosted environment.
- Restrict `CORS_ORIGINS` to the exact trusted HTTPS origins; do not use wildcard origins for authenticated requests.
- GitHub Pages is a static preview only. Do not point it at a production API until the API has passed staging and security checks.
- The current SQLite and in-memory rate-limit/session implementation is not a production multi-instance architecture.
