import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionPlanner } from '../src/extension-agent.js';
import { TOOL_CATALOG, clickAtRef, toolCallsToPlan } from '../src/agent/tools.js';

const blank = (ref, name, role = 'textbox', extra = {}) => ({ ref, name, role, value: '', required: true, ...extra });
const SHOT = '/9j/4AAQSkZJRgABAQ==';
const page = (elements, extra = {}, observation = {}) => ({
  observation: { observation_id: 'obs', document_id: 'doc', url: 'https://jobs.example/apply', elements, errors: [], coverage: [], more_below: false, text: 'Apply to Acme', screenshot: SHOT, viewport_width: 1000, viewport_height: 800, screenshot_scale: 1, ...observation },
  results: [],
  ...extra,
});
const json = (actions, extra = {}) => JSON.stringify({ status: 'continue', message: 'Working', actions, ...extra });
const native = (...calls) => ({ text: '', tool_calls: calls.map(([name, args]) => ({ name, arguments: args })) });
/** A agent planner whose model answers from `replies` in turn; `calls` collects every request (prompt, options). */
const tool = (replies, options = {}, profile = {}) => {
  const calls = [];
  let turn = 0;
  const planner = extensionPlanner({}, profile, {}, async (_config, messages, _max, look) => {
    calls.push({ prompt: JSON.parse(messages[1].content), system: messages[0].content, look });
    return replies[Math.min(turn++, replies.length - 1)];
  }, undefined, undefined, undefined, options);
  return { planner, calls };
};
const three = [blank('a', 'Alpha'), blank('b', 'Beta'), blank('c', 'Gamma')];

test('agent: native tool calls become vetted actions and the request carries the catalog and the screenshot', async () => {
  const { planner, calls } = tool([native(['type_text', { ref: 'a', text: 'One' }], ['type_text', { ref: 'b', text: 'Two' }])]);
  const result = await planner(page(three));
  assert.deepEqual(result.actions.map((a) => [a.type, a.ref, a.text]), [['type', 'a', 'One'], ['type', 'b', 'Two']]);
  assert.equal(calls[0].look.native_tools, true);
  assert.equal(calls[0].look.tools.length, TOOL_CATALOG.length);
  assert.deepEqual(calls[0].look.images, [SHOT]);
  assert.match(calls[0].system, /tool_results/);
});

test('agent: the screenshot never goes into the prompt text, and the loop is asked for one each step', async () => {
  const { planner, calls } = tool([native(['type_text', { ref: 'a', text: 'One' }])]);
  const result = await planner(page(three));
  assert.equal(JSON.stringify(calls[0].prompt).includes(SHOT), false);
  assert.equal(calls[0].prompt.screenshot, 'attached');
  assert.equal(result.want_screenshot, true);
  assert.equal(result.annotate_screenshot, true);
});

test('agent: vision off sends no image and asks for none', async () => {
  const { planner, calls } = tool([native(['type_text', { ref: 'a', text: 'One' }])], { vision: false });
  const result = await planner(page(three));
  assert.deepEqual(calls[0].look.images, []);
  assert.equal(result.want_screenshot, undefined);
});

test('agent: only values changed since the last look, so no new image is sent', async () => {
  const { planner, calls } = tool([native(['type_text', { ref: 'a', text: 'One' }]), native(['type_text', { ref: 'b', text: 'Two' }])]);
  const first = await planner(page(three));
  const filled = three.map((el) => (el.ref === 'a' ? { ...el, value: 'One' } : el));
  await planner(page(filled, { results: [{ index: 0, ok: true, command_id: first.actions[0].command_id, result: { verified: true } }] }));
  assert.equal(calls[0].look.images.length, 1);
  assert.equal(calls[1].look.images.length, 0);
  assert.match(calls[1].prompt.screenshot, /unchanged/);
});

test('agent: a changed layout sends a fresh image after writes', async () => {
  const { planner, calls } = tool([native(['type_text', { ref: 'a', text: 'One' }]), native(['type_text', { ref: 'b', text: 'Two' }])]);
  const first = await planner(page(three));
  const grown = [...three, blank('d', 'Delta')];
  await planner(page(grown, { results: [{ index: 0, ok: true, command_id: first.actions[0].command_id }] }));
  assert.equal(calls[1].look.images.length, 1);
});

