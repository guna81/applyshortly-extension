# Contributing

Install Node.js 22+ and Python 3.10+, then run `npm ci`. Before submitting a change, run `npm run check` and `npm run build`. Add focused regression tests when changing behavior.

Keep `extension/src/bridge.js` consistent with `extension-bridge/client.ts`. Coordinate API changes with the platform and regenerate `extension-bridge/openapi.json` from its exported spec rather than editing the snapshot.

The extension fills forms and leaves submission to the user. Preserve review steps, account isolation, credential handling in the background worker, and confirmation requirements for submitted events. Do not add LinkedIn automation or Google scraping. Use fake credentials and local form fixtures in tests.

Never include personal profiles, resumes, screenshots of real applications, API keys, cookies or local configuration in issues or pull requests. Describe reproduction steps with synthetic data.

Code is MIT licensed; forks should follow the branding guidance in `BRANDING.md`.
