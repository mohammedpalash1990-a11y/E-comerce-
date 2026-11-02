# Storefront search accessibility increment — 2026-11-02

## Scope
This increment builds on the latest canonical root `index.html`, preserving the existing HAAT visual direction and the accessibility work already present on `main` (skip link, named search form, category state, cart dialog and focus handling).

## Changes
- Normalize Unicode NFKC and repeated whitespace for more predictable bilingual search.
- Keep Bengali and English product-name matching case-insensitive.
- Announce the product result count through a polite, atomic live region.
- Escape clears the active search and returns to all products without interfering with the cart-dialog Escape behavior.
- Show a full-width zero-result state with a keyboard-accessible “সব পণ্য দেখুন” recovery action.
- Add product-specific accessible names to add-to-cart controls.

## Verification
- Added six focused Node tests in `tests/storefront-search.test.mjs`.
- Full project test and browser CI must pass on the exact PR head before merge.

## Boundaries
This is a frontend search/accessibility increment only. No backend search, real order creation, live payment, courier integration, deployment or production-readiness claim is made.
