# Apply Shortly Form Assistant (Chrome extension, Tier B)

Fills job application forms in **your own** Chrome, from your ApplyShortly profile and answer bank.
Use it for forms the server-side browser can't handle: anything behind your login (Google Forms,
Workday, iCIMS), CAPTCHAs, and unknown layouts. Like Tier A, **it fills and never submits on its
own**. You review the form and click the site's own submit button, or choose **⚡ Auto apply**
(below) to have it click that button for you once every required field is answered.

Plain JavaScript with no compilation step. The build packages an allowlisted set of runtime files;
it never reads `.env` or includes local credentials. An ApplyShortly account is required,
including when using a personal AI key. See `../extension-bridge/README.md` for the API.

## Install

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/apply-shortly-form-assist/pdeffhelbeobnpcbjdegddcfimglmedd). The store package is built for
`https://applyshortly.com`. For development, build and load it unpacked
as below. For Chrome Web Store releases, see the [publishing guide](../docs/operations/extension-publishing.md).

## Build from source

From the repository root:

```sh
make extension-build
# Reads FRONTEND_URL from environment or root .env. Optional explicit override:
make extension-build platform_url=https://applyshortly.com
make extension-source
make install
make extension-test
```

The build writes `dist/extension/` and `dist/applyshortly-extension-0.4.0.zip`.
Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select
`dist/extension/` (not the ZIP). Source `extension/` checkouts default to localhost; use the built directory for `.env` configuration.
After rebuilding, click **Reload** in Chrome and reload the application page.

Open extension settings. Setup silently connects when you are already signed in to the website.
Otherwise, click **Sign in with ApplyShortly** to open sign-in. There is no Platform URL field:
the package contains the public `FRONTEND_URL` selected at build time (explicit `--platform-url`,
environment, root `.env`, then localhost development default). Rebuild after changing this value.
The package includes permission for that origin; `.env` and its other values are never packaged.
The extension shows **Connected as**, your plan and credits, and never
displays the generated connection credential.
Use **Open ApplyShortly** to open the website with your extension account. A different website
account or an unrecognized browser asks for confirmation first.

Sign-in stays in sync with the website in this browser. Signing in to ApplyShortly connects the
extension on its own: any open ApplyShortly page reports it, and settings re-check when opened or
revisited. **Log out** in extension settings or on the website signs this browser out of both; the
other side notices on its next request, or when its tab regains focus. Other devices stay signed
in. To switch accounts, log out and sign in as the other account. To revoke access, log out,
revoke the named automatic key, or revoke a linked website session. Manual API-key connections
are independent of the website; logging out of the extension revokes that key.

For automatic sign-in, operators set `EXTENSION_IDS` to the ID shown at `chrome://extensions`.
The exact callback is `https://<extension-id>.chromiumapp.org/applyshortly`.
An older server without the browser configuration endpoint, or an empty/unmatched allowlist,
falls back to code pairing after clicking Sign in: compare the displayed codes and approve
in the website. Legacy codes expire after ten minutes and credentials remain independent of
website logout. Reopen settings to resume polling; use Cancel to stop locally.
A saved profile is needed for autofill, but not for connecting an account.

Manual connection remains available: create a per-user `jh_…` key in **Settings → API keys** and
paste it under **Advanced: manual API-key connection** in extension settings. Old `EXTENSION_API_TOKEN`/`extension-config` instructions no longer
apply. No shared token or credential-seeding file is distributed or loaded.

### The agent panel

