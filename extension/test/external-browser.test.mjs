import assert from 'node:assert/strict';
import { test } from 'node:test';
import { externalBrowser, waitForApplicationTab } from '../src/external-browser.js';

test('opening waits for Chrome to commit the URL and complete navigation', async () => {
  const states = [{ url: '', status: 'loading' }, { url: 'https://fixture.example/apply', status: 'loading' }, { url: 'https://fixture.example/apply', status: 'complete' }];
  const tab = await waitForApplicationTab(7, { get: async (id) => { assert.equal(id, 7); return states.shift(); } });
  assert.equal(tab.status, 'complete');
  assert.equal(states.length, 0);
});

test('relay authenticates in its first frame without credential URLs or AI calls', async () => {
  const previous = globalThis.WebSocket;
  const sent = [], urls = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { urls.push(url); queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      const data = packet.path === '/devices' ? { device_id: 'fixture-device' }
        : packet.path.endsWith('/poll') ? { batches: [], commands: [] } : { state: 'active' };
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket;
  const controller = externalBrowser({
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 'fixture-secret' }),
    sources: async () => { throw new Error('No application was opened'); },
    resume: async () => { throw new Error('No upload requested'); },
    report: async () => { throw new Error('No application was attempted'); },
  });
  try {
    assert.deepEqual(await controller.connect(), { device_id: 'fixture-device' });
    assert.deepEqual(urls, ['wss://fixture.example/api/extension/browser/relay']);
    assert.deepEqual(sent[0], { token: 'fixture-secret' });
    assert(sent.slice(1).every((packet) => packet.path.startsWith('/devices')));
    await controller.decision('fixture-batch', true);
    assert.equal(sent.at(-1).body.approve, true);
    assert.equal(controller.status().connected, true);
    const steps = controller.status().activity.map((entry) => entry.text);
    assert(steps.includes('Browser connected. Waiting for your assistant'));
    assert(steps.includes('You approved the selected applications'));
    assert(controller.status().activity.every((entry) => !('value' in entry)));
    await controller.stop();
    assert.equal(controller.status().connected, false);
  } finally { await controller.stop(); globalThis.WebSocket = previous; }
});

test('submission validates checked consent while retaining required field and native guards', async () => {
  const { validateApplicationForm } = await import('../src/external-browser.js');
  const originalFill = globalThis.JobHuntFill;
  const originalDocument = globalThis.document;
  const checkbox = { kind: 'checkbox', label: 'Consent', required: true, el: { checked: false } };
  let valid = true;
  const button = { disabled: false, getAttribute: () => null, form: { checkValidity: () => valid } };
  globalThis.document = { querySelector: () => null };
  globalThis.JobHuntFill = {
    collectFields: () => [checkbox],
    findSubmitButton: () => button,
    isInvalid: () => false,
    isEmpty: () => true,
  };
  try {
    assert.equal(validateApplicationForm(), false);
    checkbox.el.checked = true;
    assert.equal(typeof validateApplicationForm(), 'string');
    valid = false;
    assert.equal(validateApplicationForm(), false);
    valid = true;
    checkbox.kind = 'file';
    assert.equal(validateApplicationForm(), false);
  } finally {
    globalThis.JobHuntFill = originalFill;
    globalThis.document = originalDocument;
  }
});

test('a dropped connection reconnects and asks for the same device back', async () => {
  const previous = globalThis.WebSocket;
  const sockets = [], sent = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      const data = packet.path === '/devices' ? { device_id: 'dev-1' } : { batches: [], commands: [] };
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket;
  const controller = externalBrowser({
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
  });
  try {
    await controller.connect();
    assert.equal(sent.find((p) => p.path === '/devices').body.resume_device_id, undefined, 'first connect asks for a new device');
    sockets[0].readyState = 3; sockets[0].onclose();
    assert.equal(controller.status().connected, false);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(sockets.length, 2, 'a second connection was opened');
    const registrations = sent.filter((p) => p.path === '/devices');
    assert.equal(registrations.at(-1).body.resume_device_id, 'dev-1');
    assert.equal(controller.status().connected, true);
    await controller.stop();
    sockets[1].readyState = 3; sockets[1].onclose();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(sockets.length, 2, 'after the user stops it there is no reconnect');
  } finally { await controller.stop(); globalThis.WebSocket = previous; }
});