test('agent: a provider that cannot call tools is asked in plain JSON from then on', async () => {
  const { planner, calls } = tool([{ text: json([{ type: 'type', ref: 'a', text: 'One' }]), tool_calls: [], tool_calls_unsupported: true }, json([{ type: 'type', ref: 'b', text: 'Two' }])]);
  const first = await planner(page(three));
  assert.deepEqual(first.actions.map((a) => a.ref), ['a']);
  await planner(page(three));
  assert.equal(calls[1].look.native_tools, false);
  assert.deepEqual(calls[1].look.tools, []);
});

test('agent: a model without native tools may answer with the JSON shape', async () => {
  const { planner } = tool([json([{ type: 'type', ref: 'a', text: 'One' }])]);
  const result = await planner(page(three));
  assert.deepEqual(result.actions.map((a) => a.ref), ['a']);
});

test('agent: find is answered inside the same step with the matching elements, and changes nothing', async () => {
  const elements = [blank('a', 'Country'), blank('b', 'Phone number'), blank('c', 'Notes')];
  const { planner, calls } = tool([native(['find', { query: 'phone' }]), native(['type_text', { ref: 'b', text: '555' }])]);
  const result = await planner(page(elements));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].prompt.tool_results.map((r) => [r.tool, r.query, r.elements.map((e) => e.ref)]), [['find', 'phone', ['b']]]);
  assert.deepEqual(result.actions.map((a) => [a.type, a.ref]), [['type', 'b']]);
});

test('agent: get_page_text returns the whole page text, while the prompt only carries the start of it', async () => {
  const long = 'x'.repeat(5000) + ' END';
  const { planner, calls } = tool([native(['get_page_text', {}]), native(['type_text', { ref: 'a', text: 'One' }])]);
  await planner(page(three, {}, { text: long }));
  assert.ok(calls[0].prompt.observation.text.length <= 2500);
  assert.match(calls[1].prompt.tool_results[0].text, /END$/);
});

test('agent: read_console and read_network return what the driver logged, and nothing is sent otherwise', async () => {
  const diagnostics = { console: [{ level: 'error', text: 'Phone is invalid' }], network: [{ status: 422, method: 'POST', url: 'https://jobs.example/api/apply' }] };
  const { planner, calls } = tool([native(['read_console', {}]), native(['read_network', {}]), native(['type_text', { ref: 'a', text: 'One' }])]);
  await planner(page(three, {}, { diagnostics }));
  assert.equal(calls[0].prompt.observation.diagnostics, undefined);
  assert.deepEqual(calls[2].prompt.tool_results.map((r) => r.tool), ['read_console', 'read_network']);
  assert.equal(calls[2].prompt.tool_results[0].entries[0].text, 'Phone is invalid');
  assert.equal(calls[2].prompt.tool_results[1].entries[0].status, 422);
});

test('agent: too many looks in one step end in a question instead of a loop', async () => {
  const { planner, calls } = tool([native(['find', { query: 'x' }])]);
  const result = await planner(page(three));
  assert.equal(calls.length, 5); // the first ask and four looks
  assert.equal(result.status, 'ask_user');
});

test('agent: click_at on a control becomes a click on its ref, and an ambiguous point is refused', async () => {
  const next = { ref: 'next', role: 'button', name: 'Next', bounds: [100, 100, 80, 30] };
  const elements = [blank('a', 'Alpha'), next, { ref: 'over', role: 'button', name: 'Continue', bounds: [110, 105, 30, 10] }];
  const { planner, calls } = tool([native(['click_at', { x: 190, y: 400 }]), native(['click_at', { x: 115, y: 110 }]), native(['click_at', { x: 170, y: 115 }])]);
  const first = await planner(page(elements)); // lands on nothing
  assert.deepEqual(first.actions, []);
  const second = await planner(page(elements)); // two controls overlap here
  assert.deepEqual(second.actions, []);
  const third = await planner(page(elements));
  assert.match(calls[2].prompt.rejected_last_turn.at(-1).reason, /one observed control/);
  assert.deepEqual(third.actions.map((a) => [a.type, a.ref]), [['click', 'next']]);
});

test('agent: a screenshot point on a final submit button is still refused', async () => {
  const submit = { ref: 'sub', role: 'button', name: 'Submit application', submit_like: true, bounds: [10, 10, 100, 30] };
  const { planner, calls } = tool([native(['click_at', { x: 50, y: 20 }]), native(['type_text', { ref: 'a', text: 'One' }])]);
  const first = await planner(page([blank('a', 'Alpha'), submit, blank('b', 'Beta'), blank('c', 'Gamma')]));
  assert.deepEqual(first.actions, []);
  await planner(page([blank('a', 'Alpha'), submit, blank('b', 'Beta'), blank('c', 'Gamma')]));
  assert.match(calls[1].prompt.rejected_last_turn[0].reason, /direct approval/);
});

