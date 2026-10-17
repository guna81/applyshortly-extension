import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

function harness({ blocked = false, revoked = false, accountRevoked = false, wrongState = false, wrongCallback = false, cancelExchange = false, configStatus = 200, invalidConfig = false, configNetworkError = false, signedOut = false, packagedOrigin = "http://localhost:3000" } = {}) {
  const local = { baseUrl: 'http://localhost:3000', token: 'fixture-bearer', aiDrafts: false };
  const session = {};
  const access = [];
  const calls = [];
  let listener;
  const area = (data) => ({
    setAccessLevel: async (value) => access.push(value.accessLevel),
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in data).map((key) => [key, data[key]])),
    set: async (value) => Object.assign(data, value),
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    clear: async () => { for (const key of Object.keys(data)) delete data[key]; },
  });
  const runtime = {
    id: 'fixture-extension', getURL: (path) => `chrome-extension://fixture-extension/${path}`,
    onMessage: { addListener: (fn) => { listener = fn; } }, onInstalled: { addListener() {} }, openOptionsPage: async () => {},
  };
  class BridgeError extends Error { constructor(status, message) { super(message); this.status = status; } }
  class JobHuntBridge {
    aiSettings() { return { mode: "platform", configured: [] }; }
    selectAI(body) { calls.push({ selectedAI: body }); return { ...body, configured: [] }; }
    saveAIProvider(provider, body) { calls.push({ savedProvider: provider, body }); return { mode: "platform", configured: [{ provider, model: body.model }] }; }
    deleteAIProvider(provider) { calls.push({ deletedProvider: provider }); return { mode: "personal", provider, configured: [] }; }
    account() { if (accountRevoked) throw new BridgeError(401, 'Revoked'); return { name: 'Fixture', email: 'fixture@example.com', credits: 30, plan: "pro", billing_enabled: true, ai: { mode: 'platform' } }; }
    profile() { return { full_name: 'Fixture' }; }
    application(id) { if (blocked) throw new BridgeError(409, 'Verify the previous submission'); return { id }; }
    lookup() { if (blocked) throw new BridgeError(409, 'Verify the previous submission'); return null; }
    websiteTicket() { return { ticket: 'fixture-short-lived-ticket' }; }
    assistantChat(body) { calls.push({ chat: body }); return { reply: 'ok', choices: [], actions: [] }; }
    runAction(body) { calls.push({ action: body }); return { ok: true, message: 'Done.' }; }
    disconnect() { calls.push('revoke'); if (revoked) throw new BridgeError(401, 'Revoked'); }
  }
  const chrome = {
    storage: { local: area(local), session: area(session) }, runtime,
    identity: {
      getRedirectURL: (path) => `https://fixture-extension.chromiumapp.org/${path}`,
      launchWebAuthFlow: async ({ url, interactive }) => {
        calls.push({ loginUrl: url, interactive });
        if (signedOut && !interactive) throw new Error("Not signed in");
        const params = new URL(url).searchParams;
        const callback = wrongCallback ? 'https://evil.example/applyshortly' : params.get('redirect_uri');
        return `${callback}?${new URLSearchParams({ code: 'fixture-one-time-code', state: wrongState ? 'wrong-state' : params.get('state') })}`;
      },
    },
    tabs: { onRemoved: { addListener() {} }, create: async (value) => calls.push(value), sendMessage: async () => {}, query: async () => [] },
    commands: { onCommand: { addListener() {} } }, scripting: {},
  };
  const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8').replace(/^import .*;$/m, 'const { BridgeError, JobHuntBridge, autofillIdFromUrl } = fixtures;');
  vm.runInNewContext(source, { chrome, URL, URLSearchParams, Uint8Array, TextEncoder, btoa, crypto: webcrypto, Date, console, fixtures: { BridgeError, JobHuntBridge, autofillIdFromUrl: () => null }, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("platform.json")) return { ok: true, json: async () => ({ baseUrl: packagedOrigin }) };
    if (url.includes('/browser/config')) {
      if (configNetworkError) throw new Error('fetch failed');
      return { ok: configStatus === 200, status: configStatus, json: async () => invalidConfig ? {} : ({ enabled: true }) };
    }
    if (url.endsWith('/browser/exchange')) {
      if (cancelExchange) await new Promise((resolve) => listener({ type: 'pairingCancel' }, { id: runtime.id, url: runtime.getURL('src/options.html') }, resolve));
      return { ok: true, json: async () => ({ key: 'fixture-automatic-key' }) };
    }
    if (url.endsWith('/website-ticket')) return { ok: true, json: async () => ({ ticket: 'fixture-short-lived-ticket' }) };
    return { ok: true, json: async () => url.endsWith('/start') ? { secret: 'fixture-poll-secret', code: 'ABCDEF1234', expires_in: 600 } : { state: 'connected', key: 'fixture-new-bearer' } };
  } });
  const ui = { id: runtime.id, url: runtime.getURL('src/options.html') };
  const content = { id: runtime.id, url: 'https://example.com/apply', tab: { id: 10, url: 'https://example.com/apply' } };
  const send = (msg, sender = ui) => new Promise((resolve) => listener(msg, sender, resolve));
  return { local, session, calls, access, send, content };
}