test('idle release keeps the browser connected and re-attaches without reloading; options and review read the form', async () => {
  const previous = { ws: globalThis.WebSocket, chrome: globalThis.chrome, interval: globalThis.setInterval, now: Date.now };
  const sent = [];
  let tick = null, queue = [], created = 0, drivers = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      let data = { state: 'ok' };
      if (packet.path === '/devices') data = { device_id: 'dev' };
      else if (packet.path.endsWith('/poll')) {
        data = { batches: [{ id: 'b', state: 'active', policy: { application_ids: [1], index: 0 } }], commands: queue };
        queue = [];
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  const job = { application_id: 1, url: 'https://fixture.example/apply' };
  const command = (id, action) => ({ id, application_id: 1, batch_id: 'b', jobs: [job], action });
  const page = {
    url: 'https://fixture.example/apply', title: 'Apply', dialog: null, blockers: [], errors: [], text: '', more_below: false, document_id: 'doc',
    elements: [
      { ref: '1', role: 'textbox', name: 'Email', value: 'a@b.c', required: true },
      { ref: '2', role: 'combobox', name: 'Resume check', value: '', required: true, options: ['I have submitted a PDF version of my resume.'] },
      { ref: '3', role: 'combobox', name: 'City', value: '', required: true, options: ['Chennai', 'Trichy'] },
      { ref: '4', role: 'textbox', name: 'Nickname', value: '' },
    ],
  };
  class Driver {
    tabId = 9; calls = [];
    async attach() { this.calls.push('attach'); }
    async detach() { this.calls.push('detach'); }
    async frames() { return [{ frameId: 'top', isTop: true }]; }
    async offset() { return { x: 0, y: 0 }; }
    async call(frame, name) { if (name === 'observe') return page; throw new Error(`unexpected ${name}`); }
  }
  globalThis.WebSocket = Socket;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  globalThis.chrome = { tabs: {
    create: async () => { created++; return { id: 9 }; },
    get: async () => ({ id: 9, url: 'https://fixture.example/apply', status: 'complete' }),
  } };
  const controller = externalBrowser({
    timers: { setTimeout: (fn) => { tick = fn; return 1; }, clearTimeout: () => {} },
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
    makeDriver: () => { const d = new Driver(); drivers.push(d); return d; },
  });
  const results = () => sent.filter((p) => p.path?.endsWith('/result')).map((p) => p.body);
  const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    queue = [command('c1', { type: 'open' }), command('c2', { type: 'observe' })];
    await controller.connect();
    const observation = results().at(-1).result;
    assert.equal(results().length, 2);
    queue = [
      command('c3', { type: 'options', ref: '0.3', observation_id: observation.observation_id }),
      command('c4', { type: 'review', observation_id: observation.observation_id }),
    ];
    tick(); await wait();
    const [options, review] = results().slice(-2).map((r) => r.result.last_action);
    assert.deepEqual(options.options, ['Chennai', 'Trichy']);
    assert.deepEqual(review.missing_required.map((m) => m.name), ['Resume check', 'City']);
    assert.deepEqual(review.needs_confirmation.map((n) => n.name), ['Resume check']);
    assert.equal(review.fields.find((f) => f.name === 'Email').value, 'a@b.c');
    // Idle: the tab is let go but the browser stays connected, and the next command re-attaches.
    const start = Date.now();
    Date.now = () => start + 200_000;
    queue = [command('c5', { type: 'observe' })];
    tick(); await wait();
    assert.deepEqual(drivers.map((d) => d.calls), [['attach', 'detach'], ['attach']], 'released, then a new attach for the same tab');
    assert.equal(created, 1, 'the page was not reopened');
    assert.equal(results().at(-1).ok, true);
    assert.equal(controller.status().connected, true);
  } finally {
    Date.now = previous.now; globalThis.setInterval = previous.interval; globalThis.chrome = previous.chrome;
    await controller.stop(); globalThis.WebSocket = previous.ws;
  }
});

