import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionPlanner } from '../src/extension-agent.js';

const blank = (ref, name, role = 'textbox', extra = {}) => ({ ref, name, role, value: '', required: true, ...extra });
const page = (elements, extra = {}) => ({
  observation: { observation_id: 'obs', document_id: 'doc', url: 'https://jobs.example/apply', elements, errors: [], coverage: [], more_below: false },
  results: [],
  ...extra,
});
const write = (ref, text) => ({ type: 'type', ref, text });
const reply = (actions, extra = {}) => JSON.stringify({ status: 'continue', message: 'Filling', actions, ...extra });
/** A planner whose model answers from `replies` in turn; `prompts` collects what it was sent. */
const led = (replies, profile = {}, job = {}, prompts = []) => {
  let turn = 0;
  const planner = extensionPlanner({}, profile, job, async (_config, messages) => {
    prompts.push(JSON.parse(messages[1].content));
    return replies[Math.min(turn++, replies.length - 1)];
  });
  return { planner, prompts };
};

test('agent: one reply fills several fields in order, each action named for its field', async () => {
  const { planner } = led([reply([write('a', 'One'), write('b', 'Two'), write('c', 'Three')])]);
  const result = await planner(page([blank('a', 'Alpha'), blank('b', 'Beta'), blank('c', 'Gamma')]));
  assert.equal(result.status, 'continue');
  assert.deepEqual(result.actions.map((a) => [a.ref, a.text]), [['a', 'One'], ['b', 'Two'], ['c', 'Three']]);
  assert.deepEqual(result.actions.map((a) => a.label), ['Filled Alpha', 'Filled Beta', 'Filled Gamma']);
  assert.equal(new Set(result.actions.map((a) => a.command_id)).size, 3);
  assert.ok(result.actions.every((a) => a.observation_id === 'obs'));
});

test('agent: a batch is capped at eight actions', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `f${i}`);
  const { planner } = led([reply(names.map((n) => write(n, 'x')))]);
  const result = await planner(page(names.map((n) => blank(n, `Field ${n}`))));
  assert.equal(result.actions.length, 8);
});

test('agent: a batch ends at the first click, because the page may change after it', async () => {
  const elements = [blank('a', 'Alpha'), blank('b', 'Beta'), blank('c', 'Gamma'), { ref: 'next', role: 'button', name: 'Next' }];
  const { planner } = led([reply([write('a', 'One'), { type: 'click', ref: 'next' }, write('b', 'Two')])]);
  const result = await planner(page(elements));
  assert.deepEqual(result.actions.map((a) => a.type), ['type', 'click']);
});

test('agent: a submit click inside a batch is refused and the model is told why', async () => {
  const elements = [blank('a', 'Alpha'), blank('b', 'Beta'), blank('c', 'Gamma'), { ref: 'sub', role: 'button', name: 'Submit application', submit_like: true }];
  const { planner, prompts } = led([reply([write('a', 'One'), { type: 'click', ref: 'sub' }]), reply([write('b', 'Two')])]);
  const first = await planner(page(elements));
  assert.deepEqual(first.actions.map((a) => a.ref), ['a']);
  await planner(page(elements));
  assert.equal(prompts[1].rejected_last_turn.length, 1);
  assert.match(prompts[1].rejected_last_turn[0].reason, /direct approval/);
});

test('agent: a refused first action sends the model back to plan again instead of ending the run', async () => {
  const elements = [blank('a', 'Alpha'), { ref: 'news', role: 'checkbox', name: 'Newsletter', required: false }, blank('b', 'Beta'), blank('c', 'Gamma')];
  const { planner, prompts } = led([reply([write('news', 'sure')]), reply([write('a', 'One')])]);
  const first = await planner(page(elements));
  assert.equal(first.status, 'continue');
  assert.deepEqual(first.actions, []);
  const second = await planner(page(elements));
  assert.match(prompts[1].rejected_last_turn[0].reason, /not a text field/);
  assert.deepEqual(second.actions.map((a) => a.ref), ['a']);
});

test('agent: repeated refusals hand the field to the user instead of looping or ending the run', async () => {
  const elements = [{ ref: 'news', role: 'checkbox', name: 'Newsletter', required: false }];
  const { planner } = led([reply([write('news', 'sure')])]);
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await planner(page(elements))).actions, []);
  const fourth = await planner(page(elements));
  assert.equal(fourth.status, 'ask_user');
  assert.equal(fourth.question.ref, 'news');
  assert.match(fourth.question.text, /Newsletter/);
  assert.deepEqual(fourth.actions, []);
});

test('agent: repeated refusals with nothing left to ask still stop the run', async () => {
  const elements = [{ ref: 'news', role: 'checkbox', name: 'Newsletter', required: false, disabled: true }];
  const { planner } = led([reply([write('news', 'sure')])]);
  for (let i = 0; i < 3; i += 1) assert.deepEqual((await planner(page(elements))).actions, []);
  await assert.rejects(planner(page(elements)), /./);
});

