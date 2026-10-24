# Chrome Web Store copy for Auto apply v0.3.1

Prepared 18 October 2026. For v0.3.1, replacing the submitted v0.3.0 package.
Saved to Google on 18 October 2026 with the replacement v0.3.1 submission. Google confirmed
Pending review, with automatic publication after approval enabled.

## Title (manifest name)

Apply Shortly Form Assistant

## Summary (manifest description)

Fills job application forms from your ApplyShortly profile and answer bank. It submits only when you choose Auto apply.

## Description

Apply Shortly Form Assistant helps you fill job application forms from your saved ApplyShortly profile and answer bank. Review your answers and attachments, then submit yourself or explicitly choose Auto apply.

Features
- Fill contact details, experience, education, links and saved application answers.
- See fields that are filled, need input or need review.
- Request optional AI drafts and use the on-page assistant.
- Track supported applications in your ApplyShortly account.
- Choose Auto apply (Submit for me in the panel) to click the employer website’s Submit button after a three-second countdown with Cancel. Closing or minimising the panel cancels it.

Auto apply checks detected required fields, browser-reported invalid fields, a single identifiable Submit button and tracked application status. It refuses when a tracked application was already sent or needs verification. Form support varies by website; custom controls, uploads, consent steps and embedded forms can need manual input. Checks do not guarantee correct answers or employer acceptance. Review AI drafts first: Auto apply can submit them as filled without separate approval of each draft. An attempted submission is not confirmed success.

Getting started
1. Create or sign in to an account at https://applyshortly.com.
2. Save your profile and application answers.
3. Connect the extension, open an application form and choose Autofill.
4. Review answers and attachments. Submit yourself, or choose Auto apply and use Cancel during the countdown if you change your mind.

An ApplyShortly account is required. Profile and saved-answer fills are free. Optional AI features use ApplyShortly credits or your own supported AI provider key; provider charges may apply. Personal AI keys are stored encrypted on your ApplyShortly server.

The extension processes form questions and answers for filling and assistant features. Filled information is accessible to the employer before submission; submission sends it and attachments to that employer or its application service. Tracked attempts and confirmations are saved with the application. On ApplyShortly, a signed-in indicator keeps the extension’s connection in sync; logging out of a linked connection signs that browser out of both.

Privacy: https://applyshortly.com/privacy
Extension source: https://github.com/guna81/applyshortly-extension
Support: admin@applyshortly.com

## Single purpose

Help users complete job application forms from their ApplyShortly profile and saved answers, with optional AI drafting and application tracking. Users review and submit themselves or explicitly choose Auto apply, which clicks the employer’s Submit button after detected-required-field checks and a three-second cancellable countdown.

## Updated permission explanations

Scripting: Injects packaged scripts into the selected application tab to discover fields, insert answers and show the review panel. Auto apply clicks the page’s Submit button only after the user explicitly chooses it and the countdown completes.

activeTab: Lets the toolbar action or shortcut operate on the user-selected application page, including injecting packaged scripts when needed. The popup offers autofill and an explicit Auto apply action.

Host permissions: The configured ApplyShortly origin supports authentication, profile retrieval, optional AI drafts and tracked application events. Employer pages use many domains; packaged content scripts discover/fill fields and display the panel, and explicitly requested Auto apply clicks Submit after checks and a cancellable countdown. On ApplyShortly, scripts relay a signed-in indicator for linked sign-in; credentials do not pass through the page. Localhost/loopback and optional origins support self-hosted servers.

Storage and identity: retain current explanations only if they still match the next package. Remote code remains No only after checking the actual package.

## Privacy answers reviewed for v0.3.1

Current checked categories already cover profile/contact data, compensation, credentials, assistant messages, location, application URLs, fill/submission events and form content. Auto apply does not justify removing any checked category. Health remains unchecked only while the actual package does not process health information; review sensitive screening questions if adding support for them.

Reconfirm all three limited-use declarations against the revised purpose and policy: no sale/transfer outside permitted uses; no unrelated use; no creditworthiness/lending use. Employer submission is a user-requested transfer for the disclosed application-completion purpose. Do not certify before reviewing the exact release package and approving its public policy.

## v0.4.0 listing (form agent)

Prepared 25 October 2026 for the v0.4.0 package (`dist/applyshortly-extension-0.4.0.zip`).
Replaces the v0.3.1 copy above in the dashboard. Requires the hosted privacy policy with the
form agent paragraph (`POLICY_UPDATED_AT=2026-10-25`) to be live before submission.

### Summary (manifest description, 130 of 132 characters)

Fills job applications from your ApplyShortly profile and answers, even multi-step forms. Submits only when you choose Auto apply.

### Category and language

Productivity / Tools. English.

### Description

Stop retyping the same details into every job application. Apply Shortly Form Assistant fills application forms from your ApplyShortly profile and saved answers: contact details, work history, education, links, work authorisation and the screening questions you have answered before. It handles multi-step applications, pop-ups and embedded forms too, and you stay in control of what gets submitted.

HOW IT WORKS
1. Open a job application and click Fill this form (or press Alt+Shift+F).
2. The assistant fills everything it knows and shows what is left: "1 thing left for you".
3. Answer the remaining questions right in the chat panel. Your answers are saved, so the next form is faster.
4. Review the form, then click the employer's Submit button yourself, or choose Submit for me (Auto apply).