test('fill_form follows fields across a re-render that renumbers every ref', async () => {
  const previous = { ws: globalThis.WebSocket, chrome: globalThis.chrome, interval: globalThis.setInterval };
  const sent = [];
  let queue = [], generation = 0;
  const typed = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      let data = { state: 'ok' };
      if (packet.path === '/devices') data = { device_id: 'dev' };
      else if (packet.path.endsWith('/poll')) {
        data = { batches: [{ id: 'b', state: 'active', policy: { application_ids: [1], index: 0 } }], commands: queue };
        queue = [];
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  const fields = ['First', 'Last', 'Email'];
  const values = {};
  // Every observation hands out new local refs, as a site that re-mounts its form does.
  const page = () => ({
    url: 'https://fixture.example/apply', title: 'Apply', dialog: null, blockers: [], errors: [], text: '', more_below: false, document_id: 'doc',
    elements: fields.map((name, i) => ({ ref: String(generation * 10 + i + 1), role: 'textbox', name, input_type: 'text', value: values[name] ?? '', required: true })),
  });
  class Driver {
    tabId = 9;
    async attach() {}
    async detach() {}
    async frames() { return [{ frameId: 'top', isTop: true }]; }
    async offset() { return { x: 0, y: 0 }; }
    async click() {}
    async call(frame, name, ...args) {
      switch (name) {
        case 'observe': generation++; this.map = new Map(page().elements.map((e) => [e.ref, e.name])); return page();
        case 'freshState': return { document_id: 'doc', present: args[0] === '' || this.map.has(args[0]), user_edited: false, value: values[this.map.get(args[0])] ?? '' };
        case 'clickable': return null;
        case 'box': return { x: 1, y: 1, width: 5, height: 5 };
        case 'focusForTyping': return { ok: true, mode: 'direct' };
        case 'setDirect': values[this.map.get(args[0])] = args[1]; typed.push([this.map.get(args[0]), args[1]]); return { ok: true };
        case 'committedValue': return values[this.map.get(args[0])] ?? '';
        case 'blur': return true;
        default: throw new Error(`unexpected ${name}`);
      }
    }
  }
  globalThis.WebSocket = Socket;
  let tick = null;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  globalThis.chrome = { tabs: {
    create: async () => ({ id: 9 }),
    get: async () => ({ id: 9, url: 'https://fixture.example/apply', status: 'complete' }),
  } };
  const job = { application_id: 1, url: 'https://fixture.example/apply' };
  const command = (id, action) => ({ id, application_id: 1, batch_id: 'b', jobs: [job], action });
  const controller = externalBrowser({
    timers: { setTimeout: (fn) => { tick = fn; return 1; }, clearTimeout: () => {} },
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
    makeDriver: () => new Driver(),
  });
  try {
    queue = [command('f1', { type: 'open' }), command('f2', { type: 'observe' })];
    await controller.connect();
    const first = sent.filter((p) => p.path?.endsWith('/result')).at(-1).body.result;
    const refs = Object.fromEntries(first.elements.map((e) => [e.name, e.ref]));
    // One fill for all three fields, using the refs of the first observation only.
    queue = [command('f3', { type: 'fill_form', observation_id: first.observation_id,
      fields: JSON.stringify([{ ref: refs.First, text: 'Guna' }, { ref: refs.Last, text: 'P' }, { ref: refs.Email, text: 'g@x.y' }]) })];
    tick(); await new Promise((resolve) => setTimeout(resolve, 50));
    const done = sent.filter((p) => p.path?.endsWith('/result')).at(-1).body.result;
    assert.deepEqual(typed, [['First', 'Guna'], ['Last', 'P'], ['Email', 'g@x.y']]);
    assert.deepEqual(done.last_action.fields.map((f) => f.ok), [true, true, true]);
    assert.equal(done.last_action.done, 3);
  } finally {
    globalThis.setInterval = previous.interval; globalThis.chrome = previous.chrome;
    await controller.stop(); globalThis.WebSocket = previous.ws;
  }
});

test('pause for me releases the tab, refuses commands, and continue re-reads the page so the old observation still works', async () => {
  const previous = { ws: globalThis.WebSocket, chrome: globalThis.chrome, interval: globalThis.setInterval };
  const sent = [], drivers = [], values = {};
  let queue = [], tick = null, generation = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      let data = { state: 'ok' };
      if (packet.path === '/devices') data = { device_id: 'dev' };
      else if (packet.path.endsWith('/poll')) {
        data = { batches: [{ id: 'b', state: 'active', policy: { application_ids: [1], index: 0 } }], commands: queue };
        queue = [];
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  const names = ['First', 'Last'];
  const page = () => ({
    url: 'https://fixture.example/apply', title: 'Apply', dialog: null, blockers: [], errors: [], text: '', more_below: false, document_id: 'doc',
    elements: names.map((name, i) => ({ ref: String(i + 1), role: 'textbox', name, input_type: 'text', value: values[name] ?? '', required: true })),
  });
  class Driver {
    tabId = 9; calls = [];
    async attach() { this.calls.push('attach'); }
    async detach() { this.calls.push('detach'); }
    async frames() { return [{ frameId: 'top', isTop: true }]; }
    async offset() { return { x: 0, y: 0 }; }
    async click() {}
    async call(frame, name, ...args) {
      switch (name) {
        case 'observe': generation++; return page();
        case 'freshState': return { document_id: 'doc', present: true, user_edited: false, value: values[names[Number(args[0]) - 1]] ?? '' };
        case 'clickable': return null;
        case 'box': return { x: 1, y: 1, width: 5, height: 5 };
        case 'focusForTyping': return { ok: true, mode: 'direct' };
        case 'setDirect': values[names[Number(args[0]) - 1]] = args[1]; return { ok: true };
        case 'committedValue': return values[names[Number(args[0]) - 1]] ?? '';
        case 'blur': return true;
        default: throw new Error(`unexpected ${name}`);
      }
    }
  }
  globalThis.WebSocket = Socket;
  globalThis.setInterval = (fn) => { tick = fn; return 1; };
  globalThis.chrome = { tabs: {
    create: async () => ({ id: 9 }),
    get: async () => ({ id: 9, url: 'https://fixture.example/apply', status: 'complete' }),
  } };
  const job = { application_id: 1, url: 'https://fixture.example/apply' };
  const command = (id, action) => ({ id, application_id: 1, batch_id: 'b', jobs: [job], action });
  const controller = externalBrowser({
    timers: { setTimeout: (fn) => { tick = fn; return 1; }, clearTimeout: () => {} },
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
    makeDriver: () => { const d = new Driver(); drivers.push(d); return d; },
  });
  const results = () => sent.filter((p) => p.path?.endsWith('/result')).map((p) => p.body);
  const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    queue = [command('p1', { type: 'open' }), command('p2', { type: 'observe' })];
    await controller.connect();
    const id = results().at(-1).result.observation_id;
    // The user takes the form: the tab is let go and commands are refused.
    await controller.pauseForUser();
    assert.equal(controller.status().paused, true);
    assert.deepEqual(drivers[0].calls, ['attach', 'detach']);
    queue = [command('p3', { type: 'fill_form', observation_id: id, fields: JSON.stringify([{ ref: '0.1', text: 'Guna' }]) })];
    tick(); await wait();
    assert.equal(results().at(-1).ok, false);
    assert.match(results().at(-1).result.error, /paused browser control/);
    // Continue: the same observation_id still works; the page was re-read on re-attach.
    controller.continueAfterUser();
    assert.equal(controller.status().paused, false);
    queue = [command('p4', { type: 'fill_form', observation_id: id, fields: JSON.stringify([{ ref: '0.1', text: 'Guna' }, { ref: '0.2', text: 'P' }]) })];
    tick(); await wait(80);
    const done = results().at(-1);
    assert.equal(done.ok, true, JSON.stringify(done.result).slice(0, 300));
    assert.equal(done.result.last_action.done, 2, JSON.stringify(done.result.last_action));
    assert.deepEqual(values, { First: 'Guna', Last: 'P' });
    assert.equal(drivers.length, 2, 're-attached with a new driver, no reload');
    // Each field is its own step, with its position, and never carries the typed value.
    const steps = controller.status().activity.map((entry) => entry.text);
    assert(steps.includes('Typing into “First” (1 of 2)'), steps.join(' | '));
    assert(steps.includes('Typing into “Last” (2 of 2)'));
    assert(steps.every((text) => !text.includes('Guna')));
  } finally {
    globalThis.setInterval = previous.interval; globalThis.chrome = previous.chrome;
    await controller.stop(); globalThis.WebSocket = previous.ws;
  }
});

// A relay whose first poll offers one pending batch; records every decision the controller makes.
async function withPendingBatch(batch, options, body) {
  const previous = globalThis.WebSocket;
  const decisions = [], registrations = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value);
      if (!packet.id) return;
      if (packet.path === '/devices') registrations.push(packet.body);
      if (packet.path.endsWith('/decision')) decisions.push(packet.body.approve);
      const data = packet.path === '/devices' ? { device_id: 'fixture-device' }
        : packet.path.endsWith('/poll') ? { batches: [{ ...batch, state: 'pending' }], commands: [] } : { state: 'active' };
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = Socket;
  const kept = {};
  const controller = externalBrowser({
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 'fixture-secret' }),
    sources: async () => '', resume: async () => null, report: async () => {},
    store: { get: async (key) => ({ [key]: kept[key] }), set: async (value) => Object.assign(kept, value) },
    ...options,
  });
  try { await body({ controller, decisions, registrations, kept }); }
  finally { await controller.stop(); globalThis.WebSocket = previous; }
}
const fillBatch = (extra = {}) => ({ id: 'b1', assistant: 'Claude', jobs: [{ application_id: 1, title: 'AI', company: 'Y', url: 'https://boards.example/job/1' }], policy: { application_ids: [1], index: 0 }, auto_submit: false, ...extra });

