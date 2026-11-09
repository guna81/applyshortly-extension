import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueDiagnostic, flushDiagnostics, clearDiagnosticQueue } from '../src/diagnostics.js';

function storage() {
  const data = {};
  globalThis.chrome = { storage: { local: {
    get: async (key) => ({ [key]: data[key] }),
    set: async (value) => Object.assign(data, value),
    remove: async (key) => { delete data[key]; },
  } } };
  return data;
}

const batch = { session_key: 'agent:test', runtime: 'extension', events: [] };

test('queued diagnostics never persist bearer credentials and retry after connectivity returns', async () => {
  const data = storage();
  let offline = true;
  const received = [];
  const bridge = { baseUrl: 'https://app.example', token: 'private-token', diagnostic: async (body) => {
    if (offline) throw { status: 0 };
    received.push(body);
  } };
  await queueDiagnostic(bridge, batch);
  assert.equal(JSON.stringify(data).includes('private-token'), false);
  await flushDiagnostics(bridge);
  assert.equal(data.browserDiagnosticQueue.items.length, 1);
  offline = false;
  await flushDiagnostics(bridge);
  assert.deepEqual(received, [batch]);
  assert.equal(data.browserDiagnosticQueue.items.length, 0);
});

test('another account cannot receive pending diagnostics', async () => {
  const data = storage();
  await queueDiagnostic({ baseUrl: 'https://app.example', token: 'first' }, batch);
  await flushDiagnostics({ baseUrl: 'https://app.example', token: 'second', diagnostic: async () => assert.fail('cross-account upload') });
  assert.equal(data.browserDiagnosticQueue, undefined);
});

test('expired reports and revoked credentials are discarded', async () => {
  const data = storage();
  const bridge = { baseUrl: 'https://app.example', token: 'first', diagnostic: async () => { throw { status: 401 }; } };
  await queueDiagnostic(bridge, batch);
  data.browserDiagnosticQueue.items[0].at -= 25 * 60 * 60 * 1000;
  await flushDiagnostics({ ...bridge, diagnostic: async () => assert.fail('expired report') });
  assert.equal(data.browserDiagnosticQueue.items.length, 0);
  await queueDiagnostic(bridge, batch);
  await flushDiagnostics(bridge);
  assert.equal(data.browserDiagnosticQueue, undefined);
  await clearDiagnosticQueue();
});