test('credentials are restricted to trusted storage and privileged UI messages', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'disconnect' }, h.content)).ok, false);
  assert.equal(h.local.token, 'fixture-bearer');
  assert.deepEqual(h.access, ['TRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']);
  assert.equal((await h.send({ type: 'pairingStart', baseUrl: 'https://example.com' }, h.content)).ok, false);
  assert.equal((await h.send({ type: 'context', appId: 123 }, h.content)).ok, false);
  const panel = await h.send({ type: 'panelPreference', minimized: true }, h.content);
  assert.equal(panel.data, true);
  assert.equal(JSON.stringify(panel).includes('fixture-bearer'), false);
});

test('pairing never places polling secrets or credentials in URLs or UI messages', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'pairingStart', baseUrl: 'https://apply.example' })).ok, true);
  assert.match(h.calls.find((call) => call.url?.includes('extension-connect')).url, /code=ABCDEF1234/);
  const result = await h.send({ type: 'pairingPoll' });
  assert.equal(result.data.state, 'connected');
  assert.equal(h.local.token, 'fixture-new-bearer');
  assert.equal(JSON.stringify(result).includes('fixture-new-bearer'), false);
  assert.equal(h.calls.some((call) => call.url?.includes('fixture-poll-secret')), false);
  assert.equal(h.session.pairing, undefined);
});

test('unconfirmed application errors stop tracked and untracked filling', async () => {
  const h = harness({ blocked: true });
  const result = await h.send({ type: 'start', tabId: 10, url: 'https://example.com/apply', allowUntracked: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(h.session['tab:10'], undefined);
});

test('disconnect clears credentials when the server has already revoked the key', async () => {
  const h = harness({ revoked: true });
  assert.equal((await h.send({ type: 'disconnect' })).ok, true);
  assert.equal(h.local.token, undefined);
});


test('browser sign-in uses PKCE and state, stores credentials only in trusted storage', async () => {
  const h = harness();
  delete h.local.token;
  h.session['tab:10'] = { appId: 123 };
  const result = await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' });
  assert.equal(result.ok, true);
  assert.equal(result.data.state, 'connected');
  assert.equal(h.local.connectionType, 'automatic');
  assert.equal(h.local.token, 'fixture-automatic-key');
  assert.equal(h.session['tab:10'], undefined);
  const login = h.calls.find((call) => call.loginUrl);
  const exchange = JSON.parse(h.calls.find((call) => call.url?.endsWith('/browser/exchange')).init.body);
  const challenge = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.verifier))).toString('base64url');
  assert.equal(new URL(login.loginUrl).searchParams.get('challenge'), challenge);
  assert.equal(h.calls.some((call) => (call.url || call.loginUrl || '').includes(exchange.verifier)), false);
  assert.equal(JSON.stringify(result).includes('fixture-automatic-key'), false);
  assert.equal(JSON.stringify((await h.send({ type: 'connectionSettings' })).data).includes('fixture-automatic-key'), false);
});