test('agent: drag and wait_for reach the executor with their arguments; a drag onto a submit control does not', async () => {
  const elements = [{ ref: 's1', role: 'slider', name: 'Priority' }, { ref: 's2', role: 'slider', name: 'Target' }, { ref: 'sub', role: 'button', name: 'Submit application', submit_like: true }];
  const { planner, calls } = tool([native(['drag', { ref: 's1', to_ref: 's2' }]), native(['wait_for', { text: 'Uploaded', ms: 3000 }]), native(['drag', { ref: 's1', to_ref: 'sub' }])]);
  const drag = await planner(page(elements));
  assert.deepEqual([drag.actions[0].type, drag.actions[0].ref, drag.actions[0].to_ref], ['drag', 's1', 's2']);
  const waited = await planner(page(elements));
  assert.deepEqual([waited.actions[0].type, waited.actions[0].text, waited.actions[0].ms], ['wait_for', 'Uploaded', 3000]);
  const refused = await planner(page(elements));
  assert.deepEqual(refused.actions, []);
  assert.ok(calls.length >= 3);
});

test('agent: the transcript carries what each action did, and is bounded', async () => {
  const replies = Array.from({ length: 20 }, (_, i) => native(['type_text', { ref: 'a', text: `v${i}` }]));
  const { planner, calls } = tool(replies);
  let previous = null;
  for (let i = 0; i < 20; i += 1) {
    const results = previous ? [{ index: 0, ok: true, command_id: previous.actions[0].command_id, result: { verified: true, value_after: `v${i - 1}` } }] : [];
    previous = await planner(page(three, { results }));
  }
  const last = calls.at(-1).prompt.transcript;
  assert.ok(last.length <= 14);
  assert.match(last.at(-1), /type a "v18" → ok \(verified\), now "v18"/);
  assert.equal(calls[0].prompt.transcript.length, 0);
});

test('agent: consent and legal facts still need the profile or the user, whatever the tool', async () => {
  const consent = { ref: 'c', role: 'checkbox', name: 'I certify that everything above is true', required: true };
  const { planner, calls } = tool([native(['check', { ref: 'c', checked: true }]), native(['type_text', { ref: 'a', text: 'One' }])]);
  const first = await planner(page([blank('a', 'Alpha'), consent, blank('b', 'Beta'), blank('d', 'Delta')]));
  assert.deepEqual(first.actions, []);
  await planner(page([blank('a', 'Alpha'), consent, blank('b', 'Beta'), blank('d', 'Delta')]));
  assert.match(calls[1].prompt.rejected_last_turn[0].reason, /direct approval/);
});

test('agent: ask_user and done end the step as a question or a hand-over, never a submit', async () => {
  const { planner } = tool([native(['ask_user', { question: 'What is your notice period?', ref: 'a' }]), native(['done', { summary: 'All set' }])]);
  const asked = await planner(page([blank('a', 'Notice period')]));
  assert.equal(asked.status, 'ask_user');
  assert.equal(asked.question.ref, 'a');
  assert.equal(asked.question.optional, false);
});

test('tools.js: fill_form expands by control kind, unknown tools are dropped, a point scales with the screenshot', () => {
  const plan = toolCallsToPlan([
    { name: 'fill_form', arguments: { fields: [{ ref: 'a', text: 'Ada' }, { ref: 'c', text: 'India' }, { ref: 'k', checked: true }] } },
    { name: 'run_js', arguments: { code: 'alert(1)' } },
  ], '', [{ ref: 'c', role: 'select' }]);
  assert.deepEqual(plan.actions.map((a) => [a.type, a.ref]), [['type', 'a'], ['select', 'c'], ['check', 'k']]);
  assert.equal(toolCallsToPlan([{ name: 'run_js', arguments: {} }], '', []), null);
  assert.equal(TOOL_CATALOG.some((t) => /js|eval|submit/i.test(t.name)), false);
  const obs = { screenshot_scale: 0.5, viewport_width: 1000, viewport_height: 800, elements: [{ ref: 'z', bounds: [200, 200, 100, 40] }] };
  assert.equal(clickAtRef(125, 105, obs), 'z'); // image pixels / 0.5 = css pixels
  assert.throws(() => clickAtRef(5000, 5, obs), /outside/);
});
