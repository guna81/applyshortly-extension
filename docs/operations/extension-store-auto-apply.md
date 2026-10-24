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

## Draft for v0.4.0 (form agent): not submitted

Review against the actual v0.4.0 package before submitting.

- **Summary (manifest description):** Fills job application forms from your ApplyShortly profile
  and answer bank, including multi-step forms with its agent. It submits only when you choose Auto
  apply.
- **New permission, debugger:** Used only after the user starts filling a form ("Fill this form", Auto apply or the shortcut) and the page needs stepping through (a pop-up, several steps or an embedded form), or the user asks the panel to "do the rest", on the tab
  they started it in, until it finishes or they stop it. It reads the application form in every
  frame of that tab (including employer forms embedded from another domain) and types and clicks
  with real input events so modern form frameworks accept the answers. It never submits the
  application, never solves CAPTCHAs, and detaches when done; Chrome shows its debugging bar the
  whole time.
- **Single purpose:** unchanged; the agent completes the same application forms.
- **Privacy answers:** add the form-structure descriptions and the occasional screenshot of the
  visible tab sent while the agent runs (see the privacy disclosure's "The form agent" section).
- **Minimum Chrome version:** 125.
