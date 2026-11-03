# HAAT Platform Ownership & Security Boundary

**Status:** Architecture requirement / implementation checklist
**Product owner:** HAAT platform owner (the repository owner)
**Scope:** Single centrally operated marketplace. Customers may shop; approved sellers may sell inside HAAT. This is not a white-label marketplace builder or self-service SaaS.

## 1. Product ownership model

- HAAT is one platform controlled by its platform owner.
- Public visitors may browse the public catalogue and register only as customers.
- Seller registration is an application, not automatic seller activation. Every seller must remain pending until an authorized HAAT administrator approves the application.
- No public endpoint, UI action, invitation flow, or customer account may create a new marketplace, tenant, platform owner, super-admin, or independent admin workspace.
- A seller account is a merchant operating inside HAAT. It does not own the platform, its domain, source code, customer database, payment credentials, commission policy, or other sellers' data.
- Platform ownership must never be inferred from a submitted role, request body, query parameter, local-storage value, email/phone match, or client-side flag.

## 2. Authorization rules (server-side only)

| Actor | Allowed | Explicitly denied |
|---|---|---|
| Guest | Read public/active catalogue; start customer registration | Admin/seller workspace, marketplace creation, private customer/order data |
| Customer | Own profile, addresses, cart, wishlist, reviews and orders | Seller/admin endpoints, other customers' data, seller onboarding approval |
| Applicant | Own application status and permitted onboarding steps | Product publishing, seller finance, fulfilment, seller approval |
| Approved seller | Own shop, own products, own inventory, own seller-orders, own settlements | Other sellers' records, platform settings, admin actions, commission policy |
| HAAT admin | Platform-wide operations according to explicit admin permissions | Secret disclosure, arbitrary privilege escalation, unaudited destructive actions |

Every protected handler must authenticate from a server-validated session and authorize the actor against the database on every request. Hiding a button in the browser is not authorization.

## 3. Platform-owner bootstrap

- Production must start only with a deliberate, one-time owner bootstrap or a securely provisioned owner account.
- The bootstrap secret must be high entropy, supplied through the deployment secret manager, never committed, never returned by an API, and invalidated after successful bootstrap.
- Public registration must never accept `ADMIN`, `OWNER`, `SUPER_ADMIN`, arbitrary roles, permission arrays, or tenant/platform identifiers.
- No public endpoint may promote a user to admin or transfer platform ownership.
- Owner/admin creation, permission changes, seller approvals, commission changes, payment settings, refunds and payouts must create immutable audit events.
- Recovery of the owner account must use a separately secured operational process, not a public signup or password-reset shortcut.

## 4. Tenant and data isolation

HAAT is one marketplace, but seller data is scoped by the authenticated seller identity:

- Derive `seller_id` from the authenticated server-side user/session; never trust a seller ID supplied by the browser for ownership.
- Scope product, inventory, seller-order, shipment, payout and finance queries by that identity.
- Admin-wide reads/writes require an explicit admin permission check.
- Customer addresses, carts, wishlists, reviews and orders must be scoped to the authenticated customer.
- Cross-seller and cross-customer IDOR tests are mandatory for every object endpoint.
- Database constraints and transactions must preserve ownership and ledger invariants; UI filtering alone is insufficient.

## 5. Deployment and intellectual-property controls

- Keep production source, deployment configuration, environment files, database credentials, signing keys, payment secrets and admin bootstrap material out of public artifacts.
- Prefer a private source repository and restricted collaborator access for production code. Before changing repository visibility, verify the hosting plan and deployment pipeline: a visibility change can affect public preview hosting and external automation.
- Deploy the API only to HAAT-controlled infrastructure and approved HAAT domains. Enforce an exact origin allowlist; CORS is not an authentication mechanism.
- Do not ship database credentials, payment secrets, commission rules, privileged API keys or admin bootstrap values in web/mobile bundles.
- Use server-side domain/installation policy for privileged operations. A copied frontend must not be able to create a functioning second marketplace without HAAT-controlled backend credentials and authorization.
- Add a clear proprietary license / copyright notice after legal review. A public repository without a suitable license does not by itself guarantee that the source cannot be copied.
- Use dependency and secret scanning, protected main branch, required CI, least-privilege tokens, encrypted backups, restore drills and security monitoring.

**Important limitation:** Browser-delivered HTML/CSS/JavaScript can be copied. No technical control can guarantee that nobody screenshots, copies, or recreates the public-facing interface. The security boundary must protect the backend, data, domain, credentials, privileged operations and legal ownership—not promise impossible copy prevention.

## 6. Required security tests before production

- Customer signup cannot request or receive privileged roles by manipulating request fields.
- Seller signup always creates a pending application; a seller cannot publish or fulfil before approval.
- A seller cannot read or mutate another seller's products, stock, orders, shipments, balances or payouts by changing IDs.
- A customer cannot read or mutate another customer's profile, addresses, cart, wishlist or orders.
- Customer and seller tokens receive 403 on admin and platform-owner routes.
- No public route can create a tenant/marketplace, owner, admin, or transfer ownership.
- Admin permission changes, seller approvals, commission changes and financial decisions are audited.
- Production startup fails closed if owner bootstrap, session secrets, trusted origins, database configuration, or required security controls are missing.
- Rate limiting must be shared across API instances (not only in-memory).
- Run dependency, secret, static-analysis, API authorization, browser E2E and independent penetration tests.

## 7. Release gates

Do not call HAAT production-ready until:
1. PostgreSQL-only runtime and all customer/seller/admin/commerce routes are composed without SQLite/seed fallback.
2. Migrations and integration/concurrency tests pass against a disposable PostgreSQL database.
3. The authorization and ownership tests above pass.
4. Production secrets, restricted repository access, approved domain, TLS, backups and monitoring are configured.
5. Payment/courier integrations and webhook signatures are verified in provider sandboxes and then in controlled production readiness tests.
6. A security review and restore/incident-response rehearsal are complete.

## 8. Current implementation note

This document records the required product boundary; it is not proof that every control has already been implemented. The existing README correctly describes the project as an active MVP and not production-ready. Each control must be implemented and verified in code/tests before launch.