test('a trusted assistant starts a fill-only batch on an allowed site without asking', async () => {
  const asked = [];
  await withPendingBatch(fillBatch(), { hasAccess: async (origins) => { asked.push(origins); return true; } }, async ({ controller, decisions }) => {
    await controller.setAutoApprove(true);
    await controller.connect();
    assert.deepEqual(decisions, [true]);
    assert.deepEqual(asked, [['https://boards.example/*']]);
  });
});

test('nothing is approved on its own unless the user switched it on, the batch only fills and the site is allowed', async () => {
  const cases = [
    ['setting off', fillBatch(), async () => true, false],
    ['batch may submit', fillBatch({ auto_submit: true }), async () => true, true],
    ['site not allowed yet', fillBatch(), async () => false, true],
    ['permission check fails', fillBatch(), async () => { throw new Error('x'); }, true],
  ];
  for (const [name, batch, hasAccess, on] of cases) {
    await withPendingBatch(batch, { hasAccess }, async ({ controller, decisions }) => {
      await controller.setAutoApprove(on);
      await controller.connect();
      assert.deepEqual(decisions, [], name);
      assert(controller.status().activity.some((entry) => /Waiting for your approval/.test(entry.text)), name);
    });
  }
});

test('a connected browser reconnects by itself, asks for its old device and stops for good on Stop', async () => {
  await withPendingBatch(fillBatch(), {}, async ({ controller, registrations, kept }) => {
    await controller.connect();
    assert.equal(kept.externalBrowser.wanted, true);
    assert.equal(kept.externalBrowser.device, 'fixture-device');
    const reborn = externalBrowser({
      settings: async () => ({ baseUrl: 'https://fixture.example', token: 'fixture-secret' }),
      sources: async () => '', resume: async () => null, report: async () => {},
      store: { get: async (key) => ({ [key]: kept[key] }), set: async (value) => Object.assign(kept, value) },
    });
    try {
      assert.equal(await reborn.resumeIfWanted(), true);
      assert.equal(reborn.status().connected, true);
      assert.equal(registrations.at(-1).resume_device_id, 'fixture-device');
    } finally { await reborn.stop(); }
    assert.equal(kept.externalBrowser.wanted, false);
    const after = externalBrowser({ settings: async () => ({ token: 'x' }), sources: async () => '', resume: async () => null, report: async () => {}, store: { get: async (key) => ({ [key]: kept[key] }), set: async () => {} } });
    assert.equal(await after.resumeIfWanted(), false);
  });
});

