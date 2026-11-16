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

The AI-led controller (`src/agent/loop.js`, `src/agent/cdp.js`) requires the platform to acknowledge guarded commands. It pauses locally on repeated page states or after forty planning calls, follows only an application tab opened by its own recent click, and never clicks a final Submit. Keep `extension-bridge/` in sync with the platform and describe scripted tests as unit coverage, not real-model validation.

## Testing the AI-led engine on a live form

Unit tests (`npm test` on Node 22) do not show how the AI-led engine behaves on a real page. The platform
repo has a headless harness that runs the built `dist/extension` against a live form with no
Chrome reload (`scripts/live_extension/run.sh`, see `apply-assistant/docs/development/live-extension-testing.md`).
It spends AI credits, and it covers the agent loop and command layer only, not the panel chat:
panel behaviour (quick replies, message routing) is checked by `extension/test/panel-assistant.test.mjs`.
Rebuild with `python3 scripts/build_extension.py` before either, since Chrome and the harness run `dist/`.

The test framework for the single form agent (Tier 1 synthetic pages, Tier 2 live runs, the scorecard, the monitor UI, the
dummy person for those tiers, jobs, answers and score history) lives in the platform repo, because it runs in the platform's
test image and reads its API: `apply-assistant/tools/form-agent-testbed/` (guide:
`apply-assistant/docs/development/form-agent-testing/single-agent-test-guide.md`). It tests this repo's `dist/extension` and finds
the checkout through `EXTENSION_REPO`, else the folder beside the platform. Tier 0 stays here: replay of the agent against simulated forms
with a fake model (`extension/test/replay/`, run by `npm test`; its dummy person is `extension/test/replay/fixtures/fake_person.json`).

Test in this order: Tier 0 replay (`npm test`), then Tier 1 synthetic pages (free), and only then a live run. A bug found live first
becomes a Tier 0 fixture that fails (`todo` until fixed). Rebuild with `python3 scripts/build_extension.py` before any live run (the
testbed does it for you). Report numbers as measured on those forms, not as general accuracy.

## One form agent, no versions (rule for every contributor and coding agent)

There is ONE AI-led form agent. Do not add another planner, mode, flag, setting, "experimental" tier or numbered
variant (rule-led, AI-led, classic, model-led, tool-led, v2 ...) to compare against it: each one multiplies code,
tests, docs and scorecard columns and makes the agent harder to maintain. Improve the one agent, or fold the idea
into it. To try an idea, change the agent on a branch of your working tree and measure it against the recorded
results; if it does not win, discard it instead of keeping it as an option. The classic, model-led and tool-led modes
that once existed were consolidated into the one agent (the former tool-led behaviour, no mode name, no setting); the other
two were deleted. Their measured results are kept in `apply-assistant/docs/development/form-agent-testing/form-agent-planner-results.md`.

The test framework follows the same rule. It only loads jobs (or simulated pages), runs the agent, and records
the steps, questions, model calls, tokens and outcome. It has no planner selection and no per-planner columns.
Comparing two versions of the agent means running the framework on two checkouts or builds, one after the other,
never a switch inside the agent. Live runs: one run per job.

## The AI-led form agent

`extensionPlanner` (`extension/src/extension-agent.js`) is the only planner of the AI-led engine; the engine (`agent/loop.js`),
the command layer and the safety rules sit around it. Each turn the model returns up to eight actions with a `source` for each
value (the candidate key, saved answer or user reply it comes from). It is shown the profile's grounded answers as
`suggested_actions` (the code never fills a field on its own), fills optional fields the profile can answer and asks the user
once about the rest (they may skip; required fields come first), and gets refused actions back as `rejected_last_turn`. It can
look before it acts: a screenshot of the page (each turn the layout changed), native tool calls (JSON when the provider has none),
looking tools answered inside the same step (`find`, `read_page`, `get_page_text`, `screenshot`, read-only `read_console` /
`read_network`), `click_at`, `drag`, `wait_for`, and a transcript of its own recent actions (`agent/tools.js`).

`vetAction` (inside `extensionPlanner`) is the veto layer for every action: no submit, no CAPTCHA, consent and legal facts
(visa, sponsorship, criminal record, previous employment) only from the profile or the user's chat answer, no overwrite, no
passwords, key and origin limits. No tool runs JavaScript or submits; a screenshot point is resolved to the one control under it
and then vetted as a click. The one setting is the user's privacy switch "Send page screenshots to the AI" (`agentVision`, on by
default): the image goes only to the provider that already gets the page text, is never stored by ApplyShortly, and custom
providers get it only when the host is known to take images or `supportsVision` is set. Details: `apply-assistant/docs/development/form-agent-testing/form-agent.md`.

Every platform call has a timeout (`bridge.js`: 30 s, 90 s for `agentModel` / `agentStep`); a timeout is a transient 408.

The agent needs a platform whose `/extension/agent/model` accepts `actions`, `images` and `native_tools` (an older API answers 422
and the agent falls back to the plain request, then to asking "Please answer: First Name"). Rebuild the API container (`make up`)
after pulling platform changes.

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


## Generic controls (do not add a detector per site)

The form agent follows the Playwright MCP / Claude in Chrome principle: observe every visible interactive control with its role, name and state (`checked`, `pressed`, `selected`, `expanded`), act on it with a generic action, then verify by observing again. When a control fails, fix the observation or the generic action, not a per-site rule. A pick-one question made of buttons, a switch or pills (two to six siblings sharing `aria-pressed`, `-checked` or `-selected` under one label) is a choice group: `type`, `select`, `click` and `check` at one of its options all become a `check` on the option the answer names (`extension-agent.js`, mirrored by `policy.as_choice` on the server). A click on a suggestion of an open typeahead becomes a `select` on its field. `press` (Tab, Escape, Space, arrows, Enter only inside an open dropdown) and `hover` are planner actions. The safety rules stay on top of every action: never submit (`submit_like`, a final-looking control next to a field or inside a form), consent and eligibility need the user (a choice question asks once and the run carries on), no overwrite of an answered group, no CAPTCHA.

## Paired form-agent fixes

The extension AI-led planner is `extension/src/extension-agent.js` in the public repository,
shared by Platform AI and custom/local providers. Change it once for both. The private server
browser retains its Python planner; mirror shared policy fixes there when applicable.
Add a page snapshot and scripted replies to the extension's `test/agent-scenarios.json` and run
both the Node replay and backend `test_shared_scenario_replay`. Runtime policy data is in
`extension/src/agent-rules.json`; regenerate `src/agent-rules.js` with
`python3 scripts/agent_rules.py` in the extension and keep the backend `services/agent/rules.json`
copy identical. Shared tests check all copies. See the platform's
`docs/development/shared-agent-rules.md`. Never restore server-stored personal-key calls.

The extension agent sends one JPEG per planning turn to the selected provider when the layout changed and the user's
screenshot switch is on (never stored by ApplyShortly; custom providers only when the host is known to take images or
`supportsVision` is set). The server Python planner has its own screenshots and native tools. Do not claim visual parity or
identical behavior between the two. Whether the screenshots and tool calls help is not proven: the gateway does not yet report
whether a provider used them (see `apply-assistant/docs/development/form-agent-testing/form-agent-planner-results.md`).
