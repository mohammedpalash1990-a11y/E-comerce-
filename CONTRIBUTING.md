# Contributing

1. Create a feature branch from `main`.
2. Keep currency amounts in integer paisa; never use floating-point values for persisted money.
3. Validate all request payloads server-side and enforce role-based authorization in the API.
4. Add or update tests for every business rule.
5. Run `npm run check` before opening a pull request.
6. Never commit secrets, real customer information, database files or production credentials.

Use conventional commit messages, e.g. `feat(checkout): validate delivery address`.
