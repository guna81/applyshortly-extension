import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

function harness({ autofillId = null, autoCode = null, claimed = false, blocked = false, revoked = false, accountRevoked = false, wrongState = false, wrongCallback = false, cancelExchange = false, configStatus = 200, invalidConfig = false, configNetworkError = false, signedOut = false, declined = false, noProfile = false, packagedOrigin = "http://localhost:3000" } = {}) {
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
    profile() { if (noProfile) throw new BridgeError(404, 'Profile not created yet'); return { full_name: 'Fixture' }; }
    application(id) { if (blocked) throw new BridgeError(409, 'Verify the previous submission'); return { id }; }
    claimAutoApply(id, code) { calls.push({ claim: { id, code } }); return { auto_submit: claimed }; }
    lookup() { if (blocked) throw new BridgeError(409, 'Verify the previous submission'); return null; }
    websiteTicket() { return { ticket: 'fixture-short-lived-ticket' }; }
    assistFill(body) { calls.push({ assist: body }); return { reply: 'ok', updates: {}, warnings: [], done: false, choices: [] }; }
    disconnect() { calls.push('revoke'); if (revoked) throw new BridgeError(401, 'Revoked'); }
  }
  class FakeAgent {
    constructor(opts) { Object.assign(this, opts); this.status = 'running'; this.stopped = false; this.log = []; this.last = {}; calls.push({ agent: { tabId: opts.tabId, appId: opts.appId } }); }
    run() { calls.push('agentRun'); return Promise.resolve(); }
    reply(text) { calls.push({ agentReply: text }); }
    skip() { calls.push('agentSkip'); }
    resume() { calls.push('agentResume'); }
    pause() { calls.push('agentPause'); }
    stop() { this.stopped = true; calls.push('agentStop'); }
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
        const answer = declined && params.get('prompt') === 'none' ? { error: 'login_required' } : { code: 'fixture-one-time-code' };
        return `${callback}?${new URLSearchParams({ ...answer, state: wrongState ? 'wrong-state' : params.get('state') })}`;
      },
    },
    tabs: { onRemoved: { addListener() {} }, create: async (value) => calls.push(value), sendMessage: async () => {} },
    commands: { onCommand: { addListener() {} } }, scripting: {},
  };
  const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^/, 'const { BridgeError, JobHuntBridge, autoApplyCodeFromUrl, autofillIdFromUrl, Agent, TabDriver } = fixtures;\n');
  vm.runInNewContext(source, { chrome, URL, URLSearchParams, Uint8Array, TextEncoder, btoa, crypto: webcrypto, Date, console, fixtures: { BridgeError, JobHuntBridge, autoApplyCodeFromUrl: () => autoCode, autofillIdFromUrl: () => autofillId, Agent: FakeAgent, TabDriver: class {} }, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("platform.json")) return { ok: true, json: async () => ({ baseUrl: packagedOrigin }) };
    if (url.endsWith(".js")) return { ok: true, text: async () => `// ${url}` }; // the agent's page scripts
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
  const website = { id: runtime.id, url: `${packagedOrigin}/dashboard`, tab: { id: 11, url: `${packagedOrigin}/dashboard` } };
  const send = (msg, sender = ui) => new Promise((resolve) => listener(msg, sender, resolve));
  return { local, session, calls, access, send, content, website };
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
  assert.equal((await h.send({ type: 'openWebsite', path: '/applications' })).ok, true);
  const tab = h.calls.find((call) => call.url?.includes('/extension-session#'));
  assert.ok(tab);
  assert.equal(new URL(tab.url).search, '');
  assert.equal(new URLSearchParams(new URL(tab.url).hash.slice(1)).get('ticket'), 'fixture-short-lived-ticket');
  assert.equal(tab.url.includes('fixture-bearer'), false);
  assert.equal((await h.send({ type: 'openWebsite', path: '//evil.example' })).ok, false);
});

