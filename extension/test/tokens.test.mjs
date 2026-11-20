import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// ui.css (settings and assistant pages) and panel-view.js (the on-page shadow DOM) each carry the
// colour tokens, because a closed shadow root can't read the stylesheet. They must not drift.
const ui = readFileSync(new URL('../src/ui/ui.css', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/shared/ui/panel-view.js', import.meta.url), 'utf8');

const SHARED = ['bg', 'fg', 'muted', 'line', 'soft', 'hover', 'accent', 'accent-soft', 'accent-fg',
  'good', 'good-soft', 'warn', 'warn-soft', 'bad', 'bad-soft'];

/** The `--name: light-dark(a, b);` declarations of the first block that starts at `anchor`. */
function tokens(src, anchor) {
  const start = src.indexOf(anchor);
  assert.ok(start >= 0, `missing ${anchor}`);
  const block = src.slice(start, src.indexOf('}', start)); // token blocks hold no nested braces
  const out = {};
  for (const [, name, light, dark] of block.matchAll(/--([a-z-]+):\s*light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\);/g)) out[name] = `${light} | ${dark}`;
  return out;
}

test('ui.css and the panel share the same light and dark tokens', () => {
  const fromUi = tokens(ui, ':root {');
  const fromPanel = tokens(panel, '.wrap {');
  for (const name of SHARED) {
    assert.ok(fromUi[name], `ui.css is missing --${name}`);
    assert.equal(fromPanel[name], fromUi[name], `--${name} differs between ui.css and panel-view.js`);
  }
});

test('no raw status hex colours outside the token blocks', () => {
  const body = panel.slice(panel.indexOf('.p { position'), panel.indexOf('`;', panel.indexOf('.p { position')));
  assert.doesNotMatch(body, /#(dc2626|16a34a|b45309)/i);
  const uiBody = ui.slice(ui.indexOf('* { box-sizing'));
  assert.doesNotMatch(uiBody, /#(22c55e|ef4444|f59e0b)/i);
});

test('the theme override only sets a colour scheme, so both token copies follow it', () => {
  assert.match(ui, /:root\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
  assert.match(panel, /\.wrap\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
});
