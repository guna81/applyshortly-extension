import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionPlanner } from '../src/extension-agent.js';
import { assertRefused } from './refusal.mjs';

const field = { ref: 'name', role: 'textbox', name: 'Full name', required: true, value: 'Candidate' };
const body = (extra = {}) => ({ observation: { observation_id: 'obs', document_id: 'doc', url: 'https://jobs.example/apply', elements: [field], errors: [], coverage: [], more_below: false }, results: [], ...extra });
const ready = { status: 'ready_for_review', message: 'Ready' };

test('platform and direct model adapters receive identical prompts and produce identical commands', async () => {
  const seen = [];
  const make = (provider) => extensionPlanner({ provider }, { full_name: 'Candidate' }, {}, async (_config, messages) => {
    seen.push(messages);
    return JSON.stringify({ status: 'continue', message: 'Check', action: { type: 'review' } });
  });
  const platform = await make('platform')(body());
  const direct = await make('local')(body());
  assert.deepEqual(seen[0], seen[1]);
  const { command_id: _p, ...p } = platform.actions[0];
  const { command_id: _d, ...d } = direct.actions[0];
  assert.deepEqual(p, d);
});

test('completion requires a matching fresh review receipt and a separate model audit', async () => {
  const calls = [];
  const planner = extensionPlanner({}, {}, {}, async (_c, messages) => { calls.push(JSON.parse(messages[1].content)); return JSON.stringify(ready); });
  const first = await planner(body());
  assert.equal(first.status, 'continue');
  assert.equal(first.actions[0].type, 'review');
  const stale = await planner(body({ results: [{ command_id: 'old', ok: true, result: { type: 'review' } }] }));
  assert.equal(stale.status, 'continue');
  const result = await planner(body({ results: [{ command_id: stale.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(result.status, 'ready_for_review');
  assert.equal(calls.at(-1).audit, true);
});

test('a failed audit keeps the application with the user', async () => {
  const planner = extensionPlanner({}, {}, {}, async (_c, messages) => JSON.stringify(JSON.parse(messages[1].content).audit
    ? { status: 'ask_user', message: 'Check the answer', question: { text: 'Confirm your work history' } } : ready));
  const first = await planner(body());
  const result = await planner(body({ results: [{ command_id: first.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(result.status, 'ask_user');
  assert.deepEqual(result.actions, []);
  assert.match(result.question.text, /work history/);
});

test('blockers stop locally without a model call', async () => {
  const planner = extensionPlanner({}, {}, {}, async () => { throw new Error('must not call'); });
  const input = body();
  input.observation.blockers = ['captcha'];
  input.observation.elements = [];
  const result = await planner(input);
  assert.equal(result.question.kind, 'blocker');
  assert.deepEqual(result.actions, []);
});

test('inspect-only stays active across intermediate observations', async () => {
  let calls = 0;
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(++calls === 1
    ? { status: 'continue', message: 'Check', action: { type: 'review' } }
    : { status: 'continue', message: 'Write', action: { type: 'type', ref: 'name', text: 'Changed' } }));
  await planner(body({ inspect_only: true, user_message: 'What is missing?' }));
  await assertRefused(planner, body(), /question cannot change/i);
});


test('a page change invalidates a matching but outdated review', async () => {
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(ready));
  const first = await planner(body());
  const changed = body({ results: [{ command_id: first.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [] } }] });
  changed.observation.elements = [{ ...field, value: 'User correction' }];
  const result = await planner(changed);
  assert.equal(result.status, 'continue');
  assert.equal(result.actions[0].type, 'review');
});


test('verified values are removed from the ledger when the user corrects them', async () => {
  let first = true;
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(first
    ? (first = false, { status: 'continue', message: 'Fill', action: { type: 'type', ref: 'name', text: 'AI answer' } })
    : { status: 'ask_user', message: 'Continue', question: { kind: 'click', text: 'Continue?' } }));
  const empty = body();
  empty.observation.elements = [{ ...field, value: '' }];
  const write = await planner(empty);
  const input = body({ results: [{ command_id: write.actions[0].command_id, ok: true, result: { verified: true } }] });
  input.observation.elements = [{ ...field, value: 'AI answer' }];
  assert.equal((await planner(input)).filled.length, 1);
  input.results = [];
  input.observation.elements = [{ ...field, value: 'My correction', user_edited: true }];
  assert.equal((await planner(input)).filled.length, 0);
});

test('the shared planner can attach an available cover letter', async () => {
  const planner = extensionPlanner({}, {}, { cover_letter: 'Saved letter' }, async () => JSON.stringify({ status: 'continue', message: 'Attach letter', action: { type: 'upload', ref: 'letter' } }));
  const input = body();
  input.observation.elements = [{ ref: 'letter', role: 'file', name: 'Upload cover letter' }];
  assert.equal((await planner(input)).actions[0].file, 'cover_letter');
});


test('a user correction survives an intermediate inspection', async () => {
  let calls = 0;
  const planner = extensionPlanner({}, {}, {}, async (_c, messages) => {
    assert.match(messages[1].content, /change Full name to Corrected/);
    return JSON.stringify(++calls === 1
      ? { status: 'continue', message: 'Checking', action: { type: 'review' } }
      : { status: 'continue', message: 'Correcting', action: { type: 'type', ref: 'name', text: 'Corrected' } });
  });
  await planner(body({ user_message: 'change Full name to Corrected' }));
  assert.equal((await planner(body())).actions[0].text, 'Corrected');
});

const orderedBody = (elements, extra = {}) => ({ ...body(extra), observation: { ...body().observation, elements } });
const blank = (ref, name, role = 'textbox', extra = {}) => ({ ref, name, role, value: '', required: true, ...extra });
const questionPlan = { status: 'ask_user', message: 'Missing', question: { kind: 'question', ref: 'later', text: 'Later?' } };

test('a required attachment the agent cannot fill is handed to the user once the model says it is done, even across ref changes', async () => {
  let context;
  const elements = [blank('name', 'Full name', 'textbox', { value: 'Example' }), blank('file', 'Transcript', 'file', { identity: 'transcript' }), blank('email', 'Email', 'textbox', { value: 'example@example.test' })];
  const planner = extensionPlanner({}, { full_name: 'Example', email: 'example@example.test' }, {}, async (_c, messages) => { context = JSON.parse(messages[1].content); return JSON.stringify(ready); });
  const handoff = await planner(orderedBody(elements));
  assert.equal(handoff.question.kind, 'click'); assert.equal(handoff.question.ref, 'file'); assert.deepEqual(handoff.actions, []);
  assert.equal(Object.values(context.deferred_manual_uploads)[0], 'Transcript');
  elements[1].ref = 'new-file';
  // Continue hands the attachment to the user: it is waited for on the page, never asked again (even after a re-render gives it a new ref).
  const waiting = await planner(orderedBody(elements, { resumed: true }));
  assert.equal(waiting.status, 'ask_user'); assert.equal(waiting.question.ref, null); assert.match(waiting.question.text, /Transcript/);
  elements[1].value = 'transcript.pdf';
  assert.equal((await planner(orderedBody(elements, { resumed: true }))).actions[0].type, 'review');
});

test('unavailable and ambiguous uploads never receive an automatic resume', async () => {
  for (const [profile, elements] of [
    [{}, [blank('file', 'Resume', 'file')]],
    [{ resume_url: 'https://files.example.test/resume.pdf' }, [blank('file', 'Upload document', 'file'), blank('other', 'Upload document', 'file')]],
    [{ resume_url: 'https://files.example.test/resume.pdf' }, [blank('file', 'Cover letter', 'file')]],
  ]) {
    const planner = extensionPlanner({}, profile, {}, async () => JSON.stringify({ status: 'continue', message: 'Upload', action: { type: 'upload', ref: 'file' } }));
    const result = await planner(orderedBody(elements));
    assert.equal(result.status, 'ask_user'); assert.equal(result.question.kind, 'click'); assert.deepEqual(result.actions, []);
  }
});

test('required manual upload cannot become ready even after explicitly skipping it', async () => {
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(ready));
  const elements = [blank('file', 'Transcript', 'file')];
  const first = await planner(orderedBody(elements)); assert.equal(first.question.ref, 'file');
  const skipped = await planner(orderedBody(elements, { skip_question: true }));
  assert.equal(skipped.status, 'ask_user'); assert.deepEqual(skipped.actions, []);
});

test('manual upload recovery does not relax wrong-role and stale-ref guards', async () => {
  const elements = [blank('file', 'Transcript', 'file'), blank('text', 'Attachment description')];
  for (const ref of ['text', 'stale']) {
    const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Upload', action: { type: 'upload', ref } }));
    await assertRefused(planner, orderedBody(elements), /profile résumé|no longer on the page/);
  }
});

test('a click on an option of an open dropdown becomes a select on its combobox', async () => {
  const combo = { ref: 'loc', role: 'combobox', name: 'Location', required: true, value: 'Tiruchirappalli', popup: true };
  const option = { ref: 'opt', role: 'button', name: 'Tiruchirappalli, Tamil Nadu, India' };
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Pick', action: { type: 'click', ref: 'opt' } }));
  const b = body();
  b.observation.elements = [combo, option];
  const result = await planner(b);
  assert.equal(result.actions[0].type, 'select');
  assert.equal(result.actions[0].ref, 'loc');
  assert.equal(result.actions[0].text, 'Tiruchirappalli, Tamil Nadu, India');
});

test('a suggestion click works for a plain textbox typeahead and for role=option suggestions', async () => {
  for (const [field, suggestion, typed] of [
    [{ ref: 'loc', role: 'textbox', name: 'Location (City)', required: true }, { ref: 'opt', role: 'button', name: 'Tiruchirappalli, Tamil Nadu, India' }, 'Tiruchirappalli, India'],
    [{ ref: 'loc', role: 'textbox', name: 'Location (City)', required: true, expanded: true }, { ref: 'opt', role: 'option', name: 'Tiruchirappalli, Tamil Nadu, India' }, 'Tiruchirappalli'],
  ]) {
    const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Pick', action: { type: 'click', ref: 'opt' } }));
    const b = body();
    b.observation.elements = [{ ...field, value: typed }, suggestion];
    const result = await planner(b);
    assert.equal(result.actions[0].type, 'select');
    assert.equal(result.actions[0].ref, 'loc');
    assert.equal(result.actions[0].text, 'Tiruchirappalli, Tamil Nadu, India');
  }
});

test('a click on an unrelated button is still refused', async () => {
  const combo = { ref: 'loc', role: 'combobox', name: 'Location', required: true, value: 'Tiruchirappalli', popup: true };
  const other = { ref: 'x', role: 'button', name: 'Something else' };
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Go', action: { type: 'click', ref: 'x' } }));
  const b = body();
  b.observation.elements = [combo, other];
  await assertRefused(planner, b, /direct approval/);
});

// A Yes/No question built from plain buttons (aria-pressed), on a site no detector knows.
const pills = (pressedNo = false, name = 'Have you used Python professionally?') => [
  { ref: 'yes', role: 'button', name: 'Yes', group: name, required: true, pressed: false },
  { ref: 'no', role: 'button', name: 'No', group: name, required: true, pressed: pressedNo },
];
const pillBody = (elements, extra = {}) => body({ observation: { ...body().observation, elements }, ...extra });
const answer = (action) => extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Answer', action }));

for (const action of [
  { type: 'type', ref: 'yes', text: 'No' },
  { type: 'select', ref: 'yes', text: 'no' },
  { type: 'click', ref: 'no' },
  { type: 'check', ref: 'no', checked: true },
]) {
  test(`a ${action.type} at a choice button answers the matching option instead of failing`, async () => {
    const result = await answer(action)(pillBody(pills()));
    assert.equal(result.status, 'continue');
    assert.equal(result.actions[0].type, 'check');
    assert.equal(result.actions[0].ref, 'no');
    assert.equal(result.actions[0].checked, true);
  });
}

test('a choice button question that already has an answer is not overwritten', async () => {
  await assertRefused(answer({ type: 'type', ref: 'yes', text: 'Yes' }), pillBody(pills(true)), /overwrite|existing answer/i);
});

test('a consent choice button still needs the user', async () => {
  const elements = pills(false, 'I agree to the privacy policy and consent to data processing');
  const result = await answer({ type: 'click', ref: 'yes' })(pillBody(elements));
  assert.equal(result.status, 'ask_user');
  assert.equal(result.question.ref, 'yes');
  assert.deepEqual(result.actions, []);
});

test('a final submit button is never treated as a choice option', async () => {
  const elements = [{ ref: 's', role: 'button', name: 'Submit application', group: 'Done?', pressed: false, submit_like: true }, { ref: 'x', role: 'button', name: 'Back', group: 'Done?', pressed: false }];
  await assertRefused(answer({ type: 'click', ref: 's' }), pillBody(elements), /direct approval/i);
});

test('typing into a button explains which action fits', async () => {
  const elements = [{ ref: 'b', role: 'button', name: 'Next' }];
  await assertRefused(answer({ type: 'type', ref: 'b', text: 'hello' }), pillBody(elements), /is a button, not a text field/);
});

test('an eligibility choice button (visa, work authorization) keeps needing the user, as a radio does', async () => {
  const elements = pills(false, 'Will you now or in the future require visa sponsorship?');
  const result = await answer({ type: 'type', ref: 'no', text: 'No' })(pillBody(elements));
  assert.equal(result.status, 'ask_user');
  assert.deepEqual(result.actions, []);
});

test('a click on a radio option is a check on it (a plain radio group, no consent wording)', async () => {
  const radios = [{ ref: 'a', role: 'radio', name: 'Yes', group: 'Open to relocation?', checked: false, required: true }, { ref: 'b', role: 'radio', name: 'No', group: 'Open to relocation?', checked: false, required: true }];
  const result = await answer({ type: 'click', ref: 'a' })(pillBody(radios));
  assert.deepEqual([result.actions[0].type, result.actions[0].ref, result.actions[0].checked], ['check', 'a', true]);
});

test('press and hover are accepted on a field; unsafe keys are refused', async () => {
  const field = { ref: 'f', role: 'combobox', name: 'Location', required: true, value: 'Tir', popup: true };
  const planner = (action) => extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Go', action }));
  assert.equal((await planner({ type: 'press', ref: 'f', key: 'ArrowDown' })(pillBody([field]))).actions[0].key, 'ArrowDown');
  assert.equal((await planner({ type: 'hover', ref: 'f' })(pillBody([field]))).actions[0].type, 'hover');
  await assertRefused(planner({ type: 'press', ref: 'f', key: 'Control+Enter' }), pillBody([field]), /not allowed/);
});

test('typing into a combobox or typeahead is a select; a chosen Yes/No counts as filled', async () => {
  const combo = { ref: 'loc', role: 'combobox', name: 'Location', required: true, value: '', popup: true };
  const typed = await answer({ type: 'type', ref: 'loc', text: 'India' })(pillBody([combo]));
  assert.deepEqual([typed.actions[0].type, typed.actions[0].text], ['select', 'India']);

  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Answer', action: { type: 'check', ref: 'yes', checked: true } }));
  const first = await planner(pillBody(pills()));
  const done = pills(); done[0].pressed = true;
  const next = await planner(pillBody(done, { results: [{ command_id: first.actions[0].command_id, ok: true, result: { verified: true } }] }));
  assert.equal(next.filled.length, 1);
  assert.equal(next.filled[0].label, 'Have you used Python professionally?');
});

test('a Yes/No question made of buttons is asked when the profile has no answer, and the reply is offered to the model as the answer', async () => {
  const yesNo = (value = false) => ['Yes', 'No'].map((name, i) => ({ ref: `yn${i}`, name, role: 'button', group: 'Do you have a security clearance?', pressed: value && i === 0, required: true, value: '' }));
  const prompts = [];
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async (_c, messages) => {
    prompts.push(JSON.parse(messages[1].content));
    return JSON.stringify(prompts.length === 1
      ? { status: 'ask_user', message: 'Needs you', question: { kind: 'question', ref: 'yn0', text: 'Do you have a security clearance?' } }
      : { status: 'continue', message: 'Answering', actions: [{ type: 'check', ref: 'yn1', checked: true }] });
  });
  const asked = await planner(orderedBody([blank('name', 'Full name', 'textbox', { value: 'Example' }), ...yesNo()]));
  assert.equal(asked.status, 'ask_user'); assert.match(asked.question.text, /security clearance/); assert.equal(asked.question.ref, 'yn0');
  const answered = await planner(orderedBody([blank('name', 'Full name', 'textbox', { value: 'Example' }), ...yesNo()], { user_reply: 'No' }));
  assert.deepEqual(prompts[1].suggested_actions.map((a) => [a.type, a.ref, a.checked]), [['check', 'yn1', true]]);
  assert.deepEqual([answered.actions[0].type, answered.actions[0].ref, answered.actions[0].checked], ['check', 'yn1', true]);
});

test('an answer that names none of the question\'s options is left for review and the question is not asked again', async () => {
  const options = () => ['News', 'LinkedIn Jobs', 'Company website'].map((name, i) => ({ ref: `h${i}`, name, role: 'button', group: 'How did you hear about this opportunity?', pressed: false, required: false, value: '' }));
  const elements = () => [blank('name', 'Full name', 'textbox', { value: 'Example' }), ...options()];
  const asks = [];
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify({ status: 'ask_user', message: 'Needs you', question: { kind: 'question', ref: 'h0', text: 'How did you hear about this opportunity?' } }));
  const first = await planner(orderedBody(elements()));
  assert.equal(first.status, 'ask_user');
  for (const reply of ['Online search', 'Online search']) {
    const next = await planner(orderedBody(elements(), { user_reply: reply }));
    asks.push(next.question?.kind === 'question' && /hear/.test(next.question.text));
    assert.ok(!next.actions.some((a) => a.type === 'check'), 'the agent must not tick an option the person did not name');
  }
  assert.deepEqual(asks, [false, false]);
});

test('an answer that names one of the options is still applied', async () => {
  const options = () => ['News', 'LinkedIn Jobs', 'Company website'].map((name, i) => ({ ref: `h${i}`, name, role: 'button', group: 'How did you hear about this opportunity?', pressed: false, required: false, value: '' }));
  const elements = () => [blank('name', 'Full name', 'textbox', { value: 'Example' }), ...options()];
  const prompts = [];
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async (_c, messages) => {
    prompts.push(JSON.parse(messages[1].content));
    return JSON.stringify(prompts.length === 1
      ? { status: 'ask_user', message: 'Needs you', question: { kind: 'question', ref: 'h0', text: 'How did you hear about this opportunity?' } }
      : { status: 'continue', message: 'Answering', actions: [{ type: 'check', ref: 'h1', checked: true }] });
  });
  await planner(orderedBody(elements()));
  const answered = await planner(orderedBody(elements(), { user_reply: 'LinkedIn Jobs, News' }));
  assert.equal(answered.actions[0].type, 'check');
  assert.equal(answered.actions[0].ref, 'h1');
});

test('an optional attachment the agent cannot fill is not asked about', async () => {
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify(ready));
  const result = await planner(orderedBody([blank('name', 'Full name', 'textbox', { value: 'Example' }), blank('autofill', 'File upload', 'file', { required: false })]));
  assert.notEqual(result.question?.ref, 'autofill');
  assert.doesNotMatch(result.question?.text ?? '', /File upload/);
});

test('a question the model asks about an optional attachment the agent cannot fill is dropped, not put to the user', async () => {
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify({ status: 'ask_user', message: 'ask', question: { kind: 'question', ref: 'cover', text: 'Would you like to provide a cover letter?' } }));
  const result = await planner(orderedBody([blank('name', 'Full name', 'textbox', { value: 'Example' }), blank('cover', 'Cover Letter', 'file', { required: false })]));
  assert.notEqual(result.question?.ref, 'cover');
  assert.doesNotMatch(result.question?.text ?? '', /cover letter/i);
  assert.notEqual(result.status, 'ask_user');
  assert.equal(result.actions[0]?.type, 'review');
});

