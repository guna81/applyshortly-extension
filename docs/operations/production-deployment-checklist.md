# Production release checklist

Run this checklist before merging to `main` or publishing a new Chrome Web Store package from `applyshortly-extension`.

## 1. Pre-release code and contract checks

- [ ] Review `git status` and `git diff` on `develop` — confirm no credentials, local settings, personal data, backend code, or private history are included.
- [ ] If API endpoints changed, confirm `extension-bridge/openapi.json`, `extension-bridge/client.ts`, and `extension/src/shared/bridge.ts` are in sync with the platform.
- [ ] If `extension/src/shared/agent-rules.json` changed, regenerate `extension/src/shared/agent-rules.js` with `python3 scripts/agent_rules.py`.
- [ ] Run full extension checks:
  ```sh
  npm run check
  ```
  Confirm `agent_rules.py --check`, `npm test` (unit + Tier 0 replay), `tsc` typecheck, and packaging tests all pass.

## 2. Platform integration and testbed gate (every release)

Run these in the sibling platform checkout (`../apply-assistant`) with `EXTENSION_REPO` pointing here:

- [ ] Sync compiled page scripts if `profile-answer.ts`, `dom.ts`, or `page.ts` changed (`make extension-sync-page`).
- [ ] Rebuild the server `browser-runner` agent bundle if shared agent or `page-control/` code changed (`node scripts/compile_server_bundle.mjs ../apply-assistant/browser-runner/agent-bundle`), then run `npm run build && npm test` in `../apply-assistant/browser-runner`.
- [ ] Refresh `extension.lock.json` (`python3 scripts/extension_checkout.py --lock`) and confirm platform backend CI (`make ci-backend`) passes.
- [ ] Run **Tier 1 synthetic** testbed (all local fixtures, `--surface extension`) — confirm **0 safety failures** and **no regressions**.
- [ ] Run **Tier 2 live regression** (`Live regression — 5 forms`) on **both surfaces** (`--surface extension` and `--surface in_app` against the rebuilt `browser-runner`) with `--engine auto --model real` (plus `rules_led` / `ai_led` when changing engine-specific code) — confirm **5/5 passed**, **0 safety failures**, **0 repeated questions**, **0 provider errors**, and **no regressions**.
- [ ] *(When changing `page-control/` or widget handling)* Run the platform Chromium browser fixtures (`make ci-browser`).

## 3. Merge and publish order

1. [ ] Commit reviewed changes on `develop` in `applyshortly-extension`.
2. [ ] Merge `develop` → `main` and push `main` **before** merging/pushing coordinated changes in the platform repository.
3. [ ] In the platform repository, refresh `extension.lock.json` to the pushed extension commit before pushing platform `main`.

## 4. Chrome Web Store package (when cutting a new store version)

- [ ] Bump the version in `extension/manifest.json` and `package.json`.
- [ ] Build the release and contributor archives:
  ```sh
  npm ci
  npm run check
  npm run build -- --platform-url https://applyshortly.com
  npm run build:source -- --platform-url https://applyshortly.com
  ```
- [ ] Verify `dist/applyshortly-extension-<version>.zip` contains only allowlisted runtime assets and the public origin.
- [ ] Review permissions, store copy ([extension-store-auto-apply.md](extension-store-auto-apply.md)), and privacy disclosures ([extension-privacy-policy.md](../security/extension-privacy-policy.md)).
- [ ] Upload the ZIP to item `pdeffhelbeobnpcbjdegddcfimglmedd` (see [extension-publishing.md](extension-publishing.md)).
- [ ] After approval/install, smoke-test sign-in, disconnect, and autofill on a local/demo test form (never submit a real job application).
