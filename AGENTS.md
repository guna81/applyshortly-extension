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

The AI-led controller (`src/agent/loop.js`, `src/agent/cdp.js`) runs only when the platform negotiates protocol 2. It pauses locally on repeated page states or after sixty planning calls, follows only an application tab opened by its own recent click, and never clicks a final Submit. Keep `extension-bridge/` in sync with the platform and describe scripted tests as unit coverage, not real-model validation.

## Testing the AI-led engine on a live form

Unit tests (`npm test` on Node 22) do not show how the AI-led engine behaves on a real page. The platform
repo has a headless harness that runs the built `dist/extension` against a live form with no
Chrome reload (`scripts/live_extension/run.sh`, see `apply-assistant/docs/development/live-extension-testing.md`).
It spends AI credits, and it covers the agent loop and command layer only, not the panel chat:
panel behaviour (quick replies, message routing) is checked by `extension/test/panel-assistant.test.mjs`.
Rebuild with `python3 scripts/build_extension.py` before either, since Chrome and the harness run `dist/`.

## One command layer for both AI controllers

`extension/src/agent/commands.js` (`CommandRunner`) is the only place that guards and runs page
commands (stale observation, document change, user-edited or replaced control, password, unapproved
link; verified `type`/`select`/`check`, `fill_form`, `options`, `review`, delta replies). The AI-led
engine (`agent/loop.js`) and the external controller (`external-browser.js`) both call it; do not
copy its guards into a controller. Keep it in step with the platform's
`services/browser_commands.py`.

## External-assistant browser control exception

The external browser controller may open job-board tabs for an exact batch approved in the
extension, then accept application-only MCP commands sequentially. It makes no AI calls.
Submission is a separate guarded operation with submission scope, local batch approval,
reviewed answers, complete fields and a cancellable countdown. It never retries an uncertain
submission or solves a CAPTCHA. Other form agents and Autopilot retain the restrictions above.

## Standing approval for a connected assistant

`external-browser.js` keeps the account's standing approval (`setStanding`, `loadStanding`; the server is the
source of truth, `PUT /api/extension/browser/standing-approval`). While on, a `submit` treats changed answers as
reviewed and skips the countdown, and **Stop access** turns it off. Do not extend it to skip validation,
blockers, the existing-confirmation check, new-domain approval or unconfirmed-attempt locking, and never to job
boards beyond one job at a time or to CAPTCHA/sign-in pages.
