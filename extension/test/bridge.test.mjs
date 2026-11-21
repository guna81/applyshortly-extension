import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AGENT_TIMEOUT_MS, JobHuntBridge, REQUEST_TIMEOUT_MS, autoApplyCodeFromUrl, autofillIdFromUrl, errorMessage } from '../src/shared/bridge.js';

test('reads the application id and the one-time Auto apply code from the link', () => {
  const url = 'https://www.linkedin.com/jobs/view/9#jobhunt-autofill=12&jobhunt-auto=AbC_def-0123456789xyz';
  assert.equal(autofillIdFromUrl(url), 12);
  assert.equal(autoApplyCodeFromUrl(url), 'AbC_def-0123456789xyz');
  // Open & Autofill links have no code; "jobhunt-autofill" isn't one.
  assert.equal(autoApplyCodeFromUrl('https://x.test/job#jobhunt-autofill=12'), null);
  assert.equal(autoApplyCodeFromUrl('https://x.test/job#jobhunt-auto=short'), null);
  assert.equal(autoApplyCodeFromUrl('not a url'), null);
  // Only the fragment counts: a query string can be set by any page that links here.
  assert.equal(autoApplyCodeFromUrl('https://x.test/job?jobhunt-auto=AbC_def-0123456789xyz'), null);
});

test('a rejected request names the fields it rejected, never their values', () => {
  assert.equal(errorMessage({ detail: 'Plan limit reached.' }, 'Payment Required'), 'Plan limit reached.');
  assert.equal(errorMessage({}, 'Bad Gateway'), 'Bad Gateway');
  const body = { detail: [{ loc: ['body', 'observation', 'elements', 3, 'popup'], msg: 'Extra inputs are not permitted', type: 'extra_forbidden', input: 'private@example.test' }] };
  const message = errorMessage(body, 'Unprocessable Entity');
  assert.equal(message, 'Unprocessable Entity (observation.elements.3.popup: Extra inputs are not permitted)');
  assert.ok(!message.includes('private@example.test'));
  const many = { detail: Array.from({ length: 5 }, (_, i) => ({ loc: ['body', `f${i}`], msg: 'bad' })) };
  assert.match(errorMessage(many, 'Unprocessable Entity'), /f0: bad; f1: bad; f2: bad; …\)$/);
});

test('agentStep retries without runtime_version when an older platform rejects it', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) } };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ('runtime_version' in body) {
      return new Response(JSON.stringify({ detail: [{ loc: ['body', 'runtime_version'], msg: 'Extra inputs are not permitted' }] }),
        { status: 422, statusText: 'Unprocessable Entity' });
    }
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };
  try {
    const bridge = new JobHuntBridge('http://x.test', 't');
    const res = await bridge.agentStep({ observation: { url: 'https://x.test' } });
    assert.deepEqual(res, { status: 'ok' });
    assert.equal(bodies.length, 2);
    assert.equal('runtime_version' in bodies[1], false);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
});

test('a platform call that never answers fails as a transient 408 instead of hanging', async () => {
  const realFetch = globalThis.fetch;
  let signal;
  // A fetch that ignores its abort signal entirely: the timeout must still end the call.
  globalThis.fetch = (_url, init) => { signal = init.signal; return new Promise(() => {}); };
  try {
    const bridge = new JobHuntBridge('http://x.test', 't');
    await assert.rejects(
      bridge.request('/api/extension/profile', { timeout: 20 }),
      (error) => error.status === 408 && /didn't answer/.test(error.message),
    );
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('agentStep strips local observation.diagnostics before sending to the platform', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) } };
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };
  try {
    const bridge = new JobHuntBridge('http://x.test', 't');
    const obs = { url: 'https://x.test', diagnostics: { console: [{ level: 'error' }], network: [] } };
    const res = await bridge.agentStep({ observation: obs });
    assert.deepEqual(res, { status: 'ok' });
    assert.equal('diagnostics' in bodies[0].observation, false);
    assert.equal(bodies[0].observation.url, 'https://x.test');
    // Caller's original observation object is not mutated.
    assert.ok('diagnostics' in obs);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
});

test('the agent model and step calls get the longer agent timeout, others the default', async () => {
  const realFetch = globalThis.fetch;
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return realSetTimeout(fn, ms, ...rest); };
  globalThis.fetch = async () => new Response(JSON.stringify({ text: '{}' }), { status: 200 });
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) } };
  try {
    const bridge = new JobHuntBridge('http://x.test', 't');
    await bridge.agentModel({ messages: [] });
    await bridge.profile();
    assert.ok(timers.includes(AGENT_TIMEOUT_MS));
    assert.ok(timers.includes(REQUEST_TIMEOUT_MS));
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
  }
});

test('BridgeError preserves the platform error code on HTTP 402 responses', async () => {
  const realFetch = globalThis.fetch;
  try {
    const bridge = new JobHuntBridge('http://x.test', 't');
    globalThis.fetch = async () => new Response(
      JSON.stringify({ detail: 'This needs 5 credits; you have 0.', code: 'insufficient_credits', required: 5, available: 0 }),
      { status: 402, statusText: 'Payment Required' },
    );
    await assert.rejects(
      bridge.agentModel({ messages: [] }),
      (error) => error.status === 402 && error.code === 'insufficient_credits' && /5 credits/.test(error.message),
    );
    globalThis.fetch = async () => new Response(
      JSON.stringify({ detail: 'Plan limit reached.', code: 'plan_limit' }),
      { status: 402, statusText: 'Payment Required' },
    );
    await assert.rejects(
      bridge.agentModel({ messages: [] }),
      (error) => error.status === 402 && error.code === 'plan_limit',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