WHAT YOU GET
• One-click autofill from your profile, résumé and answer bank
• Multi-step forms: the form agent steps through pages, pop-ups and embedded application forms on the tab you started it in
• A chat panel that asks only for what it cannot answer, and lets you change any answer in plain words
• Optional AI drafts for open questions such as "Why do you want this role?" (Draft it for me), which you can review and edit
• Progress at a glance: filled, needs your input, needs review
• Application tracking in your ApplyShortly account for supported applications

YOU STAY IN CONTROL
• Nothing is submitted unless you click Submit yourself or explicitly choose Auto apply.
• Auto apply checks that detected required fields are answered, the browser reports no invalid fields and there is one identifiable Submit button, then counts down three seconds with Cancel. Closing or minimising the panel cancels it.
• It refuses tracked applications that were already sent or need verification.
• The form agent works only on the tab you start it in, shows Chrome's debugging bar while it runs, stops when you click Stop and take over, never solves CAPTCHAs and never clicks the final Submit itself.
• Review AI drafts first: Auto apply submits the form as filled, without separate approval of each draft.

Form support varies by website. Custom controls, uploads, consent steps and some embedded forms can need manual input. Checks do not guarantee correct answers or employer acceptance, and an attempted submission is not confirmed success.

GETTING STARTED
1. Create or sign in to your free account at https://applyshortly.com.
2. Upload your résumé and save your profile and answers.
3. Install the extension. It connects automatically when you are signed in to the website.
4. Open any job application and click Fill this form.

PRICING
An ApplyShortly account is required. Filling from your profile and saved answers is free. Optional AI features use ApplyShortly credits or your own supported AI provider key (OpenAI, Anthropic or Google Gemini); provider charges may apply. Personal AI keys are stored encrypted by ApplyShortly.

PRIVACY
The extension reads application forms on pages where you use it, and sends form questions, options and answers to ApplyShortly for filling, assistant and tracking features. While the form agent runs it also sends a description of the form and, when the page does not change, a screenshot of the visible tab, to choose the next step; these are not stored. Filled information is visible to the employer website, and submitting sends it and your attachments to that employer. It does not collect your general browsing history for advertising.

Privacy policy: https://applyshortly.com/privacy
Open source (MIT): https://github.com/guna81/applyshortly-extension
Support: admin@applyshortly.com

### Single purpose

Help users complete job application forms from their ApplyShortly profile and saved answers,
including multi-step forms, with optional AI drafting and application tracking. Users review
and submit themselves or explicitly choose Auto apply, which clicks the employer's Submit button
after detected-required-field checks and a three-second cancellable countdown.

### Permission justifications (paste per field)

- **storage:** Keeps the connection credential, preferences and short-lived per-tab panel state in extension storage. Nothing is stored in Chrome sync.
- **scripting:** Injects the packaged form-filling scripts into the application tab the user selects, to discover fields, insert answers and show the review panel. Auto apply clicks the page's Submit button only after the user explicitly chooses it and the countdown completes.
- **activeTab:** Lets the toolbar button and keyboard shortcut act on the application page the user is viewing, including injecting the packaged scripts when needed.
- **identity:** Signs the user in to their ApplyShortly account through Chrome's web authentication flow (`launchWebAuthFlow`), so no password is typed into the extension.
- **debugger:** Used only after the user starts filling a form (Fill this form, Auto apply or the shortcut) and the page needs stepping through (a pop-up, several steps or an embedded form), or the user asks the panel to do the rest, on the tab they started it in, until it finishes or they stop it. It reads the application form in every frame of that tab, including employer forms embedded from another domain, and types and clicks with real input events so modern form frameworks accept the answers. It never submits the application, never solves CAPTCHAs, and detaches when done; Chrome shows its debugging bar the whole time.
- **Host permissions:** The ApplyShortly origin provides sign-in, profile retrieval, optional AI drafts, the form agent's next step and tracked application events. Employer application forms are on many different domains, so packaged content scripts run on pages to discover and fill fields and display the panel only when the user starts them. On ApplyShortly, the script relays a signed-in indicator for linked sign-in; credentials do not pass through the page. Localhost/loopback entries are for development builds.
- **Remote code:** No. All JavaScript is packaged; the server returns data (answers and next-step instructions), never code.

### Privacy practices

Keep the categories checked for v0.3.1 (personally identifiable information, financial/
compensation answers, authentication information, personal communications for assistant
messages, location, web history limited to application URLs, user activity for fill and
submission events, website content for form content). Website content now also covers the form
descriptions and occasional visible-tab screenshots the form agent sends; they are processed for
the next step and not stored. Health stays unchecked. Re-confirm all three limited-use
certifications against the updated policy.

### Graphics

Generated from the fictional fixture (`scripts/extension_store_fixture.py`) at 1280x800, RGB:

1. `1-fills-the-form.jpg`: the form filled from the profile, one question left in the panel.
2. `2-ready-to-submit.jpg`: question answered in chat, "All set: review and submit", draft offer.
3. `3-auto-apply-countdown.jpg`: Submit for me with the cancellable countdown.

Promo tiles: `promo-small-440x280.jpg` (small tile) and `promo-marquee-1400x560.jpg` (marquee),
emerald brand gradient with the A/arrow logo. Screenshots carry the fixture's demonstration
label; never capture real profiles or answers.

### Other fields

Minimum Chrome version: 125 (from the manifest). Homepage `https://applyshortly.com`; support
`admin@applyshortly.com`; privacy `https://applyshortly.com/privacy`. Distribution unchanged.