test('a missing profile is marked for the panel, which may open only the profile page', async () => {
  const h = harness({ noProfile: true });
  const result = await h.send({ type: 'context', appId: null }, h.content);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, 'profile_missing');
  assert.equal(h.local.token, 'fixture-bearer');
  h.local.connectionType = 'automatic';
  assert.equal((await h.send({ type: 'openProfile', path: '/billing' }, h.content)).ok, true);
  const tab = h.calls.find((call) => call.url?.includes('/extension-session#'));
  assert.equal(new URLSearchParams(new URL(tab.url).hash.slice(1)).get('next'), '/profile');
  assert.equal((await h.send({ type: 'openWebsite', path: '/profile' }, h.content)).ok, false);
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
    assert.match(result.error, /server|internet connection/i);
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

test('the panel assistant forwards page fields only for the application in this tab', async () => {
  const h = harness();
  h.session['tab:10'] = { appId: 5, origin: 'https://example.com' };
  const body = { messages: [{ role: 'user', text: 'Yes' }], fields: [{ key: 'f0', label: 'Relocate?', kind: 'radio', options: ['Yes', 'No'] }], current: { f0: '' } };
  assert.equal((await h.send({ type: 'assist', appId: 5, ...body }, h.content)).ok, true);
  assert.deepEqual(plain(h.calls.find((c) => c.assist).assist), body);
  assert.equal((await h.send({ type: 'assist', appId: 6, ...body }, h.content)).ok, false);
  assert.equal((await h.send({ type: 'assist', appId: 5, ...body, fields: [] }, h.content)).ok, false);
  assert.equal(h.calls.filter((c) => c.assist).length, 1);
});

test('website sign-in connects silently, and only the ApplyShortly origin may report it', async () => {
  const h = harness();
  delete h.local.token;
  assert.equal((await h.send({ type: 'webSession', signedIn: true }, h.content)).ok, false);
  assert.equal(h.calls.some((call) => call.loginUrl), false);
  const result = await h.send({ type: 'webSession', signedIn: true }, h.website);
  assert.equal(result.data.connected, true);
  assert.equal(h.local.token, 'fixture-automatic-key');
  const login = h.calls.find((call) => call.loginUrl);
  assert.equal(login.interactive, false);
  assert.equal(new URL(login.loginUrl).searchParams.get('prompt'), 'none');
});

test('website sign-out drops a revoked connection but leaves a working one alone', async () => {
  const revoked = harness({ accountRevoked: true });
  assert.equal((await revoked.send({ type: 'webSession', signedIn: false }, revoked.website)).data.connected, false);
  assert.equal(revoked.local.token, undefined);
  assert.equal(revoked.calls.some((call) => call.loginUrl), false);
  const manual = harness();
  assert.equal((await manual.send({ type: 'webSession', signedIn: false }, manual.website)).data.connected, true);
  assert.equal(manual.local.token, 'fixture-bearer');
});

test('a declined silent check reports sign-in required without exchanging a code', async () => {
  const h = harness({ declined: true });
  delete h.local.token;
  const result = await h.send({ type: 'browserSignIn', interactive: false });
  assert.equal(result.data.state, 'signin_required');
  assert.equal(h.local.token, undefined);
  assert.equal(h.calls.some((call) => call.url?.endsWith('/browser/exchange')), false);
  const forged = harness({ declined: true, wrongState: true });
  delete forged.local.token;
  assert.equal((await forged.send({ type: 'browserSignIn', interactive: false })).ok, false);
});

test('the agent runs in the tab it was started from, one tab at a time, and takes the panel\'s controls', async () => {
  const h = harness();
  const started = await h.send({ type: 'agentStart', appId: null }, h.content);
  assert.equal(started.ok, true);
  assert.deepEqual(h.calls.filter((c) => c.agent || c === 'agentRun'), [{ agent: { tabId: 10, appId: null } }, 'agentRun']);
  // A later page in the same tab shows the agent instead of autofilling over it.
  assert.equal((await h.send({ type: 'hello', url: 'https://ats.example/step-2' }, h.content)).data.mode, 'agent');

  const other = { ...h.content, tab: { id: 12, url: 'https://example.com/apply' } };
  const second = await h.send({ type: 'agentStart', appId: null }, other);
  assert.equal(second.ok, false);
  assert.match(second.error, /another tab/);

  assert.equal((await h.send({ type: 'agentControl', action: 'reply', text: ' 30 days ' }, h.content)).ok, true);
  assert.equal((await h.send({ type: 'agentControl', action: 'reply', text: '  ' }, h.content)).ok, false);
  assert.equal((await h.send({ type: 'agentControl', action: 'submit' }, h.content)).ok, false);
  assert.equal((await h.send({ type: 'agentControl', action: 'skip' }, other)).ok, false); // not running there
  assert.equal((await h.send({ type: 'agentStatus' }, h.content)).data.status, 'running');
  assert.equal((await h.send({ type: 'agentControl', action: 'stop' }, h.content)).ok, true);
  assert.deepEqual(h.calls.filter((c) => c.agentReply || c === 'agentStop'), [{ agentReply: '30 days' }, 'agentStop']);
});

test('the agent refuses an application whose last submission is unconfirmed', async () => {
  const h = harness({ blocked: true });
  const result = await h.send({ type: 'agentStart', tabId: 10, url: 'https://example.com/apply', appId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(h.calls.some((c) => c === 'agentRun'), false);
});

test('a page opened by Apply in ApplyShortly auto applies once its one-time code is claimed', async () => {
  const opened = harness({ autofillId: 7, autoCode: 'fixture-one-time-apply-code', claimed: true });
  const hello = await opened.send({ type: 'hello', url: 'https://www.linkedin.com/jobs/view/9' }, opened.content);
  // Objects from the worker's own realm: compare their fields.
  assert.equal(JSON.stringify(hello.data), JSON.stringify({ appId: 7, mode: 'fill', autoSubmit: true }));
  assert.equal(JSON.stringify(opened.calls.find((c) => c.claim)?.claim), JSON.stringify({ id: 7, code: 'fixture-one-time-apply-code' }));

  // Already claimed (a reload), or forged: fill only.
  const reloaded = harness({ autofillId: 7, autoCode: 'fixture-one-time-apply-code', claimed: false });
  assert.equal((await reloaded.send({ type: 'hello', url: 'https://www.linkedin.com/jobs/view/9' }, reloaded.content)).data.autoSubmit, false);
  // Open & Autofill links carry no code: nothing is claimed.
  const plain = harness({ autofillId: 7 });
  assert.equal((await plain.send({ type: 'hello', url: 'https://www.linkedin.com/jobs/view/9' }, plain.content)).data.autoSubmit, false);
  assert.equal(plain.calls.some((c) => c.claim), false);
});
