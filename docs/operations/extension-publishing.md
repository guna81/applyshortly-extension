# Chrome Web Store release

Build and release from this repository. Current package version: 0.4.0.

Public listing: <https://chromewebstore.google.com/detail/apply-shortly-form-assist/pdeffhelbeobnpcbjdegddcfimglmedd>
(item ID `pdeffhelbeobnpcbjdegddcfimglmedd`; v0.3.1 live since 20 October 2026). Upload new
versions to this same item so existing installs update automatically.

```sh
npm ci
npm run check
npm run build -- --platform-url https://applyshortly.com
npm run build:source -- --platform-url https://applyshortly.com
```

Upload `dist/applyshortly-extension-0.4.0.zip`; the source archive is for contributors.
The build includes only allowlisted runtime assets and the selected public origin. No local
credentials, provider keys, user data or platform code belongs in either archive.

Before release, run the private platform's Chromium fixtures with `EXTENSION_REPO` pointing
to this checkout. Its `scripts/ci.sh backend` validates integration and contract compatibility
against disposable data. Unit checks alone do not validate browser integration or live ATS support.
Coordinate backend/API changes and refresh the platform's integration lock after validation.

## Fictional screenshots

Run `python3 scripts/extension_store_fixture.py` and open
`http://127.0.0.1:8766`. The fixture renders the source panel code with fictional applicant and
company data and fake messages. It does not connect accounts or call an AI provider.
Capture the assistant panel (chat, and the agent at work) at 1280×800 as RGB PNG or JPEG; keep the demonstration label.
Never capture real profiles or application answers.

## Release review

Use the [store copy](extension-store-auto-apply.md) and review its permissions against the
actual package. Check [privacy disclosures](../security/extension-privacy-policy.md) against
hosted policies and actual processing. Confirm the target server supports the packaged API,
browser login and registered extension callback. Test sign-in, disconnect, autofill, explicit
Auto apply, cancellation and unconfirmed retry blocking with synthetic local fixtures.

Keep reviewer credentials in the store's private instructions; do not commit passwords,
sessions or private deployment records. Platform deployment history and hosted policy approval
records remain in the private platform repository. Store submission and publication are
separate operator actions.