The floating panel is one chat: the ApplyShortly agent, the same as the review chat on the
website. There is no separate assistant, agent button or question box. It fills the form, steps
through it when it has more than one page, drafts answers and asks you what it can't answer. It asks the unanswered questions one at a time, shows the form's options as tappable replies, and
fills the fields as you answer; you can also ask it to change an answer ("set notice period to
60 days"). An open question (like "Why are you suitable for this role?") comes with a
**Draft it for me** button, required or not, and typing "draft it for me" does the same; personal
facts (experience, notice period, joining date, names, numbers) are never drafted. Optional questions nothing could answer (like "Why are you a good fit?") are offered
next: **Draft it for me** writes an AI draft from your profile and the job, **Leave it blank** skips
it. Last, it brings up what only you can do: a consent checkbox (**I agree, tick it** ticks it only
when you tap it, or tick it yourself) and file uploads (**Show me** highlights the field). When the
page needs clicking through, the chat says so and carries on by itself (see [Stepping through a
form](#stepping-through-a-form)): no form on the page yet (it opens after an *Apply* button or in a
pop-up), a **Next** / **Continue** button and no Submit (a multi-step form), or a large frame and
next to no fields (an embedded form). Typing "do the rest" or "go to the next page" does the same. Answering the question the chat just asked
(tapping an option, or typing the answer to a text question) is written straight into the form
with no AI call and no credit; anything else goes to the assistant. Answers from chat are marked **From chat**. The conversation stays in
the page and is gone when you leave it. Only the page's question labels, options and current
values are sent with each message, never the rest of the page. The AI never answers checkboxes
or uploads. Each reply costs 1 credit unless you use a personal AI key, and the
assistant never submits.

### Choose how AI drafts are paid for

In extension setup, expand **Advanced: use your own AI key**, choose OpenAI, Anthropic Claude,
or Google Gemini, then enter your personal API key and required model identifier. **Save and use**
selects that provider. Use **AI funding** to choose a saved provider or ApplyShortly credits.
You can also manage the same settings in ApplyShortly **Settings → Extension AI**.
Personal-key mode is available on every account tier. Your provider bills those requests directly;
no ApplyShortly credits are deducted and there is no automatic fallback to credits.

Personal keys are sent to ApplyShortly, stored encrypted there, and never returned to
the browser or employer site. Replace or delete them in extension setup or website Settings. Deleting a selected key leaves
personal mode selected: restore the key or explicitly choose credits. Facts and lexical answer-bank
fills remain available without an AI key. AI drafts are always marked for review; automatic drafts
are on by default, like the website's agent (turn *Let AI answer questions it can't find* off in
the popup or Settings). Turning it on drafts the open questions on a panel that's already open. A provider may reject an invalid key, unsupported model, quota, or schema.

### Standalone source archive

`npm run build:source` additionally writes `dist/applyshortly-extension-source-0.4.0.zip`.
It contains extension and bridge source, tests, packaging scripts, MIT license and brand notes;
it contains no backend code, credentials, or repository history. It is ready for a separate public
repository, but this command does not publish anything. See `LICENSE` and `BRANDING.md`.

For an extracted source archive, run `npm ci`, `npm run check` and `npm run build`.

## Use

- **From the platform:** **Apply in your browser** (row menu or after a failed run), and **Prepare & review** on a job board, open the posting with `#jobhunt-autofill=<id>`. The extension fills the form on its own.
  **Apply** on a job board or sign-in site adds a one-time code (`&jobhunt-auto=<code>`, valid 10 minutes). The extension claims it (`POST /api/extension/applications/{id}/auto-apply`) and, once claimed, runs **⚡ Auto apply** on that page: the same checks and cancellable countdown. Reloading the page, or a link made anywhere else, only fills.
- **On any page:** click the toolbar icon. The popup shows whether the page is a job in ApplyShortly
  (`/applications/lookup`) and offers two choices, each with a line saying what it does:
  - **Fill this form**: fills what it can, then the panel asks you the rest. You check and submit.
    On a page that isn't tracked it fills the same way, with nothing recorded.
  - **⚡ Auto apply**: the same, then submits after a countdown (below).

  **Alt+Shift+F** fills without the popup. You can change it at
  `chrome://extensions/shortcuts`.

The panel at the bottom right has:

- **A headline and progress bar**, e.g. *6 things left for you · 11 of 17 answered* (the agent's
  status instead while it runs).
- **The assistant chat** (see above), or the agent's progress, questions and step log.
- **Submit for me** (panel footer; disabled until every required answer is in) and **⚡ Auto apply**
  (in the popup, for tracked and untracked pages alike; it fills the form straight away first): click the
  form's own Submit button after a 3-second countdown with **Cancel**. It refuses, and
  says why, when a required field (including a consent checkbox or an upload) still needs you,
  when it can't find exactly one Submit button (multi-step forms stop at **Next**), when that
  button is still disabled, when the browser or the site reports an invalid field, or when the
  application is already sent or waiting for verification. A hidden field the site's uploader fills
  (like `resume.fileName`) gets up to 5 seconds to finish uploading; if the site still hasn't
  registered the file, the upload goes back on your list with "attach it again". Minimising or closing the panel cancels the countdown. AI drafts you haven't
  checked are submitted as filled, so use it when you trust your answer bank. The attempt is
  reported as *submission attempted* until a confirmation is detected or you mark it.
- **I already submitted it** (footer, tracked pages) covers sites where it can't detect the submit.

When you type an answer on the page, the panel notices and moves on to the next question. **–** or Esc shrinks the panel to a pill showing what's
left. It stays minimised on later pages until you open it again.

On the page, green fields are filled, amber means check it, and dashed red means it's your turn.
Hover over a field to see why. Errors say what to do: a rejected key offers **Open settings**, an
account without a profile yet offers **Set up profile** (the website's profile setup), and an
unreachable platform offers **Try again**.

### Stepping through a form

For forms it can't finish in place (an **Apply** button that opens a pop-up, multi-page wizards,
typeahead dropdowns, forms inside frames, single-page apps that change step without loading a
page), the chat carries on by driving the tab itself after **Fill this form**, and says so first.
Inside, this is the form agent (`src/agent/`); to you it is the same chat.

- It works in the tab you started it in, one tab at a time, step by step: it reads the page
  (every frame, open shadow roots, the open dialog only when one is up), asks your ApplyShortly
  server what to do next, then clicks and types with real input events and looks again.
- Answers your profile and answer bank cover are typed without any AI call. AI is used only to
  find the way through the form (one apply run's credits per form, or your personal key).
- It asks in the chat for an answer it doesn't have (type it, tap an option, **Draft it for me** on
  open questions, or **I'll fill it on the page**), for a CAPTCHA or sign-in (**Continue** once
  you've done it), and on job boards for the posting's own **Apply / Easy Apply** click, because
  there that can apply in one click. It never solves CAPTCHAs.
- It never submits. When it has been through the form, the chat picks up anything still open, and
  you check the form and submit (yourself or with **Submit for me**). Auto apply doesn't submit a
  form it had to step through.
- **Pause** and **Stop and take over** are always available. Chrome shows a "started debugging
  this browser" bar while it runs (the `debugger` permission); closing the bar stops it.

## How answers are chosen

For each empty field, in order:

1. **Profile facts** (`src/fill.js` → `profileAnswer`): name and first/last name, email, phone,
   location, links, total experience, current company and title, highest qualification, college
   and branch, cover letter, summary.
2. **`POST /answers/suggest`** with `allow_generate: false`, which covers preferences (notice
   period, CTC, relocation, work authorisation, sponsorship) and the answer bank. If the full
   question doesn't match, it retries with the first sentence. *"Current CTC? Mention fixed and
   variable components separately."* is matched as *"Current CTC?"*.
3. **AI draft** using your selected payment mode, automatically unless *Let AI answer questions it can't find* is off (in the popup or
   Settings), and whenever you tap **Draft it for me**. On a page that isn't tracked in
   ApplyShortly, the draft request also carries the page's title and up to 6,000 characters of
   its visible text, so the AI knows the job ("What interests you about Outmarket?"). Profile and
   answer-bank lookups never send page text. If a draft fails, the chat says why (for example,
   no credits left).

Selects and radio groups (native and Google Forms' ARIA ones) are set when an answer matches one
option exactly, by yes/no, or by unambiguous containment. Otherwise they're left for you.
Custom dropdowns (Angular Material `mat-select` and other ARIA comboboxes) are opened, and the
matching option is clicked the same way.

After filling, the extension waits a moment for the page to validate and reads what the site says.
A value the site rejects is retried as a plain number ("5.6 years" → "5.6"); one it still rejects
is listed under **Needs you** with the site's own message. The panel only says *All set* when
nothing is left.
`<input type=file>` gets your résumé when its label says résumé/CV or it's the only upload.

## What it reports

| When | Event |
|---|---|
| Fill starts | `opened` |
| After each fill pass | `filled`, with filled and unresolved fields → the run shows *Ready for review* |
| You attempt submission | `submission_attempted` → *Needs verification*, excluded from submitted metrics until confirmed |
| Confirmation page or **I already submitted it** after verifying success | `submitted` → *Submitted*, preserving later application stages |
| An error stops the fill | `failed` |

The tab remembers its application, so later pages of a multi-page form on the same site are filled
and tracked too.

## Brand assets

The ApplyShortly A/arrow mark is defined in the platform website and copied to
`icons/logo.svg` for the popup and settings page. The toolbar PNGs are rasterized from the same
vector at 16, 48, and 128 pixels. The on-page panel embeds this SVG as a CSS data URL so it does
not need additional extension resource permissions. Keep these copies in sync when changing the mark.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Has host access to `localhost`/`127.0.0.1` and the public origin selected by packaging. |
| `platform.json` | Public default platform origin, generated by the build. Contains no credentials. |
| `src/background.js` | Service worker. Holds the API key and makes every platform request, so job sites never see the key or hit CORS. Tracks which application each tab is filling. |
| `src/bridge.js` | JS port of `extension-bridge/client.ts`. Keep the two in sync. |
| `src/fill.js` | Field discovery, labels, profile answers, writing values (pure DOM, tested in jsdom) |
| `src/content.js` | Runs the fill on the page, the Assistant tab's logic, live re-check, Auto apply, submit detection |
| `src/panel-view.js` | The review panel (closed shadow DOM): draws `content.js`'s state and calls back for actions |
| `src/panel-model.js` | Pure helpers shared by the panel and popup: checklist and counts, friendly error messages |
| `src/agent/loop.js` | The form agent's loop in the service worker: observe every frame, ask `/agent/step`, act, settle |
| `src/agent/cdp.js` | Drives the tab through `chrome.debugger`: frames (cross-origin included), isolated worlds, trusted mouse and keyboard input, screenshots |
| `src/agent/page.js` | In-frame half of the agent (needs `fill.js`): describes the page and locates elements; refuses final submits. Pure DOM, tested in jsdom. The platform's server agent uses a copy. |
| `src/popup.*`, `src/options.*`, `src/ui.css` | Toolbar popup and settings page |
| `test/*.test.mjs` | `node --test extension/test/*.test.mjs` (tests use the root npm dependencies) |

`npm run typecheck` also type-checks `src/` from JSDoc (`tsconfig.extension.json`, `@types/chrome`).

## Why it asks for these permissions

- **Content scripts on every site.** A tab the website opens with `#jobhunt-autofill=<id>`, the
  later pages of a multi-page form, and the confirmation page after a submit must all run the
  scripts without a click on the extension: that is how filling starts by itself and how a
  submission is confirmed. Chrome injects on demand only into tabs the extension has site access
  to or was clicked in, so on-demand injection would break these flows. On other pages the
  scripts stay idle: one `hello` message to the service worker, and a watch on the `<html>`
  attribute the ApplyShortly website uses for its signed-in mark.
- **`debugger`.** The form agent's trusted input and cross-origin frames
  (`src/agent/cdp.js`). It attaches only to the tab the agent was started in, and Chrome shows its
  debugging bar meanwhile.

## Limits

- **Google Forms file uploads** go through Google's own picker, which a page script can't fill.
  Use **Download CV**, then **Add file**.
- **Google Forms' dropdowns** ("Choose") are listed with the answer to pick, but not opened.
  Other custom dropdowns are opened and filled; one that behaves unlike the ARIA combobox pattern
  stays under **Needs you**.
- **Forms inside iframes** (e.g. an embedded Greenhouse board on a company site) aren't filled by
  autofill. The form agent fills them; or open the board's own URL.
- **The form agent** can't see inside closed shadow roots or Google's file picker, and needs
  Chrome 125 or later.
- **Submits done with `fetch`** on single-page apps aren't detected; use **Mark as submitted**.