test('Continue on an unchanged page accepts a check-the-page hold, even when the model rewords it, and the run carries on', async () => {
  const holds = ['Please review and answer the declaration on the page.', 'Please confirm on the page whether everything is true.', 'Check the declaration, then tap Continue.'];
  let turn = 0;
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify({ status: 'ask_user', message: 'Needs you', question: { kind: 'click', text: holds[turn++ % holds.length] } }));
  const elements = [blank('name', 'Full name', 'textbox', { value: 'Example' }), blank('why', 'Why this role?', 'textarea')];
  const first = await planner(orderedBody(elements));
  assert.equal(first.question.kind, 'click');
  // The user taps Continue; the page is unchanged. The model raises the same hold again in other words.
  const second = await planner(orderedBody(elements, { resumed: true }));
  assert.notEqual(second.question?.kind, 'click');
  assert.equal(second.question?.ref, 'why');
  // A page that did change since the hold is judged afresh: a new hold is allowed again.
  await planner(orderedBody(elements));
  const changed = await planner(orderedBody([...elements, blank('extra', 'Extra', 'textbox', { value: 'x' })], { resumed: true }));
  assert.equal(changed.question?.kind, 'click');
});

test('a required attachment the agent cannot fill is still put to the user when the model asks', async () => {
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify({ status: 'ask_user', message: 'ask', question: { kind: 'question', ref: 'cv', text: 'Please attach your transcript' } }));
  const result = await planner(orderedBody([blank('name', 'Full name', 'textbox', { value: 'Example' }), blank('cv', 'Transcript', 'file', { required: true })]));
  assert.equal(result.status, 'ask_user');
});

