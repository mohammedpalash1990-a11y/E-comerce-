# Canonical storefront browser-test scope

The browser suite deliberately serves the repository-root `index.html`, the canonical standalone HTML frontend demo. It does not silently substitute `apps/web/public/index.html` or a backend-rendered page.

## Covered by the current Playwright batch

- Homepage title, Bangla-first hero, and eight demo catalog cards.
- English and Bangla text search, no-results state, category filtering, and combined filters.
- Add-to-cart, quantity increase/decrease, empty-cart state, and totals.
- Cart persistence across reloads and isolation between browser contexts.
- Explicit demo-only checkout messaging; verifies that no `/api/*` order request is sent.
- Mobile two-column and desktop four-column catalog layout.

## Not implemented by the canonical standalone demo yet

The root `index.html` currently contains only an in-memory sample product catalog and a localStorage demo cart. It does not implement product-detail pages, customer registration/login/session APIs, real checkout/payment, customer order history/tracking, seller dashboard flows, or admin dashboard flows. The seller/admin portal links are placeholders and must not be treated as working role-protected routes.

Those flows are intentionally not represented as passing browser tests. They need actual screens and confirmed backend API contracts before they can be added as real integration tests. The existing Node API end-to-end suite remains separate and does not prove that the standalone HTML demo is connected to the API.
