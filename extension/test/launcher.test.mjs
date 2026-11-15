import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

// The side panel's launcher (launcher.js), loaded into the real side panel markup.
async function launcherPage({ status, tab = { id: 7, url: 'https://jobs.example/apply' }, prefs = {} }) {
  const dom = new JSDOM(source('sidepanel.html'), { url: 'https://extension.example/', runScripts: 'outside-only' });
  const win = dom.window;
  const sent = [];
  win.chrome = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === 'status') return { ok: true, data: status };
        if (m.type === 'start') return { ok: true, data: { found: true } };
        return { ok: true };
      },
      openOptionsPage: () => sent.push({ type: 'options' }),
      getURL: (p) => `chrome-extension://x/${p}`,
    },
    commands: { getAll: async () => [] },
    storage: { local: { get: async () => ({ ...prefs }), set: async (v) => { Object.assign(prefs, v); } }, onChanged: { addListener() {} } },
  };
  win.JobHuntPanel = { friendlyError: (e) => ({ title: 'Problem', detail: String(e) }) };
  const code = source('launcher.js').replace(/^import .*;$/gm, '').replaceAll('export function', 'function').replaceAll('export const', 'const');
  await win.eval(`(async () => { function activityList() {} function attention() {}\n${code}
    let started = 0;
    const l = createLauncher({ getTab: () => (${JSON.stringify(tab)}), openHint: 'hint', afterStart: async () => { started++; } });
    window.l = l; window.started = () => started;
    await l.render(await l.status());
  })()`);
  return { win, sent, doc: win.document };
}

test('an unconnected account sees the three first-run steps', async () => {
  const { doc } = await launcherPage({ status: { configured: false } });
  assert.equal(doc.querySelectorAll('#view .first-run li').length, 3);
  assert.equal(doc.querySelector('#connText').textContent, 'Not connected');
});

const connected = { configured: true, connected: true, baseUrl: 'https://app.example', name: 'A', credits: 3 };

test('opening the panel on an untracked page starts the chat by itself, with no Fill or Auto apply buttons', async () => {
  const { doc, sent, win } = await launcherPage({ status: connected });
  const start = sent.find((m) => m.type === 'start');
  assert.equal(start.allowUntracked, true);
  assert.equal(start.autoSubmit, false);
  assert.equal(win.started(), 1);
  assert.equal(doc.querySelector('#view .choice'), null);
  assert.equal(doc.querySelector('#autoApply').checked, false);
  assert.equal(doc.querySelector('#aiDrafts').checked, true);
  assert.equal(doc.querySelector('#prefs').hidden, false);
});

test('the Auto apply switch decides autoSubmit, and the switches save to storage', async () => {
  const prefs = { autoApply: true, aiDrafts: false };
  const { doc, sent } = await launcherPage({ status: connected, prefs });
  assert.equal(sent.find((m) => m.type === 'start').autoSubmit, true);
  assert.equal(doc.querySelector('#autoApply').checked, true);
  assert.equal(doc.querySelector('#aiDrafts').checked, false);
  const toggle = doc.querySelector('#aiDrafts');
  toggle.checked = true;
  toggle.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(prefs.aiDrafts, true);
});

test('a tracked job that was already sent is not started again by itself', async () => {
  const { doc, sent } = await launcherPage({ status: { ...connected, app: { id: 3, title: 'Engineer', status: 'submitted' } } });
  assert.equal(sent.find((m) => m.type === 'start'), undefined);
  assert.match(doc.querySelector('#view').textContent, /already applied/);
});

test('a non-web tab asks the user to open an application', async () => {
  const { doc } = await launcherPage({ status: { configured: true, connected: true, baseUrl: 'https://app.example' }, tab: { id: 1, url: 'chrome://extensions' } });
  assert.match(doc.querySelector('#view').textContent, /Open a job application/);
  assert.equal(doc.querySelector('#view .choice'), null);
});
