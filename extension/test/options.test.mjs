import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

async function setup({ signedIn = false, billingEnabled = true, autoConnect = false } = {}) {
  const dom = new JSDOM(readFileSync(new URL('../src/options.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  const calls = [];
  let connected = signedIn;
  let ai = { mode: 'platform', provider: null, configured: [] };
  const { window } = dom;
  window.JobHuntPanel = { friendlyError: () => ({ title: 'Connection failed', detail: 'Retry' }) };
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.3.0' }),
      sendMessage: async (message) => {
        calls.push(message);
        let data;
        switch (message.type) {
          case 'connectionSettings': data = { configured: connected }; break;
          case 'test': data = connected ? { connected, configured: true, name: 'Fixture', email: 'fixture@example.com', plan: 'pro', credits: 42, billingEnabled, ai } : { configured: false }; break;
          case 'browserSignIn': connected = autoConnect || message.interactive; data = { state: connected ? 'connected' : 'signin_required' }; break;
          case 'saveAIProvider': ai.configured = [{ provider: message.provider, model: message.model }]; data = ai; break;
          case 'selectAI': ai = { ...ai, mode: message.mode, provider: message.provider ?? null }; data = ai; break;
          case 'deleteAIProvider': ai.configured = []; data = ai; break;
          case 'disconnect': connected = false; data = true; break;
          default: data = true;
        }
        return { ok: true, data };
      },
    },
    commands: { getAll: async () => [] },
    storage: { session: { get: async () => ({}) }, local: { set: async () => {} } },
  };
  window.eval(readFileSync(new URL('../src/options.js', import.meta.url), 'utf8'));
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
  await flush();
  return { window, document: window.document, calls, flush, close: () => window.close() };
}

test('setup hides URL configuration and silently connects an existing web session', async () => {
  const h = await setup({ autoConnect: true });
  try {
    assert.equal(h.document.querySelector('#baseUrl'), null);
    assert.equal(h.document.body.textContent.includes('Platform URL'), false);
    assert.equal(h.calls.find((item) => item.type === 'browserSignIn').interactive, false);
    assert.match(h.document.querySelector('#connTitle').textContent, /Connected/);
    assert.match(h.document.querySelector('#accountSummary').textContent, /Pro plan · 42 credits/);
    assert.equal(h.document.querySelector('#providerKey').type, 'password');
    assert.equal(h.document.querySelector('#advancedAI').open, false);
  } finally { h.close(); }
});

test('signed-out setup shows a sign-in button; it opens interactive sign-in only on click', async () => {
  const h = await setup();
  try {
    const button = h.document.querySelector('#signin');
    assert.equal(button.hidden, false);
    assert.equal(h.calls.filter((item) => item.type === 'browserSignIn').length, 1);
    button.click();
    await h.flush();
    assert.equal(h.calls.filter((item) => item.type === 'browserSignIn')[1].interactive, true);
    assert.equal(button.hidden, true);
  } finally { h.close(); }
});

test('provider dropdown saves required key and model, selects it, and clears the input', async () => {
  const h = await setup({ signedIn: true });
  try {
    assert.deepEqual(Array.from(h.document.querySelector('#provider').options, (option) => option.value), ['openai', 'anthropic', 'gemini']);
    const form = h.document.querySelector('#providerForm');
    h.document.querySelector('#provider').value = 'anthropic';
    h.document.querySelector('#providerKey').value = 'fixture-personal-key';
    form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
    assert.equal(h.calls.some((item) => item.type === 'saveAIProvider'), false);
    h.document.querySelector('#providerModel').value = 'fixture-model';
    form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find((item) => item.type === 'saveAIProvider'))), { type: 'saveAIProvider', provider: 'anthropic', apiKey: 'fixture-personal-key', model: 'fixture-model' });
    assert.equal(h.document.querySelector('#providerKey').value, '');
    assert.equal(h.document.body.textContent.includes('fixture-personal-key'), false);
    assert.equal(h.document.querySelector('#aiFunding').value, 'anthropic');
    h.document.querySelector('#savedProviders button').click();
    await h.flush();
    assert.equal(h.document.querySelector('#aiFunding').value, 'anthropic');
    assert.match(h.document.querySelector('#aiFunding').selectedOptions[0].textContent, /missing/);
  } finally { h.close(); }
});

test('self-hosted setup describes disabled credit charging and disconnect does not reconnect', async () => {
  const h = await setup({ signedIn: true, billingEnabled: false, autoConnect: true });
  try {
    assert.match(h.document.querySelector('#accountSummary').textContent, /Self-hosted — no credit charges/);
    h.document.querySelector('#disconnect').click();
    await h.flush();
    assert.equal(h.calls.some((item) => item.type === 'browserSignIn'), false);
    assert.equal(h.document.querySelector('#accountSummary').hidden, true);
    assert.equal(h.document.querySelector('#aiFunding').disabled, true);
  } finally { h.close(); }
});
