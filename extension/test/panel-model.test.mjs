// Tests for src/panel-model.js: the panel's checklist, counts, and error wording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/panel-model.js", import.meta.url), "utf8"), ctx);
const P = ctx.JobHuntPanel;
const plain = (x) => JSON.parse(JSON.stringify(x));

const row = (kind, status, extra = {}) => ({ field: { kind, label: kind }, status, ...extra });

test("summarize lists the steps the form needs, in order", () => {
  const s = P.summarize([
    row("text", "filled", { source: "profile" }),
    row("text", "filled", { source: "generated", needsReview: true }),
    row("text", "unresolved"),
    row("picker", "unresolved"),
  ]);
  assert.deepEqual(plain(s.steps.map((x) => [x.id, x.remaining])), [["answer", 1], ["upload", 1], ["check", 1], ["submit", 1]]);
  assert.equal(s.steps[0].label, "Answer 1 question");
  assert.equal(s.headline, "3 things left for you");
  assert.equal(s.todo, 3);
  assert.equal(s.answered, 2);
  assert.equal(s.total, 4);
});

test("steps tick off as the user answers and reviews", () => {
  const s = P.summarize([
    row("text", "done", { source: "you" }),
    row("picker", "done", { manual: true }),
    row("text", "filled", { needsReview: true, reviewed: true }),
  ]);
  assert.deepEqual(plain(s.steps.map((x) => x.remaining)), [0, 0, 0, 1]);
  assert.equal(s.steps[1].label, "CV attached");
  assert.equal(s.headline, "All set: review and submit");
  assert.equal(s.progress, 1);
});

test("a form with only checks left says so", () => {
  const s = P.summarize([row("text", "filled", { needsReview: true })]);
  assert.equal(s.headline, "Almost there: check 1 answer");
  assert.deepEqual(plain(s.steps.map((x) => x.id)), ["check", "submit"]);
});

test("submitted and empty states", () => {
  assert.equal(P.summarize([], { submitted: true }).headline, "Submitted. Nice work!");
  assert.equal(P.summarize([], { submitted: true }).steps.at(-1).remaining, 0);
  assert.equal(P.summarize([]).headline, "No fields found on this page yet");
});

test("friendlyError picks the fixing action", () => {
  assert.equal(P.friendlyError("Invalid token", 401).action, "settings");
  assert.equal(P.friendlyError("Add your platform API key in the extension's options.", 401).action, "settings");
  const net = P.friendlyError("Failed to fetch", undefined, "http://localhost:3000");
  assert.equal(net.action, "retry");
  assert.match(net.title, /localhost:3000/);
  assert.equal(P.friendlyError("Extension context invalidated.").action, "reload");
  assert.equal(P.friendlyError("boom", 500).detail, "boom");
});

test("sourceLabel", () => {
  assert.equal(P.sourceLabel("answer_bank"), "From answer bank");
  assert.equal(P.sourceLabel("generated"), "AI draft");
  assert.equal(P.sourceLabel("weird"), "weird");
});
