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

## Wellhub validation

Platform AI with the throwaway key and dummy profile; tokens estimated as chars/4.

| Run | Model calls | Estimated input tokens | Score | Required filled |
| --- | ---: | ---: | ---: | ---: |
| Original baseline | 59 | ~713,000 | 100 | 100% |
| Previous comparison | 74 | 615,413 | 100 | 100% |
| Current validation | 41 | 286,624 | 100 | 100% |

Current live run: `20261118-214040-bound-questions-compact-context-dropdown`,
build `f1ca1bee4ca4`, outcome `ready_for_review`, zero safety failures and
provider errors. It used 18 questions with zero repeats and completed in 241s.
This is 53.4% fewer estimated input tokens and 44.6% fewer calls than the
previous comparison. One live run was used for this change batch.

All 150 targeted form-agent/guards/loop tests passed. A synthetic Greenhouse run
also scored 100 with 100% required filled and `ready_for_review` (6 calls,
12,547 estimated input tokens). The extension was rebuilt for validation.

Remaining overhead: dropdown option-label mismatch required one recovery;
conditional optional follow-ups still need user answers/skips with Fill optional
enabled. Five such questions had dummy answer-bank gaps in this run. Observed
value loss remains visible and requires recovery; the adapter never invents a
selection. These results validate one Wellhub run, not every site or model run.

### Repeat and cross-ATS checks (2026-11-19)

After the checkout's TypeScript migration, the same 150 targeted tests passed
(compile sources first with `node scripts/compile_extension.mjs extension/src`).
The free synthetic run `20261119-121046-context-reduction-cross-ats-regression`
passed 11/11 fixtures with zero safety failures: Greenhouse, Ashby, Workable,
Lever, Workday, SmartRecruiters, CAPTCHA forms, multi-step wizard, iCIMS and the
hazard fixture. These are simulated ATS shapes with a fake model, not live-site
accuracy measurements. Workable/hazard intentionally leave unconfirmed legal
or consent fields blank; login/CAPTCHA-only fixtures correctly stop as blocked.

The Wellhub repeat `20261119-121140-repeat-context-reduction-after-typescrip`,
build `e9ef53dd0d68`, used 39 calls and 274,684 estimated input tokens in 226s,
with 100% required filled and `ready_for_review`. Its official score is **0**:
the evaluator counted one invented legal fact (score before that check: 100).
Submit attempts, CAPTCHA touches, overwrites and provider errors were all zero.

Trace investigation shows an apparent evaluator false positive: turn 18 asks
about work authorization at ref `0.22`; turn 19 receives an explicit dummy-user
answer and writes it; turn 20 reports verified success. The evaluator matches
legal confirmation by substring comparison between the field name and logged
question; the paraphrased question does not match. Preserve the failed score
until a ref-based testbed check can validate this evidence; no scorer or safety
guard was changed. That testbed change is outside this source-only task scope.

Remaining avoidable calls in the repeat: one phone-code option-label recovery,
an options-tool isolation refusal, one malformed question-envelope correction,
and two premature completion refusals for optional follow-ups. Further tuning
should target these tool/prompt contracts, rather than shorten history further.

### Fill feedback and chat layout

The shared panel immediately explains the first-fill wait. During subsequent work it
shows a single transient status instead of repeating the previous agent message;
this disappears when the agent asks a question. The agent is instructed to apply
user answers silently and report only verified results. Long choices and lists of
more than four options use wrapping rows in a bounded, scrollable list. Choice text
is preserved in full when sent as the answer, and Agent questions no longer
silently discard choices after the first eight.

Both passes remain in page order. The prompt explicitly includes upload calls and
fields within a batch in that order; the executor preserves the model's sequence.
This is a model instruction, not a deterministic ordering guarantee.

Conditional optional follow-ups are evaluated by the model immediately after the parent answer. The snapshot retains the optional attention checklist; the model must settle applicable optional fields and leave clearly inapplicable follow-ups blank. Optional applicability is prompted rather than vetoed by a blanket blank-field check; the hard required-field completion check is unchanged. This uses the existing no-argument completion contract with both Platform AI and custom providers. Completion uses one brief review instruction. The shared chat keeps a bounded, scrollable history with the composer/footer visible, and uses the agent's ready status rather than an empty legacy scan for its completion header.

A follow-up still marked required after a negative parent must be resolved immediately in its page position: reuse only an accurate explicit parent answer, otherwise ask the user then. It must not wait for the final required-field audit.