test("agent: the model's own plan is used, and the profile's answers are only suggestions", async () => {
  const profile = { full_name: 'Example Candidate' };
  const { planner, prompts } = led([reply([write('name', 'Model value')])], profile);
  const result = await planner(page([blank('name', 'Full name')]));
  assert.equal(result.actions[0].text, 'Model value');
  assert.deepEqual(prompts[0].suggested_actions.map((s) => [s.ref, s.text]), [['name', 'Example Candidate']]);
});

test('agent: an optional field the profile cannot answer is put to the user, who may skip it', async () => {
  const elements = [{ ref: 'name', role: 'textbox', name: 'Full name', required: true, value: 'Candidate' }, blank('opt', 'Portfolio', 'textbox', { required: false })];
  const ready = JSON.stringify({ status: 'ready_for_review', message: 'Done' });
  const { planner } = led([ready]);
  const result = await planner(page(elements));
  assert.equal(result.status, 'ask_user');
  assert.match(result.question.text, /Portfolio/);
  assert.equal(result.question.optional, true);
  // Skipping it ends the question: the review follows and the field is not asked about again.
  const skipped = await planner(page(elements, { skip_question: true }));
  assert.equal(skipped.actions[0].type, 'review');
});

test('agent: an optional field the profile can answer is filled without asking', async () => {
  const elements = [blank('opt', 'Portfolio', 'textbox', { required: false })];
  const result = await led([reply([write('opt', 'https://portfolio.example')])]).planner(page(elements));
  assert.equal(result.question, null);
  assert.deepEqual(result.actions.map((a) => [a.ref, a.text]), [['opt', 'https://portfolio.example']]);
});

test('agent: the prompt tells the model to ask about an optional field it cannot answer', async () => {
  const { planner } = led([reply([write('a', 'One')])]);
  let system = '';
  const prompted = extensionPlanner({}, {}, {}, async (_config, messages) => { system = messages[0].content; return reply([write('a', 'One')]); });
  await prompted(page([blank('a', 'Alpha')]));
  assert.match(system, /optional/i);
  assert.match(system, /ask the user/i);
  assert.doesNotMatch(system, /leave an optional field empty/i);
  void planner;
});

test('agent: a legal or criminal-record answer needs the profile or the user, never the model alone', async () => {
  for (const name of ['Do you now or will you in the future require visa sponsorship?', 'Have you ever been convicted of a crime?']) {
    const result = await led([reply([write('legal', 'No')])]).planner(page([blank('legal', name)]));
    assert.equal(result.status, 'ask_user', name);
    assert.deepEqual(result.actions, [], name);
  }
});

test('agent: questions already asked are listed for the model so it does not repeat them', async () => {
  const ask = JSON.stringify({ status: 'ask_user', message: 'Need a fact', question: { kind: 'question', ref: 'proj', text: 'What is your favourite project?' } });
  const { planner, prompts } = led([ask, reply([write('proj', 'Alpha')])]);
  const elements = [blank('proj', 'Favourite project')];
  assert.equal((await planner(page(elements))).status, 'ask_user');
  await planner(page(elements, { user_reply: 'Alpha' }));
  assert.deepEqual(prompts[1].asked_questions, ['What is your favourite project?']);
});

test('agent: every verified write in a batch is recorded as filled', async () => {
  const { planner } = led([reply([write('a', 'One'), write('b', 'Two')]), JSON.stringify({ status: 'ask_user', message: 'Next', question: { kind: 'click', text: 'Continue?' } })]);
  const elements = [blank('a', 'Alpha'), blank('b', 'Beta')];
  const first = await planner(page(elements));
  const done = [blank('a', 'Alpha', 'textbox', { value: 'One' }), blank('b', 'Beta', 'textbox', { value: 'Two' })];
  const second = await planner(page(done, { results: first.actions.map((a, index) => ({ index, ok: true, command_id: a.command_id, result: { verified: true } })) }));
  assert.equal(second.filled.length, 2);
});

test('agent: a reply with no usable action falls back to asking for a required field', async () => {
  const { planner } = led([reply([])]);
  const result = await planner(page([blank('a', 'Alpha'), blank('opt', 'Portfolio', 'textbox', { required: false })]));
  assert.equal(result.status, 'ask_user');
  assert.match(result.question.text, /Alpha/);
});

test('agent: with no required field left, the fallback asks about an optional one', async () => {
  const { planner } = led([reply([])]);
  const result = await planner(page([blank('opt', 'Portfolio', 'textbox', { required: false })]));
  assert.equal(result.status, 'ask_user');
  assert.equal(result.question.optional, true);
});

test('agent: the prompt allows batches and asks for a source on every write', async () => {
  const { planner } = led([reply([write('a', 'One')])]);
  let system = '';
  const probe = extensionPlanner({}, {}, {}, async (_c, messages) => { system = messages[0].content; return reply([write('a', 'One')]); });
  await probe(page([blank('a', 'Alpha')]));
  await planner(page([blank('a', 'Alpha')]));
  assert.match(system, /up to 8 actions/);
  assert.match(system, /"actions":\[/);
  assert.match(system, /"source"/);
  assert.doesNotMatch(system, /at most one action/);
});
