# ApplyShortly Autofill (Chrome extension, Tier B)

Fills job application forms in **your own** Chrome, from your ApplyShortly profile and answer bank.
Use it for forms the server-side browser can't handle: anything behind your login (Google Forms,
Workday, iCIMS), CAPTCHAs, and unknown layouts. Like Tier A, **it fills and never submits**. You
review the form and click the site's own submit button.

Plain JavaScript with no compilation step. The build packages an allowlisted set of runtime files;
it never reads `.env` or includes local credentials. An ApplyShortly account and compatible server
are required, including when using a personal AI key. See `../extension-bridge/README.md` for the API.

## Build and install

From the repository root:

```sh
npm ci
npm run build
# Optional explicit platform origin:
npm run build -- --platform-url https://your-applyshortly-host.example
npm run build:source
npm run check
```

The build writes `dist/extension/` and `dist/applyshortly-extension-0.3.0.zip`.
Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select
`dist/extension/` (not the ZIP). Source `extension/` checkouts default to localhost; use the built directory for `.env` configuration.
After rebuilding, click **Reload** in Chrome and reload the application page.

Open extension settings. Setup silently connects when you are already signed in to the website.
Otherwise, click **Sign in with ApplyShortly** to open sign-in. There is no Platform URL field:
the package contains the public `FRONTEND_URL` selected at build time (explicit `--platform-url`,
environment, root `.env`, then localhost development default). Rebuild after changing this value.
The package includes permission for that origin; `.env` and its other values are never packaged.
The extension shows **Connected as**, your plan and credits (or self-hosted status), and never
displays the generated connection credential.
Use **Open ApplyShortly** to open the website with your extension account. A different website
account or an unrecognized browser asks for confirmation first.

Website logout and extension disconnect invalidate that browser's linked connection; other
devices stay signed in. Disconnect before connecting another account. To revoke access, click
**Disconnect account**, revoke the named automatic key, or revoke a linked website session.

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

### Choose how AI drafts are paid for

In extension setup, expand **Advanced: use your own AI key**, choose OpenAI, Anthropic Claude,
or Google Gemini, then enter your personal API key and required model identifier. **Save and use**
selects that provider. Use **AI funding** to choose a saved provider or ApplyShortly credits.
You can also manage the same settings in ApplyShortly **Settings → Extension AI**.
Personal-key mode is available on every account tier. Your provider bills those requests directly;
no ApplyShortly credits are deducted and there is no automatic fallback to credits.

Personal keys are sent to your ApplyShortly server, stored encrypted there, and never returned to
the browser or employer site. Replace or delete them in extension setup or website Settings. Deleting a selected key leaves
personal mode selected: restore the key or explicitly choose credits. Facts and lexical answer-bank
fills remain available without an AI key. AI drafts are always marked for review; automatic drafts
are off by default. A provider may reject an invalid key, unsupported model, quota, or schema.

### Standalone source archive

`npm run build:source` additionally writes `dist/applyshortly-extension-source-0.3.0.zip`.
It contains extension and bridge source, tests, packaging scripts, MIT license and brand notes;
it contains no backend code, credentials, or repository history. It is ready for a separate public
repository, but this command does not publish anything. See `LICENSE` and `BRANDING.md`.

For an extracted source archive, run `npm ci`, `npm run check` and `npm run build`.
The root README describes development tools and CI.

## Use

- **From the platform:** **Apply in your browser** (row menu or after a failed run) opens the posting with `#jobhunt-autofill=<id>`. The extension fills the form on its own.
- **On any page:** click the toolbar icon. The popup shows whether the page is a job in ApplyShortly
  (`/applications/lookup`). Use **Autofill this form**, or **Fill without tracking** for pages that
  aren't. **Alt+Shift+F** does the same without the popup. You can change it at
  `chrome://extensions/shortcuts`.

The panel at the bottom right has:

- **A headline and progress bar**, e.g. *6 things left for you · 11 of 17 answered*.
- **Next steps:**
  1. Answer the questions it couldn't.
  2. Attach your CV. **Download CV** is inline, for upload dialogs like Google Forms'.
  3. Double-check flagged answers.
  4. Click the form's own Submit. **I already submitted it** covers sites where it can't detect
     the submit.
  Steps tick off as you go.
