# Extension bridge (Tier B)

The contract between the platform and a companion Chrome extension. The platform provides the API.
The extension that uses it is in [`../extension/`](../extension/README.md); its `src/bridge.js` is a
plain-JS port of `client.ts`. `client.ts` and `examples/autofill.ts` remain a typed starting point
for writing another.

Tier B is for postings that Tier A (server-side Playwright for Greenhouse, Lever and Ashby) can't
handle: Workday, iCIMS, company career sites, and anything that needs your logged-in browser
session. Like Tier A, the extension fills for review. You submit yourself or explicitly choose Auto apply,
which clicks Submit after required-field checks and a cancellable countdown.

## Files

| File | What it is |
|---|---|
| `openapi.json` | The `/api/extension/*` subset of the platform's OpenAPI spec. Generated from a trusted platform export using `scripts/extension_openapi.py`; platform CI checks compatibility. |
| `client.ts` | A dependency-free typed `fetch` client (`JobHuntBridge`), typechecked in CI. |
| `examples/autofill.ts` | An illustrative fill routine: labels → profile values / answer bank, then lifecycle reports. |

## Auth

Registered extension IDs use Chrome browser authentication with exact callbacks, PKCE and
state, exchanging a one-time 60-second code for a revocable account-specific credential.
Automatic connections link website and extension logout; only these credentials can mint
one-time website sign-in tickets. Unregistered installations retain user-approved code pairing
with a private polling secret, independent of website logout. Manual keys remain supported:

1. **Settings → API keys → Create key**. The key (`jh_…`) is shown once; only its hash is stored.
2. Paste it into Advanced manual connection in the extension's options; the origin comes from its package.
3. Revoke it from the same card at any time.

Every request sends `Authorization: Bearer <key>` and acts as the key's owner: it only sees that
user's profile and applications. The API answers `401` for a missing, wrong or revoked key. A browser
session cookie is not accepted on these endpoints.

Make the requests from the extension's **background service worker**, with `host_permissions` for
the platform's origin (e.g. `"https://jobs.example.com/*"`, or `"http://localhost:3000/*"` for a local
install). That way they aren't subject to the job site's CORS rules, and the key never enters page
context.

## Flow

1. In the platform (Apply Queue / application detail), **Open & Autofill** opens the posting as
   `<apply url>#jobhunt-autofill=<application id>`.
   The same link is offered as **Apply via extension** when a Tier A run fails (CAPTCHA, login
   wall, unknown form, browser error, review timeout); the API returns it as the run's
   `fallback_url`.
2. The extension reads the id (`autofillIdFromUrl`). If there is no fragment, it calls
   `GET /applications/lookup?url=<page url>`, which matches on the job's apply URL or its
   canonical URL (tracking parameters stripped).
3. `GET /profile` returns:
   - contact details, links, experience and education
   - preferences: notice period, CTC, work authorisation
   - the answer bank
   - `resume_url`
4. `GET /applications/{id}` returns the tailored summary and cover letter, if they were generated
   in the platform.
5. For unknown questions, `POST /answers/suggest` answers from:
   - profile facts first
   - then the answer bank
   - then, only with `allow_generate: true`, a grounded LLM draft marked `needs_review`
6. `POST /events` reports the lifecycle:

   | event | Effect |
   |---|---|
   | `opened` | Recorded only if a run already exists |
   | `filled` | Creates/updates an `apply_runs` row (`ats_type = "extension"`) with filled/unresolved fields → `ready_for_review` |
   | `submission_attempted` | Marks the run Needs verification; blocks retries until resolved. |
   | `submitted` | Run → `submitted`. The application moves to `submitted` (`applied_via = extension`, event source `user`) if it was saved / queued / filling / ready_for_review. |
   | `failed` | Run → `failed` |

Personal data travels between your browser and the configured ApplyShortly server; generated drafts also send relevant profile/job text to the selected AI provider. The API doesn't log request
bodies.

## Form assistant (autofill panel)

The autofill panel's **Assistant** tab chats to answer the questions on the page. It is
bearer-only and tenant-scoped like the rest of `/api/extension/*`.

| Route | Purpose |
|---|---|
| `POST /assistant/fill` | One stateless turn: the recent `messages`, the page's answerable `fields` (`key`, `label`, `kind`, `options`, `required`; keys are chosen by the extension per turn) and their `current` values. Returns `reply`, validated `updates` (field key → value; option fields always get one of their options), `warnings`, `done` and quick-reply `choices` (the asked field's own options when it has them). Costs 1 `form_assist` credit (none with a personal AI key); rate limited to 30 per minute. |

Nothing is stored. The extension writes accepted values into the page form; the user reviews
them and submits on the employer's site.

## Account and drafting mode

`GET /account` returns the connected account, credit balance, selected AI mode and configured
provider/model names (never personal keys). `POST /disconnect` revokes the current bearer key.
Manage encrypted personal provider keys and the extension-specific funding mode through the
cookie-authenticated `/api/settings/extension-ai` endpoints. Personal mode never falls back to
platform keys or credits. Deterministic fills require no AI request.

The extension-auth pairing routes are public/bootstrap endpoints outside this bearer-only subset;
`POST /api/extension-auth/decision` requires a signed-in browser and CSRF header.

This bridge is covered by the MIT license in `../extension/LICENSE`.


## Account and AI settings

`account()` returns the account plan, billing-enabled status, credit balance and AI configuration.
`aiSettings()`, `selectAI()`, `saveAIProvider()` and `deleteAIProvider()` use bearer-authenticated
`/api/extension/ai` routes backed by the same encrypted per-user settings as the website.
Responses contain provider/model metadata only. Saved personal keys are never returned.
