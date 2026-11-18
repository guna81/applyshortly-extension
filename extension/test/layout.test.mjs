// Added 2026-11-18. The source folders say which engine a file belongs to: src/rule-based (rule-based form assistant), src/agent-based
// (the ReAct agent), src/page-control (the page-driving layer: observe, guarded commands, chrome.debugger). Every script the manifest and the background name must exist.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const files = (dir) => readdirSync(new URL(dir, root)).filter((f) => f.endsWith(".js"));

test("the rule based form assistant, agent based form assistant and page-control folders hold their files", () => {
  for (const f of ["fill.js", "profile-answer.js", "panel-model.js", "panel-view.js", "content.js"]) assert.ok(existsSync(new URL(`src/rule-based/${f}`, root)), `src/rule-based/${f}`);
  for (const f of ["loop.js", "commands.js", "page.js", "cdp.js"]) assert.ok(existsSync(new URL(`src/page-control/${f}`, root)), `src/page-control/${f}`);
  assert.equal(existsSync(new URL("src/agent", root)), false, "src/agent is gone: agent-based and page-control sit beside rule-based");
});

test("every script the manifest and the background inject exists", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const named = manifest.content_scripts.flatMap((c) => c.js);
  const background = read("src/background.js");
  for (const m of background.matchAll(/"(src\/[\w\-./]+\.(?:js|html))"/g)) named.push(m[1]);
  assert.ok(named.length >= 8);
  for (const path of named) assert.ok(existsSync(new URL(path, root)), `${path} is named but missing`);
});

test("the two engines do not import each other's files", () => {
  const imports = (dir) => files(dir).flatMap((f) => [...read(`${dir}/${f}`).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(imports("src/rule-based"), []);
  assert.deepEqual(imports("src/agent-based").filter((p) => /rule-based/.test(p)), []);
});