- **Needs you:** each row has **Go to field →** (scrolls to it and highlights it) and **✨ Draft
  with AI** for text questions. Dropdown rows have **Copy answer**. Rows the extension can't check
  (consent boxes, Google uploads) have **✓ Done**.
- **Double-check:** AI drafts, and a "current company" taken from a job not marked current. Click
  **✓ Looks good** to clear one.
- **Filled:** each value and where it came from (*From profile*, *From answer bank*, *AI draft*,
  *Your answer*). Click a row to jump to the field, or click a value to expand it.

When you type an answer on the page, the panel notices and ticks it off. You don't need to click
**↻ Fill again**, which only fills fields that are still empty. **✨ Draft N with AI** drafts every
remaining text question (uses your selected AI payment mode). **–** or Esc shrinks the panel to a pill showing what's
left. It stays minimised on later pages until you open it again.

On the page, green fields are filled, amber means check it, and dashed red means it's your turn.
Hover over a field to see why. Errors say what to do: a rejected key offers **Open settings**, and
an unreachable platform offers **Try again**.

## Assistant side panel

Open the assistant from the toolbar popup for chat, page-aware actions, and application tracking. It requires a compatible server with the assistant endpoints. Review drafts and submit applications yourself.

## How answers are chosen

For each empty field, in order:

1. **Profile facts** (`src/fill.js` → `profileAnswer`): name and first/last name, email, phone,
   location, links, total experience, current company and title, highest qualification, college
   and branch, cover letter, summary.
2. **`POST /answers/suggest`** with `allow_generate: false`, which covers preferences (notice
   period, CTC, relocation, work authorisation, sponsorship) and the answer bank. If the full
   question doesn't match, it retries with the first sentence. *"Current CTC? Mention fixed and
   variable components separately."* is matched as *"Current CTC?"*.
3. **AI draft** using your selected payment mode, only if you click **✨ Draft with AI** or turn on *Draft missing answers with AI
   automatically* (in the popup or Settings).

Selects and radio groups (native and Google Forms' ARIA ones) are set when an answer matches one
option exactly, by yes/no, or by unambiguous containment. Otherwise they're left for you.
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

The ApplyShortly A/arrow mark is in `icons/logo.svg` for the popup and settings page. The toolbar PNGs are rasterized from the same
vector at 16, 48, and 128 pixels. The on-page panel embeds this SVG as a CSS data URL so it does
not need additional extension resource permissions. Keep these copies in sync when changing the mark.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Has loopback host access; the build adds the selected platform origin. |
| `platform.json` | Public default platform origin, generated by the build. Contains no credentials. |
| `src/background.js` | Service worker. Holds the API key and makes every platform request, so job sites never see the key or hit CORS. Tracks which application each tab is filling. |
| `src/bridge.js` | JS port of `extension-bridge/client.ts`. Keep the two in sync. |
| `src/fill.js` | Field discovery, labels, profile answers, writing values (pure DOM, tested in jsdom) |
| `src/content.js` | Runs the fill on the page, the review panel (closed shadow DOM), live re-check, submit detection |
| `src/sidepanel.*`, `src/chat-model.js` | Assistant side panel and chat helpers |
| `src/panel-model.js` | Pure helpers shared by the panel and popup: checklist and counts, friendly error messages |
| `src/popup.*`, `src/options.*`, `src/ui.css` | Toolbar popup and settings page |
| `test/*.test.mjs` | `npm test` (DOM tests use the root jsdom development dependency) |

## Limits

- **Google Forms file uploads** go through Google's own picker, which a page script can't fill.
  Use **Download CV**, then **Add file**.
- **Custom dropdowns** (ARIA listboxes, e.g. Google Forms' "Choose") are listed with the answer to
  pick, but not opened.
- **Forms inside iframes** (e.g. an embedded Greenhouse board on a company site) aren't filled.
  Open the board's own URL instead.
- **Submits done with `fetch`** on single-page apps aren't detected; use **Mark as submitted**.
