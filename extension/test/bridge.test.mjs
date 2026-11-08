import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JobHuntBridge, autoApplyCodeFromUrl, autofillIdFromUrl, errorMessage } from '../src/bridge.js';

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
