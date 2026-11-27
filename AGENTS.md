# Contributor guide for coding agents

> **Names (2026-11-18).** The extension now calls its two engines the **Rule based form assistant** (rules and saved answers; no model calls; `src/rule-based/`) and the
> **Agent based form assistant** (one ReAct agent; `src/agent-based/`; both engines run on `src/page-control/`). Their old names, "Rules-led" and "AI-led", are
> **still used by the platform** (website settings, docs, the `agent_engine` / `extensionEngine` values `rules_led` and `ai_led`). Those values are kept on purpose so the
> extension and the platform stay in sync. **The platform will be renamed soon**; until then read "AI-led" there as the agent based form assistant.

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

Runtime code is in `extension/src/` (written in TypeScript, migrated 2026-11-19; `npm run typecheck` enforces type safety); tests are in `extension/test/`. Keep the extension bridge (`extension/src/shared/bridge.ts`) and platform client (`extension-bridge/client.ts`) consistent. Generate the OpenAPI subset using `scripts/extension_openapi.py` from a trusted platform spec.

Run `npm run check` and `npm run build` for relevant changes. Browser integration coverage lives in the platform repository; do not describe unit checks as browser validation.

Preserve user-chosen submission (the user clicks the site's Submit, or explicitly chooses Auto apply, which submits only when every required field is answered and after a cancellable countdown; clicking Apply in ApplyShortly for a job board chooses it through a one-time code the extension claims once), confirmation evidence, per-account isolation, and background-only credential access. Never commit credentials, local settings, real application data, resumes or private repository history. Do not introduce Google scraping. Job boards (LinkedIn, Naukri, Indeed, …) are filled only by the form agent in a tab the user started it in, one job at a time: no bulk or background job-board automation, never solve CAPTCHAs, and the agent itself never clicks a final Submit.

Autopilot windows (`src/background.js`, `autopilot*`) open only a link the platform returned from `/autopilot/next`, with its one-time code, only with the user's setting on, one at a time and never for a job board (the platform doesn't offer them; the extension also never opens a non-http(s) link). They are unattended, so they never start the form agent or AI drafting, never send an answer marked for checking, stop on a sign-in page, and close only the tab they opened, after the submit attempt. Keep it that way.

The Agent based form assistant controller (`src/page-control/loop.js`, `src/page-control/cdp.js`) requires the platform to acknowledge guarded commands. It pauses locally on repeated page states or after forty planning calls, follows only an application tab opened by its own recent click, and never clicks a final Submit. Keep `extension-bridge/` in sync with the platform and describe scripted tests as unit coverage, not real-model validation.

## Testing the Agent based form assistant engine on a live form

Unit tests (`npm test` on Node 22) do not show how the Agent based form assistant engine behaves on a real page. The platform
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

