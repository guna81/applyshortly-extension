import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpoint, complete, completeTools, providerSupport, canDraft, customAssist } from '../src/shared/custom-ai.js';

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

test('panel chat receives identity, preferences and saved answers even with long work history', async () => {
  const profile = { full_name: 'Candidate', email: 'candidate@example.test', gender: 'Male', date_of_birth: '2000-01-01', experience: [{ highlights: ['x'.repeat(7000)] }], preferences: { time_zone_regions: ['US', 'Europe'] }, answers: [{ question_pattern: 'Start date', answer: 'Immediately' }], resume_url: '/private/resume' };
  await customAssist({}, { fields: [{ key: 'name', label: 'Name', kind: 'text' }] }, profile, async (_config, messages) => {
    const candidate = JSON.parse(JSON.parse(messages[1].content).candidate);
    assert.equal(candidate.full_name, profile.full_name);
    assert.equal(candidate.email, profile.email);
    assert.deepEqual(candidate.preferences.time_zone_regions, ['US', 'Europe']);
    assert.deepEqual(candidate.answers, profile.answers);
    assert.equal(candidate.has_resume_file, true);
    assert.equal(candidate.resume_url, undefined);
    return JSON.stringify({ reply: 'Known', updates: [], done: true, asking: '', choices: [] });
  });
});

test('Gemini uses its compatible endpoint and Anthropic uses a native Messages adapter', async () => {
  const { PROVIDER_PRESETS } = await import('../src/shared/custom-ai.js');
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, json: async () => url.endsWith('/messages') ? { content: [{ type: 'text', text: '{"status":"continue"}' }] } : { choices: [{ message: { content: '{"status":"continue"}' } }] } };
    };
    const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Page snapshot' }];
    for (const provider of ['gemini', 'anthropic']) {
      assert.equal(await complete({ ...PROVIDER_PRESETS[provider], apiKey: 'fixture-secret' }, messages), '{"status":"continue"}');
    }
    assert.equal(calls[0].url, PROVIDER_PRESETS.gemini.baseUrl + '/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-secret');
    assert.equal(calls[1].url, PROVIDER_PRESETS.anthropic.baseUrl + '/messages');
    assert.equal(calls[1].init.headers['x-api-key'], 'fixture-secret');
    assert.equal(calls[1].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(calls[1].body.system, 'Rules');
    assert.deepEqual(calls[1].body.messages, messages.slice(1));
    assert.equal(calls[1].init.credentials, 'omit');
    assert.equal(calls[1].init.redirect, 'error');
  } finally { globalThis.fetch = original; }
});

const TOOLS = [{ name: 'find', description: 'Find', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const withFetch = async (replies, run) => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return replies[Math.min(calls.length - 1, replies.length - 1)]; };
    return await run(calls);
  } finally { globalThis.fetch = original; }
};
const ok = (data) => ({ ok: true, status: 200, json: async () => data });

test('tool calls and a screenshot go to an OpenAI-compatible provider in its own shape', async () => {
  const reply = ok({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'find', arguments: '{"query":"phone"}' } }] } }] });
  await withFetch([reply], async (calls) => {
    const result = await completeTools({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' }, [{ role: 'system', content: 's' }, { role: 'user', content: 'page' }], 800, { images: ['AAAA'], tools: TOOLS });
    assert.deepEqual(result.tool_calls, [{ name: 'find', arguments: { query: 'phone' } }]);
    assert.equal(result.tool_calls_unsupported, false);
    const body = calls[0].body;
    assert.equal(body.tools[0].function.name, 'find');
    assert.deepEqual(body.messages[1].content[0], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    assert.deepEqual(body.messages[1].content[1], { type: 'text', text: 'page' });
  });
});

test('tool calls and a screenshot go to Anthropic as tool_use and image blocks', async () => {
  const reply = ok({ content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'find', input: { query: 'phone' } }] });
  await withFetch([reply], async (calls) => {
    const result = await completeTools({ baseUrl: 'https://api.anthropic.com/v1', model: 'm', apiKey: 'k' }, [{ role: 'system', content: 's' }, { role: 'user', content: 'page' }], 800, { images: ['AAAA'], tools: TOOLS });
    assert.deepEqual(result.tool_calls, [{ name: 'find', arguments: { query: 'phone' } }]);
    assert.equal(result.text, 'Looking');
    const body = calls[0].body;
    assert.equal(body.system, 's');
    assert.equal(body.tools[0].input_schema.required[0], 'query');
    assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
  });
});

test('a provider that rejects tools or images (400) is asked again without them, and the result says so', async () => {
  await withFetch([{ ok: false, status: 400 }, ok({ choices: [{ message: { content: '{"status":"ask_user"}' } }] })], async (calls) => {
    const result = await completeTools({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' }, [{ role: 'user', content: 'page' }], 800, { images: ['AAAA'], tools: TOOLS });
    assert.equal(result.tool_calls_unsupported, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.tools, undefined);
    assert.equal(Array.isArray(calls[1].body.messages[0].content), true); // the image stays: only tools were dropped
  });
});

test('an unknown local endpoint gets no images or tools unless the provider settings allow them', async () => {
  assert.deepEqual(providerSupport({ baseUrl: 'http://localhost:11434/v1' }), { vision: false, tools: false });
  assert.deepEqual(providerSupport({ baseUrl: 'http://localhost:11434/v1', supportsVision: true, supportsTools: true }), { vision: true, tools: true });
  assert.deepEqual(providerSupport({ baseUrl: 'https://api.openai.com/v1', supportsVision: false }), { vision: false, tools: true });
  await withFetch([ok({ choices: [{ message: { content: 'plain' } }] })], async (calls) => {
    const result = await completeTools({ baseUrl: 'http://localhost:11434/v1', model: 'm', apiKey: '' }, [{ role: 'user', content: 'page' }], 800, { images: ['AAAA'], tools: TOOLS });
    assert.equal(calls[0].body.tools, undefined);
    assert.equal(typeof calls[0].body.messages[0].content, 'string');
    assert.equal(result.tool_calls_unsupported, true);
  });
});

test('a provider failure carries its status so the agent can pause instead of failing', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(complete({ baseUrl: 'http://localhost/v1', model: 'x', apiKey: 'k' }, []), (error) => error.status === 401);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(complete({ baseUrl: 'http://localhost/v1', model: 'x', apiKey: 'k' }, []), (error) => error.status === 408);
  } finally { globalThis.fetch = original; }
});
