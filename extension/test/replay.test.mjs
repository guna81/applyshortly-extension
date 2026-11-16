// Tier 0: free replay of the AI-led planner against simulated forms with a fake model (see apply-assistant/docs/development/form-agent-testing/single-agent-test-guide.md).
// Every fixture asserts the safety counters are zero and nothing was asked twice, plus whatever its `expect` says.
import assert from "node:assert/strict";
import { test } from "node:test";
import core from "./replay/fixtures/core.mjs";
import knownBugs, { widgetBugs } from "./replay/fixtures/known-bugs.mjs";
import { runReplay } from "./replay/replay-runner.mjs";

const norm = (text) => String(text ?? "").toLowerCase();

export function check(result, expect = {}) {
  const where = result.name;
  const ok = expect.outcome === "waiting_or_ready" ? ["waiting", "ready_for_review"] : [expect.outcome ?? "ready_for_review"];
  assert.ok(ok.includes(result.outcome), `${where}: outcome ${result.outcome}, wanted ${ok.join(" or ")} (asked: ${JSON.stringify(result.asked)}, errors: ${JSON.stringify(result.errors)})`);
  // Safety is never optional: any non-zero counter fails the fixture.
  assert.equal(result.safety.submit_attempts, expect.submit_attempts ?? 0, `${where}: submit attempts`);
  assert.equal(result.safety.captcha_touches, expect.captcha_touches ?? 0, `${where}: CAPTCHA touches`);
  assert.equal(result.safety.overwrites, expect.overwrites ?? 0, `${where}: overwrites`);
  assert.equal(result.safety.invented_legal, expect.invented_legal ?? 0, `${where}: invented legal facts ${JSON.stringify(result.safety.invented)}`);
  assert.equal(result.repeats, expect.repeats ?? 0, `${where}: repeated questions in ${JSON.stringify(result.asked)}`);
  if (expect.required_empty) assert.deepEqual(result.required_empty, expect.required_empty, `${where}: required fields left empty`);
  if (expect.questions_max !== undefined) assert.ok(result.questions <= expect.questions_max, `${where}: ${result.questions} questions, at most ${expect.questions_max}: ${JSON.stringify(result.asked)}`);
  if (expect.writes_max !== undefined) assert.ok(result.writes.length <= expect.writes_max, `${where}: ${result.writes.length} writes`);
  if (expect.model_calls_max !== undefined) assert.ok(result.model_calls <= expect.model_calls_max, `${where}: ${result.model_calls} model calls, at most ${expect.model_calls_max}`);
  if (expect.optional_filled_min !== undefined) assert.ok(result.optional_filled >= expect.optional_filled_min, `${where}: optional fields filled ${result.optional_filled}`);
  for (const [name, value] of Object.entries(expect.values ?? {})) assert.equal(result.values[name], value, `${where}: value of ${name}`);
  for (const part of expect.writes_exclude ?? []) assert.ok(!result.writes.some((w) => norm(w.label).includes(norm(part))), `${where}: wrote to a field matching ${part}`);
  for (const part of expect.asked_includes ?? []) assert.ok(result.asked.some((q) => norm(q).includes(norm(part))), `${where}: never asked about ${part}: ${JSON.stringify(result.asked)}`);
  for (const part of expect.asked_once ?? []) assert.ok(result.question_texts.filter((q) => norm(q).includes(norm(part))).length <= 1, `${where}: asked about ${part} more than once`);
  // "text@label": no write of that text into a field with that label (two fields can share a label, so values[] cannot say).
  for (const spec of expect.no_write_text ?? []) { const [text, label] = spec.split("@"); assert.ok(!result.writes.some((w) => w.text === text && norm(w.label) === norm(label)), `${where}: wrote "${text}" into a field labelled ${label}`); }
  if (expect.pages_seen) assert.deepEqual(result.pages_seen, expect.pages_seen, `${where}: pages visited`);
}

for (const fixture of [...core, ...knownBugs, ...widgetBugs]) {
  const options = fixture.todo ? { todo: fixture.todo } : {};
  test(`replay: ${fixture.name}`, options, async () => {
    const result = await runReplay(fixture);
    check(result, fixture.expect);
  });
}
