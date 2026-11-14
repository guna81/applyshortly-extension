import { PROVIDER_PRESETS } from "../src/custom-ai.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

async function setup({ signedIn = false, billingEnabled = true, autoConnect = false, customEnabled = false } = {}) {
  const dom = new JSDOM(readFileSync(new URL('../src/options.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  const calls = [];
  let connected = signedIn;
  let storageListener;
  let ai = { mode: 'platform', provider: null, configured: [] };
  const stored = {};
  let custom = { enabled: customEnabled, baseUrl: 'http://localhost:8765/v1', model: 'fixture-model' };
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
          case 'test': data = connected ? { connected, configured: true, connectionType: 'automatic', name: 'Fixture', email: 'fixture@example.com', plan: 'pro', credits: 42, billingEnabled, ai } : { configured: false }; break;
          case 'browserSignIn': connected = autoConnect || message.interactive; data = { state: connected ? 'connected' : 'signin_required' }; break;
          case 'saveCustomAI': custom = { enabled: true, baseUrl: message.baseUrl, model: message.model }; data = true; break;
          case 'selectAI': ai = { ...ai, mode: message.mode, provider: message.provider ?? null }; data = ai; break;
          case 'customAISettings': data = custom; break;
          case 'disableCustomAI': custom = { ...custom, enabled: false }; data = true; break;
          case 'deleteAIProvider': ai.configured = []; data = ai; break;
          case 'disconnect': connected = false; data = true; break;
          default: data = true;
        }
        return { ok: true, data };
      },
    },
    commands: { getAll: async () => [] },
    storage: { session: { get: async () => ({}) }, local: { set: async (values) => Object.assign(stored, values) }, onChanged: { addListener: (fn) => { storageListener = fn; } } },
  };
  window.PROVIDER_PRESETS = PROVIDER_PRESETS;
  window.chrome.permissions = { request: async () => true };
  window.eval(readFileSync(new URL('../src/options.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''));
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
  await flush();
  return { window, document: window.document, calls, stored, flush, setConnected: (value) => { connected = value; }, storageChanged: (changes) => storageListener(changes, 'local'), close: () => window.close() };
}

test('active custom endpoint is selected until the user switches to credits', async () => {
  const h = await setup({ signedIn: true, customEnabled: true });
  try {
    const funding = h.document.querySelector('#aiFunding');
    assert.equal(funding.value, 'custom');
    assert.match(funding.selectedOptions[0].textContent, /fixture-model/);
    funding.value = 'platform';
    funding.dispatchEvent(new h.window.Event('change'));
    await h.flush();
    assert.equal(funding.value, 'platform');
    assert.ok(h.calls.some((item) => item.type === 'disableCustomAI'));
    assert.ok(h.calls.some((item) => item.type === 'selectAI' && item.mode === 'platform'));
  } finally { h.close(); }
});

test('setup hides URL configuration and silently connects an existing web session', async () => {
  const h = await setup({ autoConnect: true });
  try {
    assert.equal(h.document.querySelector('#baseUrl'), null);
    assert.equal(h.document.body.textContent.includes('Platform URL'), false);
    assert.equal(h.calls.find((item) => item.type === 'browserSignIn').interactive, false);
    assert.match(h.document.querySelector('#connTitle').textContent, /Connected/);
    assert.match(h.document.querySelector('#accountSummary').textContent, /Pro plan · 42 credits/);
    assert.equal(h.document.querySelector('#customKey').type, 'password');
    assert.equal(h.document.querySelector('#customDetails').open, false);
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

test('provider preset saves only on device with a default model and clears the key', async () => {
  const h = await setup({ signedIn: true });
  try {
    const preset = h.document.querySelector('#providerPreset');
    assert.deepEqual(Array.from(preset.options, (option) => option.value), ['openai', 'gemini', 'anthropic', 'custom']);
    preset.value = 'anthropic';
    preset.dispatchEvent(new h.window.Event('change'));
    h.document.querySelector('#customKey').value = 'fixture-personal-key';
    h.document.querySelector('#customAIForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await h.flush();
    const saved = h.calls.find((item) => item.type === 'saveCustomAI');
    assert.equal(saved.baseUrl, PROVIDER_PRESETS.anthropic.baseUrl);
    assert.equal(saved.model, PROVIDER_PRESETS.anthropic.model);
    assert.equal(h.document.querySelector('#customKey').value, '');
    assert.equal(h.calls.some((item) => item.type === 'saveAIProvider'), false);
    assert.equal(h.document.querySelector('#providerForm'), null);
    assert.equal(h.document.querySelector('#aiFunding').value, 'custom');
  } finally { h.close(); }
});

test('billing-off setup describes disabled credit charging without account controls', async () => {
  const h = await setup({ signedIn: true, billingEnabled: false });
  try {
    assert.match(h.document.querySelector('#accountSummary').textContent, /No credit charges/);
    assert.equal(h.document.querySelector('#disconnect'), null);
    assert.equal(h.document.querySelector('#retest').hidden, true);
    assert.equal(h.document.querySelector('#manual').hidden, true);
  } finally { h.close(); }
});

test('returning to the page reconnects once the website is signed in', async () => {
  const h = await setup();
  try {
    assert.match(h.document.querySelector('#connTitle').textContent, /Not connected/);
    h.setConnected(true);
    Object.defineProperty(h.document, 'visibilityState', { value: 'visible', configurable: true });
    h.document.dispatchEvent(new h.window.Event('visibilitychange'));
    await h.flush();
    assert.match(h.document.querySelector('#connTitle').textContent, /Connected/);
    assert.equal(h.document.querySelector('#signin').hidden, true);
  } finally { h.close(); }
});

test('log out revokes the connection, says what else it signs out, and offers sign-in', async () => {
  const h = await setup({ signedIn: true });
  try {
    const logout = h.document.querySelector('#logout');
    assert.equal(logout.hidden, false);
    assert.match(h.document.querySelector('#logoutHint').textContent, /signs this browser out of the ApplyShortly website/);
    logout.click();
    await h.flush();
    assert.ok(h.calls.some((item) => item.type === 'disconnect'));
    assert.equal(h.calls.filter((item) => item.type === 'browserSignIn').length, 0);
    assert.equal(logout.hidden, true);
    assert.equal(h.document.querySelector('#signin').hidden, false);
    assert.equal(h.document.querySelector('#pairingMsg').textContent, 'Logged out.');
  } finally { h.close(); }
});

test('a connection made in the background shows without reloading', async () => {
  const h = await setup();
  try {
    assert.match(h.document.querySelector('#connTitle').textContent, /Not connected/);
    h.setConnected(true);
    h.storageChanged({ token: { newValue: 'stored-elsewhere' } });
    await h.flush();
    assert.match(h.document.querySelector('#connTitle').textContent, /Connected/);
    assert.equal(h.document.querySelector('#logout').hidden, false);
  } finally { h.close(); }
});

test('extension has its own engine selector, defaulting to AI-led', async () => {
  const h = await setup();
  try {
    const select = h.document.querySelector('#extensionEngine');
    assert.equal(select.value, 'ai_led');
    select.value = 'rules_led';
    select.dispatchEvent(new h.window.Event('change'));
    await h.flush();
    assert.match(h.document.querySelector('#prefMsg').textContent, /Saved/);
    assert.equal(h.stored.extensionEngine, 'rules_led');
  } finally { h.close(); }
});
