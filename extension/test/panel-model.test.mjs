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
  // A missing profile is a setup step, not a deleted application.
  const setup = P.friendlyError("Profile not created yet", 404, undefined, "profile_missing");
  assert.equal(setup.action, "profile");
  assert.equal(setup.title, "Finish setting up your profile");
  assert.match(P.friendlyError("Not found", 404).title, /no longer exists/);
});

test("sourceLabel", () => {
  assert.equal(P.sourceLabel("answer_bank"), "From answer bank");
  assert.equal(P.sourceLabel("generated"), "AI draft");
  assert.equal(P.sourceLabel("weird"), "weird");
});

test("assistantFields sends answerable questions with page values and maps keys back", () => {
  const results = [
    { field: { kind: "text", label: "Notice period", required: true }, status: "unresolved" },
    { field: { kind: "checkbox", label: "I agree" }, status: "unresolved" },
    { field: { kind: "radio", label: "Relocate?", options: [{ text: "Yes" }, { text: "No" }] }, status: "filled", value: "No" },
    { field: { kind: "picker", label: "CV" }, status: "unresolved" },
  ];
  const { fields, current, rows } = P.assistantFields(results);
  assert.deepEqual(plain(fields), [
    { key: "f0", label: "Notice period", kind: "text", options: [], required: true },
    { key: "f2", label: "Relocate?", kind: "radio", options: ["Yes", "No"], required: false },
  ]);
  assert.deepEqual(plain(current), { f0: "", f2: "No" });
  assert.equal(rows.f2, results[2]);
});

test("assistantGreeting asks the first open question with its options as quick replies", () => {
  const g = P.assistantGreeting([
    { field: { kind: "select", label: "Work authorisation:", required: true, options: [{ text: "Citizen" }, { text: "Visa" }] }, status: "unresolved" },
    { field: { kind: "text", label: "Why us" }, status: "unresolved" },
  ]);
  assert.equal(g.text, "2 questions need your answer. Let's go one at a time. Work authorisation (required)?");
  assert.deepEqual(plain(g.choices), ["Citizen", "Visa"]);
  assert.match(P.assistantGreeting([]).text, /Want to change anything/);
  const consent = [{ field: { kind: "checkbox", label: "I agree to the terms" }, status: "unresolved" }];
  assert.equal(P.assistantFirst(consent), true);
  assert.deepEqual(plain(P.assistantGreeting(consent).choices), [P.AGREE_REPLY, P.SHOW_REPLY]);
  assert.equal(P.promptTarget(consent), consent[0]);
  assert.equal(P.nextPrompt([{ field: { kind: "text" }, status: "filled" }]), null);
});

test("chatHistory drops the greeting and errors", () => {
  const lines = [{ role: "assistant", text: "Hi", greeting: true }, { role: "user", text: " yes " }, { role: "assistant", text: "oops", error: true }];
  assert.deepEqual(plain(P.chatHistory(lines)), [{ role: "user", text: "yes" }]);
});

test("autoApplyBlockers: submits only a complete, not-yet-sent application", () => {
  const complete = [row("text", "filled", { source: "profile" }), row("text", "optional"), row("checkbox", "done", { manual: true })];
  assert.deepEqual(plain(P.autoApplyBlockers(complete, { status: "ready_for_review" })), []);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, null)), [], "untracked pages can auto apply");
  assert.deepEqual(plain(P.autoApplyBlockers([...complete, row("checkbox", "unresolved"), row("text", "unresolved")], null)), [
    "2 required fields still need you",
  ]);
  assert.deepEqual(plain(P.autoApplyBlockers([], null)), ["No form fields found on this page"]);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, { status: "submission_unconfirmed" })), [
    "A previous attempt needs verification in ApplyShortly first",
  ]);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, { status: "submitted" })), ["This application is already submitted"]);
});
