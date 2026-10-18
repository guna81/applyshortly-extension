# Contributing

Install Node.js 22+ and Python 3.10+, then run `npm ci`. Before submitting a change, run `npm run check` and `npm run build`. Add focused regression tests when changing behavior.

Keep `extension/src/bridge.js` consistent with `extension-bridge/client.ts`. Coordinate API changes with the platform and regenerate `extension-bridge/openapi.json` from its exported spec rather than editing the snapshot.

The extension fills forms for review and clicks Submit only after explicit Auto apply and a cancellable countdown. Preserve review steps, account isolation, credential handling in the background worker, and confirmation requirements for submitted events. Do not add LinkedIn automation or Google scraping. Use fake credentials and local form fixtures in tests.

Never include personal profiles, resumes, screenshots of real applications, API keys, cookies or local configuration in issues or pull requests. Describe reproduction steps with synthetic data.

Code is MIT licensed; forks should follow the branding guidance in `BRANDING.md`.

## Working across repositories

Use sibling checkouts named `apply-assistant/` and `applyshortly-extension/`. Open `applyshortly.code-workspace` from the platform root, or add both folders to the same editor project. Each repository has separate Git status, instructions and validation commands.

Develop extension changes here; the platform owns server endpoints and its generated API
snapshot. Coordinate API changes as described in [AGENTS.md](AGENTS.md#working-with-the-platform).
The platform consumes a separate checkout and verifies reviewed integration file hashes in
`extension.lock.json`. Update that lock after validating coordinated changes and publish the
extension changes before the platform change. Browser integration tests remain in the platform.

Never copy private platform code, credentials, personal data or private history into this repository. Contributors working only on the extension can use the trusted API snapshot without access to the platform checkout.
