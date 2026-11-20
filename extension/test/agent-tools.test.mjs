// Changed 2026-11-18: the old one-reply planner is gone, so the tests that drove it (native tool calls, inline looks, plain-JSON
// fallback, vision frames) are removed; the Agent based form assistant agent's own tests are in form-agent.test.mjs. What stays is tools.js itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_CATALOG, clickAtRef, findElements } from '../src/agent-based/tools.js';

test('tools.js: run_js is the only code tool, and nothing in the catalog can submit', () => {
  // run_js (page script through the debugger) has its submit guard in TabDriver.evaluate.
  assert.deepEqual(TOOL_CATALOG.filter((t) => /js|eval|submit/i.test(t.name)).map((t) => t.name), ['run_js']);
});

test('tools.js: a screenshot point scales with the screenshot and must name exactly one control', () => {
  const obs = { screenshot_scale: 0.5, viewport_width: 1000, viewport_height: 800, elements: [{ ref: 'z', bounds: [200, 200, 100, 40] }, { ref: 'y', bounds: [210, 205, 20, 20] }] };
  assert.equal(clickAtRef(125, 105, obs), 'z'); // image pixels / 0.5 = css pixels
  assert.throws(() => clickAtRef(5000, 5, obs), /outside/);
  assert.throws(() => clickAtRef(110, 105, obs), /one observed control/); // two controls overlap here
});

test('tools.js: find returns the controls whose label, group, role or options match', () => {
  const obs = { elements: [{ ref: 'a', role: 'textbox', name: 'Phone' }, { ref: 'b', role: 'select', name: 'Country', options: ['India', 'Germany'] }] };
  assert.deepEqual(findElements(obs, 'germany').map((e) => e.ref), ['b']);
  assert.equal(findElements(obs, '').length, 2);
});
