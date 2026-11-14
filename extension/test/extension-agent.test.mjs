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