test('a typeahead holding only the search text the agent typed can still be answered with a listed option', async () => {
  const typeahead = (value) => [blank('loc', 'Location', 'combobox', { value, popup: true })];
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, (() => { let n = 0; return async () => JSON.stringify(n++ === 0
    ? { status: 'continue', message: 'Search', action: { type: 'type', ref: 'loc', text: 'Trichy' } }
    : { status: 'continue', message: 'Pick', action: { type: 'select', ref: 'loc', text: 'Tiruchirappalli, Tamil Nadu, India' } }); })());
  assert.equal((await planner(orderedBody(typeahead('')))).actions[0].text, 'Trichy');
  assert.equal((await planner(orderedBody(typeahead('Trichy')))).actions[0].text, 'Tiruchirappalli, Tamil Nadu, India');
});

test('a question that bundles several is reduced to the one field it points at', async () => {
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify({ status: 'ask_user', message: 'ask', question: { kind: 'question', ref: 'q', text: 'Are you authorized to work? Also, do you need a visa? And were you employed here?' } }));
  const result = await planner(orderedBody([blank('q', 'Are you legally authorized to work?', 'textbox')]));
  assert.equal(result.question.text, 'Please answer: Are you legally authorized to work?');
});

test('the final review holds the form back once; Continue on the same page accepts it', async () => {
  let audits = 0;
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async (_c, messages) => {
    if (JSON.parse(messages[1].content).audit) { audits += 1; return JSON.stringify({ status: 'ask_user', message: 'Check the country', question: { kind: 'click', text: 'Check the country' } }); }
    return JSON.stringify(ready);
  });
  const first = await planner(body());
  const reviewed = await planner(body({ results: [{ command_id: first.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(reviewed.status, 'ask_user');
  assert.equal(audits, 1);
  const after = await planner(body({ resumed: true }));
  assert.equal(after.status === 'ready_for_review' || after.actions?.[0]?.type === 'review', true);
  const again = await planner(body({ results: [{ command_id: after.actions?.[0]?.command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(again.status, 'ready_for_review');
  assert.equal(audits, 1);
});

test('with "Let AI answer" off, a newly generated long answer is offered as a question before it is written', async () => {
  const planner = extensionPlanner({}, { summary: 'Built healthcare copilots and RAG systems.' }, {}, async () => JSON.stringify({ status: 'continue', message: 'Drafting', action: { type: 'type', ref: 'essay', text: 'I build healthcare copilots. I work with RAG systems.' } }), undefined, false);
  const result = await planner(orderedBody([blank('essay', 'Why are you interested in this opportunity?', 'textarea')]));
  assert.equal(result.status, 'ask_user');
  assert.equal(result.question.ref, 'essay');
  assert.deepEqual(result.actions, []);
});

test('with "Let AI answer" on (the default), a long answer is drafted from the profile, marked for review, and kept to two sentences', async () => {
  let shortened = 0;
  const planner = extensionPlanner({}, { summary: 'Built healthcare copilots and RAG systems.' }, {}, async (_c, messages) => {
    if (/Shorten the requested draft/.test(messages[0].content)) { shortened += 1; return JSON.stringify({ status: 'continue', message: 'Shorter', actions: [{ type: 'type', ref: 'essay', text: 'I build healthcare copilots with RAG systems.' }] }); }
    return JSON.stringify({ status: 'continue', message: 'Drafting', action: { type: 'type', ref: 'essay', text: 'I build healthcare copilots. I work with RAG systems. I like the mission. I want to grow.' } });
  });
  const result = await planner(orderedBody([blank('essay', 'Why are you interested in this opportunity?', 'textarea')]));
  assert.equal(result.status, 'continue');
  assert.equal(result.actions[0].text, 'I build healthcare copilots with RAG systems.');
  assert.equal(shortened, 1);
});

test('"Let AI answer" never drafts a consent or legal declaration', async () => {
  const planner = extensionPlanner({}, { summary: 'Built copilots.' }, {}, async () => JSON.stringify({ status: 'continue', message: 'Drafting', action: { type: 'type', ref: 'essay', text: 'I certify that I am authorised to work.' } }));
  const result = await planner(orderedBody([blank('essay', 'Please explain why you declare you are eligible to work', 'textarea')]));
  assert.notEqual(result.actions?.[0]?.text, 'I certify that I am authorised to work.');
});

test('Draft it for me is an instruction for the pending field, never a saved answer', async () => {
  let context;
  const planner = extensionPlanner({}, { summary: 'Built healthcare copilots.' }, {}, async (_c, messages) => {
    context = JSON.parse(messages[1].content);
    return JSON.stringify(context.user_message?.startsWith('Draft it for me')
      ? { status: 'continue', message: 'Drafted from your profile', action: { type: 'type', ref: 'essay', text: 'I have built healthcare copilots.' } }
      : { status: 'ask_user', message: 'Your answer', question: { kind: 'question', ref: 'essay', text: 'Why this role?' } });
  });
  const elements = [blank('essay', 'Why this role?', 'textarea')];
  await planner(orderedBody(elements));
  const result = await planner(orderedBody(elements, { user_reply: 'Draft it for me' }));
  assert.equal(result.actions[0]?.text, 'I have built healthcare copilots.');
  assert.equal(context.user_answered.some((a) => a.answer === 'Draft it for me'), false);
  assert.match(context.user_message, /one or two.*profile/i);
});

test('an explicitly requested legal-situation draft is offered as profile facts and is accepted when the model uses it', async () => {
  let drafting = false;
  const planner = extensionPlanner({}, { preferences: { work_authorization: { India: 'Citizen' }, requires_sponsorship: true } }, { location: 'United Kingdom' }, async (_c, messages) => JSON.stringify(drafting
    ? { status: 'continue', message: 'Profile facts only', action: { type: 'type', ref: 'visa', text: JSON.parse(messages[1].content).suggested_actions[0].text } }
    : { status: 'ask_user', message: 'Your situation', question: { kind: 'question', ref: 'visa', text: 'Describe your work authorization situation.' } }));
  const elements = [blank('visa', 'Describe your work authorization situation.', 'textarea')];
  await planner(orderedBody(elements)); drafting = true;
  const result = await planner(orderedBody(elements, { user_reply: 'Draft it for me' }));
  assert.equal(result.actions[0]?.type, 'type');
  assert.equal(result.actions[0].text, 'My profile lists my work authorization as India: Citizen. My profile states that I require visa sponsorship.');
});

test('a requested narrative longer than two sentences is shortened before any write', async () => {
  let calls = 0;
  const planner = extensionPlanner({}, { summary: 'Built healthcare copilots and RAG systems.' }, {}, async () => JSON.stringify(++calls === 1
    ? { status: 'ask_user', message: 'Your answer', question: { kind: 'question', ref: 'essay', text: 'Why this role?' } }
    : { status: 'continue', message: 'Drafted', action: { type: 'type', ref: 'essay', text: calls === 2 ? 'I build copilots. I build retrieval systems. I deploy AI.' : 'I build healthcare copilots and retrieval systems. I deploy AI systems.' } }));
  const elements = [blank('essay', 'Why this role?', 'textarea')];
  await planner(orderedBody(elements));
  const result = await planner(orderedBody(elements, { user_reply: 'Draft it for me' }));
  assert.equal(result.actions[0].text, 'I build healthcare copilots and retrieval systems. I deploy AI systems.');
});

test('an answered multi-checkbox question is not reopened for its unchecked alternatives', async () => {
  const elements = ['News', 'Company website', 'Referral'].map((name, i) => ({ ref: `source${i}`, name, role: 'checkbox', group: 'How did you hear about this opportunity?', required: false, checked: i === 1 }));
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'ask_user', message: 'Source?', question: { kind: 'question', ref: 'source0', text: 'How did you hear about this opportunity?' } }));
  const result = await planner(orderedBody(elements));
  assert.notEqual(result.question?.text, 'How did you hear about this opportunity?');
  assert.notEqual(result.status, 'ask_user');
});

test('ready-for-review lists a skipped optional field instead of silently dropping it', async () => {
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(ready));
  const elements = [blank('extra', 'Additional information', 'textarea', { required: false })];
  await planner(orderedBody(elements));
  const review = await planner(orderedBody(elements, { skip_question: true }));
  const result = await planner(orderedBody(elements, { results: [{ command_id: review.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(result.status, 'ready_for_review');
  assert.deepEqual(result.unresolved, ['Additional information']);
});

test('skipping an optional click question suppresses later model requests about the same control', async () => {
  const elements = [blank('contact', 'Contact consent', 'checkbox', { required: false, checked: false })];
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'ask_user', message: 'Your choice', question: { kind: 'click', ref: 'contact', text: 'Decide whether to consent.', optional: true } }));
  await planner(orderedBody(elements));
  const result = await planner(orderedBody(elements, { skip_question: true }));
  assert.equal(result.actions[0]?.type, 'review');
});

test('Continue after a skipped required-field handoff reaches review and preserves the missing field', async () => {
  const elements = [blank('legal', 'Are you authorized to work abroad?')];
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(ready));
  await planner(orderedBody(elements));
  const handoff = await planner(orderedBody(elements, { skip_question: true }));
  assert.equal(handoff.question.kind, 'click');
  const review = await planner(orderedBody(elements, { resumed: true }));
  assert.equal(review.actions[0]?.type, 'review');
  const result = await planner(orderedBody(elements, { results: [{ command_id: review.actions[0].command_id, ok: true, result: { type: 'review', missing_required: ['Are you authorized to work abroad?'], needs_confirmation: [], errors: [] } }] }));
  assert.equal(result.status, 'ready_for_review');
  assert.deepEqual(result.unresolved, ['Are you authorized to work abroad?']);
});

test('a draft request cannot supply missing legal facts or approve a declaration', async () => {
  for (const name of ['Describe your work authorization situation.', 'Describe and certify your work authorization.']) {
    let drafting = false;
    const planner = extensionPlanner({}, {}, { location: 'United Kingdom' }, async () => JSON.stringify(drafting
      ? { status: 'continue', message: 'Unsupported', action: { type: 'type', ref: 'legal', text: 'I am authorized to work in the United Kingdom.' } }
      : { status: 'ask_user', message: 'Your answer', question: { kind: 'question', ref: 'legal', text: name } }));
    const elements = [blank('legal', name, 'textarea')];
    await planner(orderedBody(elements)); drafting = true;
    const result = await planner(orderedBody(elements, { user_reply: 'Draft it for me' }));
    assert.equal(result.status, 'ask_user');
    assert.deepEqual(result.actions, []);
  }
});

test('Continue after an approved review does not buy another audit or hold the same form back', async () => {
  let audits = 0;
  const planner = extensionPlanner({}, {}, {}, async (_c, messages) => {
    if (JSON.parse(messages[1].content).audit && ++audits > 1) return JSON.stringify({ status: 'ask_user', message: 'Check again', question: { text: 'Check again' } });
    return JSON.stringify(ready);
  });
  const review = await planner(body());
  const result = await planner(body({ results: [{ command_id: review.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(result.status, 'ready_for_review');
  assert.equal((await planner(body({ resumed: true }))).status, 'ready_for_review');
  assert.equal(audits, 1);
});

test('an unreferenced click question is bound to its unique control so skipping it sticks', async () => {
  const elements = [blank('contact', 'Contact consent', 'checkbox', { required: false, checked: false })];
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'ask_user', message: 'Your choice', question: { kind: 'click', text: 'Please decide whether to tick contact consent.' } }));
  const first = await planner(orderedBody(elements));
  assert.equal(first.question.ref, 'contact');
  const result = await planner(orderedBody(elements, { skip_question: true }));
  assert.equal(result.actions[0]?.type, 'review');
});

test('unused optional upload helpers are not reported as remaining application fields', async () => {
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(ready));
  const elements = [blank('name', 'Full name', 'textbox', { value: 'Candidate' }), blank('helper', 'File upload', 'file', { required: false })];
  const review = await planner(orderedBody(elements));
  const result = await planner(orderedBody(elements, { results: [{ command_id: review.actions[0].command_id, ok: true, result: { type: 'review', missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(result.status, 'ready_for_review');
  assert.deepEqual(result.unresolved, []);
});

test('skipping a multi-checkbox question leaves every alternative with the user', async () => {
  const elements = ['Email', 'Phone'].map((name, i) => ({ ref: `contact${i}`, name, role: 'checkbox', group: 'Contact methods', required: true, checked: false }));
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify(ready));
  await planner(orderedBody(elements));
  const skipped = await planner(orderedBody(elements, { skip_question: true }));
  assert.equal(skipped.question.kind, 'click');
  const continued = await planner(orderedBody(elements, { resumed: true }));
  assert.equal(continued.actions[0]?.type, 'review');
});

test('a legal multi-checkbox group asks once instead of stopping the whole run or ticking a declaration', async () => {
  const elements = ['I have nothing to declare', 'I have a conflict'].map((name, i) => ({ ref: `conflict${i}`, name, role: 'checkbox', group: 'Please declare any conflicts of interest', required: true, checked: false }));
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Choosing', action: { type: 'check', ref: 'conflict0', checked: true } }));
  const result = await planner(orderedBody(elements));
  assert.equal(result.status, 'ask_user');
  assert.equal(result.question.ref, 'conflict0');
  assert.deepEqual(result.actions, []);
});

test('an unverified agent write can be corrected to its requested value, while user edits stay protected', async () => {
  const planner = extensionPlanner({}, { phone: '+91 6381868258' }, {}, async () => JSON.stringify({ status: 'continue', message: 'Retry the failed phone write', action: { type: 'type', ref: 'phone', text: '+91 6381868258' } }));
  const phone = blank('phone', 'Phone', 'textbox', { input_type: 'tel' });
  const first = await planner(orderedBody([phone]));
  const failure = { command_id: first.actions[0].command_id, ok: false, result: { verified: false, committed: '+93 6381868258' } };
  const wrong = { ...phone, value: '+93 6381868258' };
  const retry = await planner(orderedBody([wrong], { results: [failure] }));
  assert.equal(retry.actions[0]?.text, '+91 6381868258');
  await assertRefused(planner, orderedBody([{ ...wrong, user_edited: true }]), /overwrite/);
});

test('citizenship in one country does not authorize a guessed answer about another country', async () => {
  const planner = extensionPlanner({}, { preferences: { work_authorization: { India: 'Citizen' } } }, { location: 'Brazil' }, async () => JSON.stringify({ status: 'continue', message: 'Unsupported inference', action: { type: 'select', ref: 'citizen', text: 'No' } }));
  const result = await planner(orderedBody([blank('citizen', 'Are you a citizen or permanent resident of the country where this position is based?', 'combobox')]));
  assert.equal(result.status, 'ask_user');
  assert.deepEqual(result.actions, []);
});

test('an embedded CAPTCHA leaves the challenge untouched while application fields fill', async () => {
  const planner = extensionPlanner({}, { full_name: 'Candidate' }, {}, async () => JSON.stringify({ status: 'continue', message: 'Filling', actions: [{ type: 'type', ref: 'name', text: 'Candidate' }] }));
  const input = orderedBody([blank('name', 'Full name')]);
  input.observation.blockers = ['captcha'];
  const result = await planner(input);
  assert.equal(result.status, 'continue');
  assert.equal(result.actions[0]?.ref, 'name');
  assert.equal(result.actions[0]?.text, 'Candidate');
});

test('the job posting is sent short on an ordinary turn and longer only while an essay field is open', async () => {
  const sizes = [];
  const description = 'We build APIs and data pipelines. '.repeat(300);
  const planner = extensionPlanner({}, { full_name: 'Candidate' }, { title: 'Engineer', description, cover_letter: 'Dear team '.repeat(200) }, async (_c, messages) => {
    const data = JSON.parse(messages[1].content);
    sizes.push([String(data.job.description).length, data.job.cover_letter ? 'cover' : 'no cover']);
    return JSON.stringify({ status: 'ready_for_review', message: 'Done' });
  });
  await planner(orderedBody([blank('city', 'City', 'textbox', { required: false })]));
  await planner(orderedBody([blank('essay', 'Why do you want this job?', 'textarea')]));
  await planner(orderedBody([blank('cl', 'Cover letter', 'textarea')]));
  assert.deepEqual(sizes[0], [1200, 'no cover']);
  assert.deepEqual(sizes[1], [4000, 'no cover']);
  assert.deepEqual(sizes[2], [4000, 'cover']);
});
