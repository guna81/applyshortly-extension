# Contributor guide for coding agents

Check `git status --short` before editing and preserve existing work. Read the implementation and nearby tests before changing behavior.

## Working with the platform

This repository is the development home for the public extension. The sibling
`../apply-assistant` repository owns the private platform, backend API and generated API subset.
Open `../apply-assistant/applyshortly.code-workspace` to work with both repositories and read
its instructions before editing platform files. Keep the repositories' histories separate.

For API changes, generate the subset in the platform with `make gen-client`, review and copy
only `extension-bridge/openapi.json` here, and update both handwritten clients. Run the
standalone checks and the platform browser fixtures. The platform's `extension.lock.json`
pins integration file hashes; after reviewing coordinated changes, refresh it with
`python3 scripts/extension_checkout.py --lock` in the platform. Publish the extension changes
before platform CI consumes them. The lock's ref can be set to the published immutable commit;
content verification is required even when the ref is a branch.

Never include private backend code, the full frontend spec, local configuration, personal
data, credentials or private history. There is no automatic synchronization.

Runtime code is in `extension/src/`; tests are in `extension/test/`. Keep the JavaScript and TypeScript bridge clients consistent. Generate the OpenAPI subset using `scripts/extension_openapi.py` from a trusted platform spec.

Run `npm run check` and `npm run build` for relevant changes. Browser integration coverage lives in the platform repository; do not describe unit checks as browser validation.

Preserve user-chosen submission (the user clicks the site's Submit, or explicitly chooses Auto apply, which submits only when every required field is answered and after a cancellable countdown; clicking Apply in ApplyShortly for a job board chooses it through a one-time code the extension claims once), confirmation evidence, per-account isolation, and background-only credential access. Never commit credentials, local settings, real application data, resumes or private repository history. Do not introduce Google scraping. Job boards (LinkedIn, Naukri, Indeed, …) are filled only by the form agent in a tab the user started it in, one job at a time: no bulk or background job-board automation, never solve CAPTCHAs, and the agent itself never clicks a final Submit.

Autopilot windows (`src/background.js`, `autopilot*`) open only a link the platform returned from `/autopilot/next`, with its one-time code, only with the user's setting on, one at a time and never for a job board (the platform doesn't offer them; the extension also never opens a non-http(s) link). They are unattended, so they never start the form agent or AI drafting, never send an answer marked for checking, stop on a sign-in page, and close only the tab they opened, after the submit attempt. Keep it that way.