test('fill_form chooses from a dropdown instead of typing into it, and reports a value the page does not show', async () => {
  const previous = { ws: globalThis.WebSocket, chrome: globalThis.chrome };
  const sent = [], calls = [];
  let queue = [], tick = null;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      let data = { state: 'ok' };
      if (packet.path === '/devices') data = { device_id: 'dev' };
      else if (packet.path.endsWith('/poll')) {
        data = { batches: [{ id: 'b', state: 'active', policy: { application_ids: [1], index: 0 } }], commands: queue };
        queue = [];
      }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  // A "Country" search box that is really a dropdown (popup), and a text box the page empties again.
  const page = () => ({
    url: 'https://fixture.example/apply', title: 'Apply', dialog: null, blockers: [], errors: [], text: 'page text', more_below: false, document_id: 'doc',
    elements: [
      { ref: '1', role: 'textbox', name: 'Country', input_type: 'text', popup: true, value: '', required: true },
      { ref: '2', role: 'textbox', name: 'Notes', input_type: 'text', value: '', required: false },
    ],
  });
  class Driver {
    tabId = 9;
    async attach() {}
    async detach() {}
    async frames() { return [{ frameId: 'top', isTop: true }]; }
    async offset() { return { x: 0, y: 0 }; }
    async click() {}
    async call(frame, name, ...args) {
      calls.push(name);
      switch (name) {
        case 'observe': return page();
        case 'freshState': return { document_id: 'doc', present: true, user_edited: false, value: '' };
        case 'clickable': return null;
        case 'box': return { x: 1, y: 1, width: 5, height: 5 };
        case 'selectNative': return { native: false };
        case 'noteShown': return true;
        case 'matchOption': return { ok: true, ref: 'o1', text: 'India' };
        case 'committedValue': return args[0] === '1' ? 'India' : '';
        case 'focusForTyping': return { ok: true, mode: 'direct' };
        case 'setDirect': return { ok: true };
        case 'blur': return true;
        default: throw new Error(`unexpected ${name}`);
      }
    }
  }
  globalThis.WebSocket = Socket;
  globalThis.chrome = { tabs: {
    create: async () => ({ id: 9 }),
    get: async () => ({ id: 9, url: 'https://fixture.example/apply', status: 'complete' }),
  } };
  const job = { application_id: 1, url: 'https://fixture.example/apply' };
  const command = (id, action) => ({ id, application_id: 1, batch_id: 'b', jobs: [job], action });
  const controller = externalBrowser({
    timers: { setTimeout: (fn) => { tick = fn; return 1; }, clearTimeout: () => {} },
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
    makeDriver: () => new Driver(),
  });
  try {
    queue = [command('c1', { type: 'open' }), command('c2', { type: 'observe' })];
    await controller.connect();
    const first = sent.filter((p) => p.path?.endsWith('/result')).at(-1).body.result;
    queue = [command('c3', { type: 'fill_form', delta: 'true', observation_id: first.observation_id,
      fields: JSON.stringify([{ ref: first.elements[0].ref, text: 'India' }, { ref: first.elements[1].ref, text: 'hello' }]) })];
    tick(); await new Promise((resolve) => setTimeout(resolve, 200));
    const done = sent.filter((p) => p.path?.endsWith('/result')).at(-1).body.result;
    const [country, notes] = done.last_action.fields;
    assert(calls.includes('matchOption'), 'the dropdown was chosen from');
    assert.equal(country.ok, true);
    assert.equal(country.verified, true);
    assert.equal(country.committed, 'India');
    assert.equal(notes.ok, false, 'a value the page does not show is not a success');
    assert.equal(notes.verified, false);
    assert.equal(done.last_action.done, 1);
    assert.equal(done.text, '', 'a delta reply leaves out the page text');
  } finally {
    globalThis.chrome = previous.chrome;
    await controller.stop(); globalThis.WebSocket = previous.ws;
  }
});

