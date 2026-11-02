# Storefront search accessibility increment — 2026-11-02

## Scope
A small customer-facing improvement was made directly to the canonical root `index.html`. Existing HAAT Midnight Charcoal / Champagne Gold visual styling and cart/API behavior were preserved.

## Changes
- Search is exposed as a named `role=search` region with an accessible input label and result-list relationship.
- Result count is a polite, atomic live region for assistive technology.
- Bengali and English product names remain searchable; Unicode NFKC and repeated whitespace are normalized.
- Category buttons expose selected state with `aria-pressed`.
- Escape clears search and returns to all products.
- A zero-result state offers a keyboard-accessible “সব পণ্য দেখুন” recovery action.
- Product add-to-cart controls have product-specific accessible names.
- Existing product catalogue, cart storage and checkout demo behavior remain unchanged.

## Verification
- `node --check` on the extracted inline storefront script: PASS.
- `node --test tests/storefront-search.test.mjs`: 6/6 PASS.
- Full `npm test` / `npm run check` are expected to run in CI after this PR is opened.

## Boundaries
This increment changes only the storefront search experience. It does not add backend search, real orders, live payments, courier integration, deployment, or production readiness.