**Pre-production gate (every release):** Before merging/pushing to `main`, deploying to production, or publishing a new extension package,
run the platform testbed (`apply-assistant/tools/form-agent-testbed/`) on the live regression set in `auto` mode on **both** surfaces (this
extension and the platform's in-app browser-runner) and verify 0 safety failures and no regressions. Run `rules_led` or `ai_led` alone only when
the user asks, to troubleshoot which engine part fails.

## Two engines, one agent each, no versions (rule for every contributor and coding agent)

The extension has exactly two form engines, with a strict architectural boundary:

1. **Rule based form assistant (`src/rule-based/`)**
   - Uses deterministic scripts for extraction, matching, and filling, with additional reliability logic (retries, cookie dismissal, multi-step navigation).
   - **NEVER make LLM calls** — no model requests, no embeddings, no AI drafting, no AI navigation, and no imports from `src/agent-based/`. Unknowns stay with the user.

2. **Agent based form assistant (`src/agent-based/`)**
   - Designed to fill **any kind of form**: the LLM is the brain and browser events are its native tools; it reads the page and decides which tool to call.
   - **NEVER write rule fixes** — no per-site rules, no keyword/regex answer matching, no deterministic prefill, and no conditional code or regex workarounds. **If a fix can be done by prompting or tools, it MUST be done by prompting or tools rather than conditional code or regex.**
   - **Natural conversation:** Plain-language assistant text alongside native tool calls (no mandatory JSON wrapper), and user chat messages keep full tools so the agent can answer questions or edit the form when asked.
   - **Default behaviour (prompted, not coded):** Fill the form top-to-bottom in page order — first fill all known answers without user interaction, report the initially filled fields in chat as a message only from the LLM (never a code-generated checklist), then ask the user unknown questions one by one top-to-bottom and move to the next after each answer.
   - **Settings controlled via prompts:** `Auto apply`, `Fill optional fields`, and `Auto-draft open-ended answers` are read fresh every turn and passed to the model in each snapshot so behaviour is controlled via prompts rather than code branches.

Both sit on `src/page-control/` (observe the page, run guarded commands, drive the tab). `src/auto-mode/auto-agent.ts` composes them per form step (deterministic rule pass first with 0 LLM calls, then Agent review & completion when credits/Custom AI are available, or rule-only fallback when credits are unavailable) without breaking the boundary between the two engines. Do not add another planner, mode, flag, setting,
"experimental" tier or numbered variant (classic, model-led, tool-led, v2, "new" ...) to compare against the agent: each one multiplies code,
tests, docs and scorecard columns. Improve the one agent, or fold the idea into it. To try an idea, change the agent on a branch of your
working tree and measure it against the recorded results; if it does not win, discard it. The earlier classic, model-led and tool-led modes
and the old one-JSON-reply planner (`extensionPlanner`, with its four model-skipping shortcuts) are deleted. Their measured results are kept in
`apply-assistant/docs/development/form-agent-testing/form-agent-planner-results.md`.

The test framework follows the same rule. It only loads jobs (or simulated pages), runs the agent, and records
the steps, questions, model calls, tokens and outcome. It has no planner selection and no per-planner columns.
Comparing two versions of the agent means running the framework on two checkouts or builds, one after the other,
never a switch inside the agent. Live runs: one run per job.

## The Agent based form assistant

`formAgent` (`src/agent-based/form-agent.js`) is a real ReAct agent on LangGraph JS (bundled at build time by `scripts/bundle_langgraph.mjs`;
`src/agent-based/langgraph.js` is the one-line entry). The model gets a stable system message (rules, the candidate's profile, the job) and,
each step, one message with the page (URL, dialog, blockers, tabs, numbered elements, page text) and the results of its last tool calls.
Only the latest page snapshot stays in full; older ones shrink to a one-line stub, and history is kept under 80 messages. The model calls tools:
read tools are answered inside the same step (`find`, `read_page`, `get_page_text`, `screenshot`, `read_console`, `read_network`, `options`, `web_fetch`);
action tools (`type_text`, `select_option`, `press_key`, `fill_form`, `check`, `upload`, `click`, `click_at`, `drag`, `wait_for`, `run_js`, `ask_user`, `done`)
end the graph run as a plan for the loop. The browser cannot pause a graph (`interrupt()` does not work there), so a run ends at an action or a question and the next
step resumes with the tool results. The state is saved to `chrome.storage.session` (`agentState:<tabId>`) after every step. The agent's files: `form-agent.js`
(graph and step), `agent-guards.js` (hard limits), `agent-prompt.js`, `tools.js` (catalog, `findElements`, `clickAtRef`). There are no model-skipping shortcuts:
the model decides every step.

The model replies in brief, plain language (at most 1000 characters) alongside native tool calls — no mandatory JSON envelope (though a legacy `{"message","actions"}` envelope is still unpacked cleanly for backward compatibility). Silent write turns keep assistant text empty.
`ask_user` accepts `ref`, `question`, and optional `actions` (at most three unique `draft`, `skip`, `on_page` UI button names; `skip` is stripped on required fields). `done` accepts `summary` and `posting_gone` accepts `reason`; tool arguments take precedence over assistant text so a fill summary never overwrites a question card.
A no-tool conversational reply pauses without claiming completion; `user_message` keeps full tools so the agent can answer questions in text or edit the form when the user asks, and is never recorded as the pending field's answer.

Behaviour (prompted, not coded): top to bottom in page order, in two passes. The first pass fills everything the facts support without asking, silently, and ends
with one message from the LLM saying what was filled (never a code-generated checklist). The second pass asks about the rest one field at a time, in page order (optional fields in their place when enabled), moving on after
each answer. On a multi-step form both passes finish on a step before the next one.

The user's three switches are read fresh every turn (getters from `background.ts`, which follows `chrome.storage` changes) and shown in every snapshot:
"Fill optional fields" (`fillOptional`), "Auto-draft open-ended answers" (`aiDrafts` → `options.allowDrafts`: on, the agent writes open-ended answers at the length the
question needs, from the profile and the job; off, it asks with the draft button, and "Draft it for me" allows that one field) and "Auto apply"
(`autoApply`, or the run's one-time auto-submit code → `options.autoApply`: only changes what the agent tells the user; the panel's Auto apply submits after `done`
with its checks and cancellable countdown, the agent never does).

`agent-guards.ts` holds only the core safety limits that apply whatever the model decides: no final submit, no sign-in or payment, no CAPTCHA or human check, consent and legal facts (visa, sponsorship,
criminal record, previous employment, privacy/terms declarations) only from the profile or the user's answer, no overwrite of user-edited or filled fields, no password,
key and origin limits, file availability check for uploads (without English filename regexes), a repeated
question refused, and `done` refused while required fields are still empty. Optional-field preference and open-ended drafting are controlled via prompts rather than code vetoes. It never rewrites what the model chose: a refusal is a tool error the model reads and
works around (a click or text write on a Yes/No option or checkbox is refused with "use check", so the consent and overwrite limits always apply). `run_js` runs model-written
JavaScript through `chrome.debugger`; the page-level submit guard still blocks submission.
The privacy switch "Send page screenshots to the AI" (`agentVision`, on by default) sends the image only to the provider that already gets the page text; custom providers get
it only when the host is known to take images or `supportsVision` is set. Details: `apply-assistant/docs/development/form-agent-testing/form-agent.md`.

Every platform call has a timeout (`bridge.js`: 30 s, 90 s for `agentModel` / `agentStep`); a timeout is a transient 408.

The agent needs a platform whose `/extension/agent/model` accepts `actions`, `images` and `native_tools` (an older API answers 422
and the agent falls back to the plain request, then to asking "Please answer: First Name"). Rebuild the API container (`make up`)
after pulling platform changes.

## Shared command layer

`extension/src/page-control/commands.js` (`CommandRunner`) is the only place that guards and runs page
commands (stale observation, document change, user-edited or replaced control, password, unapproved
link; verified `type`/`select`/`check`, `fill_form`, `options`, `review`, delta replies). The form agent
loop (`page-control/loop.js`) calls it; do not copy its guards into a controller.


## Generic controls (do not add a detector per site)

The form agent follows the Playwright MCP / Claude in Chrome principle: observe every visible interactive control with its role, name and state (`checked`, `pressed`, `selected`, `expanded`), act on it with a generic action, then verify by observing again. When a control fails, fix the observation or the generic action, not a per-site rule. A pick-one question made of buttons, a switch or pills (two to six siblings sharing `aria-pressed`, `-checked` or `-selected` under one label) is a choice group. The Agent based agent answers it with `check` on the option itself: its guards refuse `type`, `select` or `click` there with that hint and rewrite nothing (2026-11-18). The shared command layer's `fill_form` (`page-control/commands.js`, used by the platform and external controllers, mirrored by `policy.as_choice` on the server) still turns answer text at an option into a `check`. The agent picks a typeahead suggestion by clicking it or with `select_option` on the field. `press` (Tab, Escape, Space, arrows, Enter only inside an open dropdown) and `hover` are agent actions. The safety rules stay on top of every action: never submit (`submit_like`, a final-looking control next to a field or inside a form), consent and eligibility need the user (a choice question asks once and the run carries on), no overwrite of an answered group, no CAPTCHA.

## Paired form-agent fixes

The extension's Agent based form assistant is `src/agent-based/form-agent.ts` in the public repository,
shared by Platform AI, custom/local providers, and the platform's in-app `browser-runner` (bundled via `make runner-bundle-sync`).
Change it once for all surfaces. The legacy Python AI-led step planner in `services/agent/` was removed; keep shared rule/policy data in sync where applicable.
Add a page snapshot and scripted replies to the extension's `test/agent-scenarios.json` and run
both the Node replay and backend `test_shared_scenario_replay`. Runtime policy data is in
`extension/src/shared/agent-rules.json`; regenerate `src/shared/agent-rules.js` with
`python3 scripts/agent_rules.py` in the extension and keep the backend `services/agent/rules.json`
copy identical. Shared tests check all copies. See the platform's
`docs/development/shared-agent-rules.md`. Never restore server-stored personal-key calls.

The shared form agent sends one JPEG per planning turn to the selected provider when the layout changed and the user's
screenshot switch is on (never stored by ApplyShortly; custom providers only when the host is known to take images or
`supportsVision` is set). Whether the screenshots and tool calls help is not proven: the gateway does not yet report
whether a provider used them (see `apply-assistant/docs/development/form-agent-testing/form-agent-planner-results.md`).

## Enforced form-engine boundary

- **Agent based (`src/agent-based/`):** All form reasoning belongs to the LLM. Never add keyword/regex answer matching, per-site rules, deterministic prefill, answer rewriting, or conditional code/regex fixes for issues that can be solved by prompting or tools. Safety guards in `agent-guards.ts` enforce only core safety invariants (no submit, no sign-in/payment, no CAPTCHA/password, consent/legal confirmation, no overwrite, required-field completion) and never pick or substitute an answer.
- **Rule based (`src/rule-based/`):** Purely deterministic script extraction, matching, and filling with reliability logic. Never call any LLM provider, embedding model, or AI drafting/navigation helper, directly or indirectly.
- **Shared layers:** `src/page-control/` observes and executes explicit commands; `src/shared/ui/` owns common panel presentation and routing. Engine failures never switch engines, except when ApplyShortly platform AI credits run out (HTTP 402 `insufficient_credits` on `/api/extension/agent/model`), in which case the run automatically falls back to the Rule based form assistant for that run only while keeping the user's saved engine setting unchanged. Keep engine-boundary tests alongside changes.
