# Agent context and batching

The model fills known answers top to bottom before asking unknowns one at a time.
`fill_form` accepts up to 25 independent fields, including popup textboxes as
selects. Independent uploads may share a turn. Navigation and dependent controls
still require a fresh observation. Every action passes the existing guards.

Every reply retains the message/actions JSON envelope. The prompt starts with
this contract and a silent-turn example. Malformed output still requires model
correction; no inferred wording or user-answer parsing was added. Field questions
must name a current field or choice-option ref, so the user's answer/skip binds
to that control. Completion refusals include refs as well as labels.

After the first observation, snapshots include still-open fields and changed
controls. Unchanged settled controls (including siblings of answered choice
questions) and unchanged non-form controls are omitted. Failed/unverified writes,
errors, invalid fields and open popups stay visible. Cleared groups return with
all their options. Group and section dictionaries avoid repeating long labels.
Unchanged page text is available through `get_page_text`; `read_page` (up to 150
controls) and `find` retrieve full current controls, including omitted fields.
Unchanged auxiliary controls retain a compact current-ref inventory, preserving
navigation discovery; unanswered button choices retain their full group state.
Navigation or a new document resets the delta. All completion checks use the
full observation, never the reduced snapshot. No cached value repairs page truth.

`review` feedback leads with current required/optional fields needing attention,
so those fields are not buried behind filled-field details or truncated at 1500
characters. The full field list remains available through `read_page`.

History retains 16 recent messages with tool-call/result pairing. Older results
shrink to 400 characters. User answers (up to 1000 characters each) and deduplicated
user instructions accompany current snapshots; filled labels are no longer
repeated there. Switches and safety limits remain unchanged. The shorter system
prompt keeps the two-pass order, drafting, consent/legal confirmation, no-overwrite,
CAPTCHA, navigation, review and submission behavior. `run_js` instructions explain
expression/IIFE syntax and prohibit bypassing guarded refusals.

The tool observation adapter gives popup textboxes and comboboxes the same
combobox role/capability, keeping identities stable across shared-observer role
changes. Observed values remain untouched: lost selections still reappear empty
for recovery. This does not change `src/page-control/` classification.
