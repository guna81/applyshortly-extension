# Apply Shortly Form Assistant privacy disclosure

For the hosted service, see the published [Privacy](https://applyshortly.com/privacy) and
[Terms](https://applyshortly.com/terms). This disclosure covers extension version 0.3.1.

## Scope and contact

Apply Shortly Form Assistant helps you fill job application forms from your ApplyShortly profile and
saved answers. It submits an application only when you choose Auto apply (in the extension, or
by clicking Apply for that job in ApplyShortly), and then only by clicking the employer's own
Submit button after a countdown you can cancel. Otherwise you review
the form and click the employer's Submit button. This policy describes the extension connecting to `https://applyshortly.com`.
For that hosted service, privacy questions go to `admin@applyshortly.com`. If you use another
ApplyShortly server, its operator controls the server-side processing and policy.

## Information processed

- Account information and connection credentials needed to authenticate the extension.
- Your saved profile, résumé, preferences and answer bank, including contact information,
  location, employment, education, work authorisation and compensation answers where provided.
- Application form questions, labels, choices and current field values on pages where you use
  autofill, plus page URLs used to find and track an application.
- Assistant messages and recent conversation sent with each assistant request.
- For tracked applications: open, fill, error and submission-related events; filled field
  labels/values and unresolved field labels stored with the application run.
- AI usage and cost information needed to enforce credits, limits and billing choices.

The extension does not collect general browsing history for advertising. Content scripts are
available across sites because employers use many different application domains. A fill starts
on your request, an ApplyShortly application link, or continuation of a form already started.
On the ApplyShortly website itself, the extension reads only whether the site is signed in, so
its own sign-in follows the website's.

## Where information goes

The extension requests profile data and sends the information above to its configured
ApplyShortly server to provide autofill, account connection, application tracking and requested
assistant features. Optional AI drafting and assistant requests send relevant messages, profile
or job information, questions, options and answers through that server to the selected provider.
Supported personal-key providers are OpenAI, Anthropic and Google Gemini. Their processing and
retention terms apply; a personal provider key does not bypass the ApplyShortly server.

When the extension fills a field or attaches your résumé, that information becomes available to
the employer website. The website may read or transmit it before submission. Review that site's
privacy policy. The extension cannot control employer page scripts.

## The form agent

When you start the form agent, the extension uses Chrome's debugger permission on that tab only,
until it finishes or you stop it (Chrome shows a bar while it is attached). After each step it
sends ApplyShortly a description of the application form on the page: the page URL
and title, the form's questions, options, buttons, the values currently in the fields, and the
page's own error messages. When the agent is stuck it also sends a screenshot of the visible part
of the tab. The server uses these to choose the next step, sending them to the selected AI provider
when a step needs AI; it keeps a short-lived session (about two hours) and does not store page
descriptions or screenshots. Buttons the agent clicked to get through a form (their labels only,
no answers) are kept per website so later visits need no AI. Answers you type in reply to the
agent's questions are saved to your answer bank.

## Autopilot windows

If you turn on nightly submission in ApplyShortly, the extension asks ApplyShortly about once a
minute whether a job needs your signed-in browser. A reply contains only that job's link, its
application number and a one-time code. The extension opens the link in a separate window and runs
Auto apply as described below, then closes that window. Nothing about your browsing is sent in the
request. You can turn this off in the extension's Settings.

## Auto apply and submission records

Ordinary filling does not submit. In versions that offer Auto apply, choosing it (in the
extension, or with Apply in ApplyShortly, which opens the job with a one-time code the extension
checks with ApplyShortly once) authorises
clicking the employer's Submit button after a three-second countdown with Cancel; closing or
minimising the panel cancels it. Auto apply checks detected required fields, browser validity,
an identifiable single Submit button and tracked application status. These checks depend on
page detection and do not guarantee correctness or employer acceptance. Required consent and
upload steps may still need you. Review answers, attachments and AI drafts first: an AI draft
can be submitted as filled without separate approval of that draft.

Submission sends form values and attachments to the employer or its application service.
For tracked applications, ApplyShortly stores attempt and confirmation events; an unconfirmed
attempt is Needs verification, excluded from submitted metrics, and blocks retries/autofill
until resolved. Confirmation may be detected on the page or supplied by the user. Starting the extension on a posting creates or reuses an application record in your connected
account using its URL, page title and company. Attempt and confirmation metadata (without form
answers) is kept in restricted local extension storage while delivery is pending; temporary
connection failures retry once a minute. Signing out clears pending metadata.

## Storage and security

Chrome extension-local storage holds the connection credential and preferences. Access is
restricted to trusted extension contexts; credentials are not placed in Chrome sync storage,
the installation package, or employer page scripts. Short-lived sign-in and tab state use
session storage. Profile data is fetched when needed to fill the page.

Personal AI provider keys are sent to the ApplyShortly server and stored encrypted there.
Provider settings return configured-provider metadata rather than the key. The server stores
hashes of extension authentication credentials and uses HTTPS for the hosted connection.

The assistant's conversation remains in the current page until you leave. The server processes
it per request without saving it as an account conversation. This does not mean all related
data is transient: tracked fill events and AI usage/cost records are stored separately, and
the selected provider's retention terms still apply.

## Choices and deletion

You may keep automatic AI drafting off, request individual drafts, or select a supported
personal AI key instead of ApplyShortly credits. You can replace or delete that key in Settings.
Logging out of the extension revokes its current credential and, for automatic sign-in, also
signs that browser out of the website. Uninstalling clears its browser
storage but does not delete the server account, profile or applications.

Saved profile, answers and application records remain until deleted. Account deletion removes
account-owned records and files from the active service. Routine hosted database backups can
contain deleted records until they expire after 14 days. Payment and AI providers apply their
own retention policies; downloaded exports remain copies you control. The operator is Guna (ApplyShortly).

## Chrome limited-use commitments

The operator approved the three Chrome certifications for v0.3.0 on 18 October 2026.
Re-check them against the next package and revised policy before release:
user data is not sold or transferred outside approved use cases; data is not used or transferred
for purposes unrelated to the extension's single purpose; and data is not used or transferred
to determine creditworthiness or for lending. The final disclosure must describe the selected
processors consistently with these commitments and the service's actual operation.