test('a message to the assistant is sent to the active batch and shows as read once the server stops listing it', async () => {
  const previous = { ws: globalThis.WebSocket };
  const sent = [];
  let unread = [], tick = null;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value); sent.push(packet);
      if (!packet.id) return;
      let data = { state: 'ok' };
      if (packet.path === '/devices') data = { device_id: 'dev' };
      else if (packet.path.endsWith('/poll')) data = { batches: [{ id: 'b', state: 'active', policy: { application_ids: [1], index: 0 } }], commands: [], notes: unread };
      else if (packet.path.endsWith('/note')) { data = { id: 'n1' }; unread = ['n1']; }
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket;
  const controller = externalBrowser({
    timers: { setTimeout: (fn) => { tick = fn; return 1; }, clearTimeout: () => {} },
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
  });
  try {
    await controller.connect();
    await assert.rejects(controller.sendNote('   '), /Write a message/);
    await controller.sendNote('  Use my work email  ');
    const packet = sent.find((p) => p.path === '/devices/dev/batches/b/note');
    assert.deepEqual(packet.body, { text: 'Use my work email' });
    assert.deepEqual(controller.notes(), [{ id: 'n1', text: 'Use my work email', read: false }]);
    await tick(); // the server still lists it: the assistant has not read it
    assert.equal(controller.notes()[0].read, false);
    unread = [];
    await tick();
    assert.equal(controller.notes()[0].read, true);
    const log = controller.status().activity.map((entry) => entry.text);
    assert(log.includes('You sent your assistant a message') && log.includes('Your assistant read your message'));
    assert(controller.status().activity.every((entry) => !entry.text.includes('work email')), 'what the user wrote stays out of the activity log');
  } finally { await controller.stop(); globalThis.WebSocket = previous.ws; }
});

test('a message cannot be sent when no application is open for the assistant', async () => {
  const previous = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { queueMicrotask(() => this.onopen?.({})); }
    send(value) {
      const packet = JSON.parse(value);
      if (!packet.id) return;
      const data = packet.path === '/devices' ? { device_id: 'dev' } : { batches: [], commands: [] };
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: packet.id, data }) }));
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket;
  const controller = externalBrowser({
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
    settings: async () => ({ baseUrl: 'https://fixture.example', token: 't' }),
    sources: async () => '', resume: async () => null, report: async () => {},
  });
  try {
    await controller.connect();
    await assert.rejects(controller.sendNote('hello'), /no approved application/);
  } finally { await controller.stop(); globalThis.WebSocket = previous; }
});
