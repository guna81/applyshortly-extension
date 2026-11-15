import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionPlanner } from '../src/extension-agent.js';

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
  await assert.rejects(planner(body()), /question cannot change/i);
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

test('known pass fills page order, bypasses unknowns and delays privacy until its turn', async () => {
  const elements = [blank('unknown', 'Favourite project'), blank('name', 'Full name'), blank('attachment', 'Transcript', 'file'), blank('email', 'Email'), blank('privacy', 'I accept the Terms and Privacy Policy', 'checkbox')];
  const planner = extensionPlanner({}, { full_name: 'Example Candidate', email: 'candidate@example.test', preferences: { auto_consent: true } }, {}, async () => JSON.stringify(questionPlan));
  for (const ref of ['name', 'email', 'privacy']) {
    const result = await planner(orderedBody(elements));
    assert.equal(result.actions[0].ref, ref);
    assert.ok(result.actions[0].observation_id);
    const el = elements.find((e) => e.ref === ref);
    if (ref === 'privacy') el.checked = true; else el.value = result.actions[0].text;
  }
  const asked = await planner(orderedBody(elements));
  assert.equal(asked.question.ref, 'unknown');
});

test('unsupported upload between known fields waits until all known answers, then hands off across ref changes', async () => {
  let context;
  const elements = [blank('name', 'Full name'), blank('file', 'Transcript', 'file', { identity: 'transcript' }), blank('email', 'Email')];
  const planner = extensionPlanner({}, { full_name: 'Example', email: 'example@example.test' }, {}, async (_c, messages) => { context = JSON.parse(messages[1].content); return JSON.stringify(ready); });
  for (const ref of ['name', 'email']) {
    const result = await planner(orderedBody(elements)); assert.equal(result.actions[0].ref, ref);
    elements.find((e) => e.ref === ref).value = result.actions[0].text;
  }
  const handoff = await planner(orderedBody(elements));
  assert.equal(handoff.question.kind, 'click'); assert.equal(handoff.question.ref, 'file'); assert.deepEqual(handoff.actions, []);
  assert.equal(Object.values(context.deferred_manual_uploads)[0], 'Transcript');
  elements[1].ref = 'new-file';
  assert.equal((await planner(orderedBody(elements, { resumed: true }))).question.ref, 'new-file');
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

test('known answers honor inspect, corrections, user edits, review flags and failed receipts', async () => {
  const planner = extensionPlanner({}, { full_name: 'Profile Name', experience: [{ company: 'Old employer', is_current: false }] }, {}, async () => JSON.stringify({ status: 'ask_user', message: 'Inspect', question: { kind: 'click', text: 'Continue' } }));
  const elements = [blank('name', 'Full name'), blank('company', 'Current company'), blank('email', 'Email', 'textbox', { user_edited: true })];
  assert.deepEqual((await planner(orderedBody(elements, { inspect_only: true, user_message: 'Inspect' }))).actions, []);
  const write = await planner(orderedBody(elements, { resumed: true })); assert.equal(write.actions[0].ref, 'name');
  const failed = await planner(orderedBody(elements, { results: [{ command_id: write.actions[0].command_id, ok: false }] }));
  assert.deepEqual(failed.filled, []); assert.deepEqual(failed.actions, []);
});

test('banner handling precedes deterministic fields, modal questions cannot jump over known fields', async () => {
  const elements = [blank('name', 'Full name'), { ref: 'reject', role: 'button', name: 'Reject all cookies' }];
  const planner = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify({ status: 'continue', message: 'Decline', action: { type: 'click', ref: 'reject' } }));
  assert.equal((await planner(orderedBody(elements))).actions[0].type, 'click');
  const modal = extensionPlanner({}, { full_name: 'Example' }, {}, async () => JSON.stringify(questionPlan));
  const input = orderedBody([blank('name', 'Full name'), blank('later', 'Unknown')]); input.observation.dialog = 'Application';
  assert.equal((await modal(input)).actions[0].ref, 'name');
});

test('manual upload recovery does not relax wrong-role and stale-ref guards', async () => {
  const elements = [blank('file', 'Transcript', 'file'), blank('text', 'Attachment description')];
  for (const ref of ['text', 'stale']) {
    const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Upload', action: { type: 'upload', ref } }));
    await assert.rejects(planner(orderedBody(elements)), /profile résumé|no longer on the page/);
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

test('a click on an unrelated button is still refused', async () => {
  const combo = { ref: 'loc', role: 'combobox', name: 'Location', required: true, value: 'Tiruchirappalli', popup: true };
  const other = { ref: 'x', role: 'button', name: 'Something else' };
  const planner = extensionPlanner({}, {}, {}, async () => JSON.stringify({ status: 'continue', message: 'Go', action: { type: 'click', ref: 'x' } }));
  const b = body();
  b.observation.elements = [combo, other];
  await assert.rejects(planner(b), /direct approval/);
});
