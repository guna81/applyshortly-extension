import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

async function controlPage(initial = {}) {
  const dom = new JSDOM(source('external-browser.html'), { url: 'https://extension.example/', runScripts: 'outside-only' });
  const win = dom.window;
  const sent = [];
  let state = { connected: false, wanted: false, batches: [], activity: [], ...initial };
  let allowed = true;
  win.setInterval = () => 1;
  win.chrome = {
    runtime: { sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'connectionSettings') return { ok: true, data: { baseUrl: 'https://app.example/' } };
      if (message.action === 'connect') state = { ...state, connected: true, wanted: true };
      if (message.action === 'continue') state = { ...state, paused: false };
      if (message.action === 'stop') state = { ...state, connected: false, wanted: false };
      return { ok: true, data: state };
    } },
    permissions: { contains: async () => false, request: async () => allowed },
  };
  const helpers = source('external-browser-state.js').replaceAll('export function', 'function') + source('external-activity.js').replaceAll('export function', 'function');
  const ui = source('external-browser-ui.js').replace(/^import .*;$/gm, '');
  await win.eval(`(async () => { ${helpers}\n${ui}\nwindow.refreshUx = refresh; })()`);
  return { win, sent, set: (patch) => { state = { ...state, ...patch }; }, allow: (value) => { allowed = value; }, refresh: () => win.refreshUx() };
}

const queue = (patch = {}) => ({ id: 'queue', assistant: 'Claude', state: 'pending', jobs: [{ title: 'Engineer', company: 'Example', url: 'https://employer.example/apply' }], policy: { index: 0 }, ...patch });

test('setup displays the configured product connector and separates local pause, queue pause and lost connection', async () => {
  const page = await controlPage();
  try {
    const doc = page.win.document;
    assert.equal(doc.querySelector('#connector-url').textContent, 'https://app.example/api/mcp');
    assert.equal(doc.querySelectorAll('.setup li').length, 4);
    assert.equal(doc.querySelector('#stop').hidden, true);
    page.set({ connected: true, wanted: true, paused: true }); await page.refresh();
    assert.equal(doc.querySelector('#state').textContent, 'Paused by you');
    assert.equal(doc.querySelector('#continue').hidden, false);
    doc.querySelector('#continue').click(); await page.refresh();
    assert(page.sent.some((m) => m.action === 'continue'));
    page.set({ batches: [queue({ state: 'paused' })] }); await page.refresh();
    assert.match(doc.querySelector('#recovery').textContent, /Ask your assistant to resume/);
    assert.equal(doc.querySelector('#continue').hidden, true);
    page.set({ batches: [queue({ state: 'active', policy: { index: 0, approved_at: Date.now() / 1000 - 7201 } })] }); await page.refresh();
    assert.equal(doc.querySelector('#state').textContent, 'Session expired');
    assert.match(doc.querySelector('#recovery').textContent, /start a new application queue/);
    page.set({ connected: false }); await page.refresh();
    assert.equal(doc.querySelector('#state').textContent, 'Connection lost');
    assert.equal(doc.querySelector('#connect').textContent, 'Reconnect');
    assert.equal(doc.querySelector('#stop').hidden, false);
  } finally { page.win.close(); }
});

test('site permission refusal never approves applications; submission approval remains explicit', async () => {
  const page = await controlPage({ connected: true, batches: [queue({ auto_submit: true })] });
  try {
    const doc = page.win.document;
    const approval = [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Approve filling and submitting');
    assert(approval);
    page.allow(false); await approval.onclick();
    assert.equal(page.sent.some((m) => m.action === 'decision'), false);
    page.allow(true); await approval.onclick();
    assert(page.sent.some((m) => m.action === 'decision' && m.approve === true));
    page.set({ batches: [queue({ auto_submit: false })] }); await page.refresh();
    assert([...doc.querySelectorAll('button')].some((b) => b.textContent === 'Approve filling'));
    assert(![...doc.querySelectorAll('button')].some((b) => b.textContent === 'Approve filling and submitting'));
  } finally { page.win.close(); }
});

test('answer review, uncertain submission and a finished queue have distinct outcomes', async () => {
  const page = await controlPage({ connected: true, pendingReview: { answers: [['City', 'Example city']] }, batches: [queue({ state: 'active' })] });
  try {
    const doc = page.win.document;
    assert.equal(doc.querySelector('#state').textContent, 'Review answers');
    await [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Approve these answers').onclick();
    assert(page.sent.some((m) => m.action === 'reviewAnswers'));
    page.set({ pendingReview: null, batches: [queue({ state: 'needs_verification' })] }); await page.refresh();
    assert.equal(doc.querySelector('#state').textContent, 'Submission needs verification');
    assert.match(doc.querySelector('#recovery').textContent, /Do not retry/);
    page.set({ batches: [queue({ state: 'complete' })] }); await page.refresh();
    assert.match(doc.querySelector('#activity').textContent, /Application queue finished — submissions confirmed/);
    assert(!doc.querySelector('#activity').textContent.includes('application 1 of 1'));
  } finally { page.win.close(); }
});

test('hosted connector uses the product host while development remains local', async () => {
  const { connectorUrl } = await import('../src/external-browser-state.js');
  assert.equal(connectorUrl('https://applyshortly.com'), 'https://app.applyshortly.com/api/mcp');
  assert.equal(connectorUrl('https://www.applyshortly.com/'), 'https://app.applyshortly.com/api/mcp');
  assert.equal(connectorUrl('http://localhost:3000'), 'http://localhost:3000/api/mcp');
});
