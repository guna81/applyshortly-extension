import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpoint, complete, canDraft, customAssist } from '../src/custom-ai.js';

test('validates provider endpoint and keeps its path', () => {
  assert.equal(endpoint('http://127.0.0.1:8765/v1/'), 'http://127.0.0.1:8765/v1');
  assert.equal(endpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  for (const value of ['http://example.com/v1', 'http://user:pass@localhost/v1', 'https://example.com/v1?key=secret', 'https://example.com/#playground']) assert.throws(() => endpoint(value));
});

test('sends a compatible request without exposing errors or following redirects', async () => {
  const original = globalThis.fetch;
  let call;
  try {
    globalThis.fetch = async (url, init) => { call = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: '  Draft answer  ' } }] }) }; };
    assert.equal(await complete({ baseUrl: 'http://localhost:8765/v1', model: 'agy/example', apiKey: 'secret' }, [{ role: 'user', content: 'hello' }]), 'Draft answer');
    assert.equal(call.url, 'http://localhost:8765/v1/chat/completions');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers.Authorization, 'Bearer secret');
    assert.equal(JSON.parse(call.init.body).model, 'agy/example');
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(complete({ baseUrl: 'http://localhost/v1', model: 'x', apiKey: 'secret' }, []), /HTTP 401/);
  } finally { globalThis.fetch = original; }
});

test('sensitive questions are not drafted', () => {
  for (const question of ['Do you need visa sponsorship?', 'What is your current salary?', 'Are you a former employee?', 'What is your date of birth?']) assert.equal(canDraft(question), false);
  assert.equal(canDraft('Why are you interested in this role?'), true);
});


test('assistant validates untrusted updates and preserves form options', async () => {
  const input = { fields: [{ key: 'f1', label: 'Choice', kind: 'dropdown', options: ['Yes', 'No'] }, { key: 'f2', label: 'Unknown options', kind: 'dropdown', options: [] }, { key: 'f3', label: 'Resume', kind: 'file' }], current: {}, messages: [{ role: 'user', text: 'Choose yes' }] };
  const result = await customAssist({}, input, {}, async () => '```json\n' + JSON.stringify({ reply: 'Done', updates: [{ field: 'f1', value: 'yes' }, { field: 'f2', value: 'Anything' }, { field: 'f3', value: 'file' }, { field: 'unknown', value: 'bad' }], done: false, asking: 'f1', choices: ['invented'] }) + '\n```');
  assert.deepEqual({ ...result.updates }, { f1: 'Yes' });
  assert.deepEqual(result.choices, ['Yes', 'No']);
  assert.match(result.warnings[0], /Unknown options/);
  await assert.rejects(customAssist({}, input, {}, async () => 'not json'), /invalid assistant response/);
});