for (const setting of ['wrongState', 'wrongCallback']) {
  test(`browser sign-in rejects ${setting} before exchanging a code`, async () => {
    const h = harness({ [setting]: true });
    delete h.local.token;
    assert.equal((await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' })).ok, false);
    assert.equal(h.local.token, undefined);
    assert.equal(h.calls.some((call) => call.url?.endsWith('/browser/exchange')), false);
  });
}

test('cancelled exchange revokes the issued credential without saving it', async () => {
  const h = harness({ cancelExchange: true });
  delete h.local.token;
  assert.equal((await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' })).ok, false);
  assert.equal(h.local.token, undefined);
  assert.ok(h.calls.includes('revoke'));
});

test('website sign-in uses a one-time ticket fragment and never exposes the bearer', async () => {
  const h = harness();
  h.local.connectionType = 'automatic';
  assert.equal((await h.send({ type: 'openWebsite', path: '/apply-queue' })).ok, true);
  const tab = h.calls.find((call) => call.url?.includes('/extension-session#'));
  assert.ok(tab);
  assert.equal(new URL(tab.url).search, '');
  assert.equal(new URLSearchParams(new URL(tab.url).hash.slice(1)).get('ticket'), 'fixture-short-lived-ticket');
  assert.equal(tab.url.includes('fixture-bearer'), false);
  assert.equal((await h.send({ type: 'openWebsite', path: '//evil.example' })).ok, false);
});

test('revoked authentication clears cached data and privileged messages reject content scripts', async () => {
  const h = harness({ accountRevoked: true });
  h.session['tab:10'] = { appId: 123 };
  for (const type of ['browserSignIn', 'openWebsite', 'connectionSettings', 'saveManualConnection']) {
    assert.equal((await h.send({ type }, h.content)).ok, false);
  }
  assert.equal((await h.send({ type: 'test' })).data.connected, false);
  assert.equal(h.local.token, undefined);
  assert.equal(h.session['tab:10'], undefined);
});

test('connecting another account requires disconnecting the current account first', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' })).ok, false);
  assert.equal((await h.send({ type: 'saveManualConnection', baseUrl: 'https://apply.example', token: 'another-key' })).ok, false);
  assert.equal(h.local.token, 'fixture-bearer');
});


test('older servers without browser configuration still support approved code pairing', async () => {
  const h = harness({ configStatus: 404 });
  delete h.local.token;
  const result = await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' });
  assert.equal(result.ok, true);
  assert.equal(result.data.state, 'legacy');
  assert.ok(h.calls.some((call) => call.url?.includes('/extension-connect?code=')));
  assert.equal(h.calls.some((call) => call.loginUrl), false);
  assert.equal(h.local.token, undefined);
});

test('server failures remain retryable and do not initiate fallback authentication', async () => {
  const h = harness({ configStatus: 503 });
  delete h.local.token;
  const result = await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
  assert.equal(h.calls.some((call) => call.url?.endsWith('/start')), false);
});

test('invalid platform responses and network failures explain how to recover', async () => {
  for (const option of ['invalidConfig', 'configNetworkError']) {
    const h = harness({ [option]: true });
    delete h.local.token;
    const result = await h.send({ type: 'browserSignIn', baseUrl: 'https://apply.example' });
    assert.equal(result.ok, false);
    assert.match(result.error, /server/i);
    assert.equal(h.calls.some((call) => call.loginUrl || call.url?.endsWith('/start')), false);
  }
});


test('silent sign-in connects without an interactive window', async () => {
  const h = harness();
  h.local.token = '';
  const result = await h.send({ type: 'browserSignIn', interactive: false });
  assert.equal(result.data.state, 'connected');
  assert.equal(h.calls.find((call) => call.loginUrl).interactive, false);
});

test('signed-out silent sign-in offers a button and interactive retry works', async () => {
  const h = harness({ signedOut: true });
  h.local.token = '';
  assert.equal((await h.send({ type: 'browserSignIn', interactive: false })).data.state, 'signin_required');
  assert.equal(h.calls.some((call) => call.url?.includes('extension-connect')), false);
  assert.equal((await h.send({ type: 'browserSignIn' })).data.state, 'connected');
});

test('silent sign-in never starts legacy pairing on older servers', async () => {
  const h = harness({ configStatus: 404 });
  h.local.token = '';
  assert.equal((await h.send({ type: 'browserSignIn', interactive: false })).data.state, 'signin_required');
  assert.equal(h.calls.some((call) => call.url?.includes('/start')), false);
});

test('packaged origin overrides saved origins without leaking old credentials', async () => {
  const h = harness({ packagedOrigin: 'https://deployment.example' });
  const settings = await h.send({ type: 'connectionSettings' });
  assert.equal(settings.data.baseUrl, 'https://deployment.example');
  assert.equal(settings.data.configured, false);
  assert.equal(h.local.token, undefined);
  await h.send({ type: 'browserSignIn', baseUrl: 'https://ignored.example' });
  assert.match(h.calls.find((call) => call.loginUrl).loginUrl, /^https:\/\/deployment.example\//);
});

test('AI settings are available only to trusted UI and return metadata', async () => {
  const h = harness();
  for (const type of ['aiSettings', 'selectAI', 'saveAIProvider', 'deleteAIProvider']) {
    assert.equal((await h.send({ type }, h.content)).ok, false);
  }
  const saved = await h.send({ type: 'saveAIProvider', provider: 'openai', apiKey: 'fixture-provider-secret', model: 'fixture-model' });
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes('fixture-provider-secret'), false);
  assert.equal((await h.send({ type: 'selectAI', mode: 'personal', provider: 'openai' })).ok, true);
  const status = await h.send({ type: 'test' });
  assert.equal(status.data.plan, 'pro');
  assert.equal(status.data.credits, 30);
});

const plain = (x) => JSON.parse(JSON.stringify(x));
const panelUi = (h) => ({ id: 'fixture-extension', url: 'chrome-extension://fixture-extension/src/sidepanel.html' });

test('assistant chat is for the side panel only and only forwards a sanitized page', async () => {
  const h = harness();
  const messages = [{ role: 'user', text: 'hi' }];
  assert.equal((await h.send({ type: 'chat', messages }, h.content)).ok, false);
  assert.equal((await h.send({ type: 'chatAction', action: { type: 'queue_job', job_id: 1 } }, h.content)).ok, false);

  const page = { url: 'https://jobs.example/apply/1#jobhunt-autofill=3', title: 'Engineer', extra: 'x' };
  assert.equal((await h.send({ type: 'chat', messages, tab: 'bogus', page }, panelUi(h))).ok, true);
  assert.deepEqual(plain(h.calls.find((c) => c.chat).chat), { messages, tab: 'chat', page: { url: 'https://jobs.example/apply/1', title: 'Engineer' } });

  await h.send({ type: 'chat', messages, tab: 'today', page: { url: 'file:///etc/passwd', title: 't' } }, panelUi(h));
  assert.equal(h.calls.filter((c) => c.chat).at(-1).chat.page, null);
  assert.equal((await h.send({ type: 'chat', messages: [] }, panelUi(h))).ok, false);
});

test('assistant actions are limited to known types and statuses', async () => {
  const h = harness();
  const ok = await h.send({ type: 'chatAction', action: { type: 'set_status', application_id: 4, status: 'interview' } }, panelUi(h));
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(h.calls.find((c) => c.action).action), { type: 'set_status', job_id: null, application_id: 4, status: 'interview' });
  for (const action of [{ type: 'set_status', application_id: 4, status: 'submitted' }, { type: 'delete_everything' }, null]) {
    assert.equal((await h.send({ type: 'chatAction', action }, panelUi(h))).ok, false);
  }
  assert.equal(h.calls.filter((c) => c.action).length, 1);
});
