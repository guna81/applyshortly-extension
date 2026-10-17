// Tests for src/chat-model.js: history trimming, quick replies, board grouping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/chat-model.js", import.meta.url), "utf8"), ctx);
const C = ctx.JobHuntChat;
const plain = (x) => JSON.parse(JSON.stringify(x));

test("trimHistory keeps the latest turns and drops blanks and unknown roles", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }));
  const out = C.trimHistory([...many, { role: "user", text: "   " }, { role: "system", text: "x" }, { role: "user", text: "z".repeat(5000) }]);
  assert.equal(out.length, C.MAX_HISTORY);
  assert.equal(out.at(-1).text.length, 4000);
  assert.equal(out.every((m) => m.role === "user" || m.role === "assistant"), true);
});

test("normalizeChoices de-duplicates, drops long or empty ones and caps the list", () => {
  const out = C.normalizeChoices(["Yes", " Yes ", "", "x".repeat(61), 4, "a", "b", "c", "d", "e"]);
  assert.deepEqual(plain(out), ["Yes", "a", "b", "c", "d"]);
  assert.deepEqual(plain(C.normalizeChoices(undefined)), []);
});

test("starterChoices adds a page prompt only when a page is shared", () => {
  assert.equal(C.starterChoices("chat").includes("Autofill this page"), false);
  assert.equal(C.starterChoices("chat", { hasPage: true, tracked: true })[0], "Autofill this page");
  assert.equal(C.starterChoices("chat", { hasPage: true })[0], "Is this page one of my applications?");
  assert.ok(C.starterChoices("chat", { hasPage: true }).length <= 5);
});

test("groupByStatus follows the funnel order and omits empty statuses", () => {
  const groups = C.groupByStatus([{ status: "offer" }, { status: "queued" }, { status: "queued" }, { status: "mystery" }]);
  assert.deepEqual(plain(groups.map((g) => [g.status, g.count])), [["queued", 2], ["offer", 1], ["mystery", 1]]);
  assert.equal(groups[0].label, "Queued");
});

test("autofill is offered only before an application has been made", () => {
  assert.deepEqual(["saved", "queued", "submitted", "ready_for_review"].map(C.canAutofill), [true, true, false, false]);
});

test("profileLines summarises what the assistant knows", () => {
  const lines = plain(C.profileLines({ full_name: "Asha", skills: ["Go", "SQL"], answers: [1, 2], resume_url: null, preferences: { notice_period_days: 30 } }));
  assert.deepEqual(lines, [["Name", "Asha"], ["Skills", "Go, SQL"], ["Notice period", "30 days"], ["Saved answers", "2"], ["Resume", "Not uploaded"]]);
  assert.deepEqual(plain(C.profileLines(null)), []);
});
