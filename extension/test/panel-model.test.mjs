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

test("the chat carries on through the form only where filling in place can't finish it", () => {
  assert.equal(P.navigationNeeded({ total: 5, hasSubmit: true }), null); // a one-page form
  assert.equal(P.navigationNeeded({ total: 5, hasSubmit: true, hasNext: true }), null); // Submit on screen: last step
  assert.equal(P.navigationNeeded({ total: 5 }), null); // no Submit found, but nothing says there's more
  assert.equal(P.navigationNeeded({ total: 0 }), "none");
  assert.equal(P.navigationNeeded({ total: 4, hasNext: true }), "steps");
  assert.equal(P.navigationNeeded({ total: 0, bigFrame: true }), "frame");
  assert.equal(P.navigationNeeded({ total: 8, hasSubmit: true, bigFrame: true }), null); // its own form and a video

  assert.match(P.handoffText("steps"), /more than one step.*ask here when I need you.*debugging.*one apply run/);
  assert.match(P.handoffText("none", { autoSubmit: true }), /can't see a form.*every required answer is complete.*cancellable countdown/);

  for (const ask of ["go to the next page", "Next step", "do the rest", "fill the rest of the form", "continue the form", "click next"]) {
    assert.equal(P.isNavigateRequest(ask), true, ask);
  }
  for (const answer of ["continue", "Next month", "I can join next week", "the rest is fine"]) assert.equal(P.isNavigateRequest(answer), false, answer);
});

test("the agent's questions become chat lines with quick replies", () => {
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: "Notice period?", choices: ["30 days", "60 days"] })),
    { text: "", question: { label: "Notice period?" }, choices: ["30 days", "60 days", P.ON_PAGE_REPLY], draftable: false });
  const open = P.agentAsk({ kind: "question", text: "Why do you want to work at Actowiz?" });
  assert.equal(open.question.note, "Type your answer, or I can draft one.");
  assert.deepEqual(plain(open.choices), [P.DRAFT_REPLY, P.ON_PAGE_REPLY]);
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: "Years of experience?" }).choices), [P.ON_PAGE_REPLY]);
  assert.deepEqual(plain(P.agentAsk({ kind: "blocker", text: "Solve the CAPTCHA on the page." })),
    { text: "Solve the CAPTCHA on the page. Tap Continue when it's done.", choices: [P.CONTINUE_REPLY] });
  assert.equal(P.agentAsk(null), null);
});

test("a long option list shows the likely answer first and says it can be typed", () => {
  const codes = ["+93", "+355", "+213", "+1-684", "+376", "+244", "+1-264", "+672", "+91", "+44"];
  const results = [{ field: { kind: "dropdown", label: "Mobile phone country code", required: true, options: codes.map((text) => ({ text })) }, status: "unresolved", suggestion: "+91" }];
  const prompt = P.nextPrompt(results);
  assert.equal(prompt.choices[0], "+91");
  assert.equal(prompt.choices.length, 8);
  assert.equal(prompt.question.note, "Pick one, or type yours.");
});

test("assistantGreeting asks the first open question with its options as quick replies", () => {
  const g = P.assistantGreeting([
    { field: { kind: "select", label: "Work authorisation:", required: true, options: [{ text: "Citizen" }, { text: "Visa" }] }, status: "unresolved" },
    { field: { kind: "text", label: "Why us" }, status: "unresolved" },
  ]);
  assert.equal(g.text, "2 questions need your answer before you can submit.");
  assert.deepEqual(plain(g.question), { label: "Work authorisation?", step: "Required" });
  assert.deepEqual(plain(g.choices), ["Citizen", "Visa"]);
  assert.match(P.assistantGreeting([]).text, /Want to change anything/);
  const consent = [{ field: { kind: "checkbox", label: "I agree to the terms" }, status: "unresolved" }];
  assert.deepEqual(plain(P.assistantGreeting(consent).choices), [P.AGREE_REPLY, P.SHOW_REPLY]);
  assert.equal(P.promptTarget(consent), consent[0]);
  assert.equal(P.nextPrompt([{ field: { kind: "text" }, status: "filled" }]), null);
});

test("directAnswer takes an option or free text for the asked question, never a local reply", () => {
  const radio = { field: { kind: "radio", options: [{ text: "Yes" }, { text: "No" }] }, status: "unresolved" };
  const text = { field: { kind: "text" }, status: "optional" };
  assert.equal(P.directAnswer(radio, "yes"), "Yes");
  assert.equal(P.directAnswer(radio, "I can relocate"), null); // not an option: the assistant decides
  assert.equal(P.directAnswer(text, "Pune"), "Pune");
  assert.equal(P.directAnswer(text, "Change name to Ada and salary to 2200000"), null);
  assert.equal(P.directAnswer(text, "Use my full name, not just my surname"), null);
  assert.equal(P.directAnswer(text, P.SKIP_REPLY), null);
  assert.equal(P.directAnswer({ ...text, status: "filled" }, "Pune"), null);
  assert.equal(P.directAnswer({ field: { kind: "checkbox" }, status: "unresolved" }, "Yes"), null); // consent stays a tap
  assert.equal(P.directAnswer(null, "Pune"), null);
  const open = [radio];
  assert.equal(P.nextPrompt(open).target, radio);
});

test("chatHistory drops the greeting and errors", () => {
  const lines = [{ role: "assistant", text: "Hi", greeting: true }, { role: "user", text: " yes " }, { role: "assistant", text: "oops", error: true }];
  assert.deepEqual(plain(P.chatHistory(lines)), [{ role: "user", text: "yes" }]);
  // A question shown as a card still reaches the AI, so it knows what was asked.
  const asked = [{ role: "assistant", text: "", question: { label: "Notice period?" } }, { role: "user", text: "60 days" }];
  assert.deepEqual(plain(P.chatHistory(asked)), [{ role: "assistant", text: "Notice period?" }, { role: "user", text: "60 days" }]);
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

test("an unresolved custom dropdown with options read from the page offers them as choices", () => {
  // content.js readChoices fills field.options as [{ text }] for custom dropdowns.
  const dropdown = { kind: "dropdown", custom: true, label: "Gender", required: true, options: [{ text: "Male" }, { text: "Female" }] };
  const results = [{ field: dropdown, status: "unresolved" }];
  assert.deepEqual(plain(P.assistantGreeting(results).choices), ["Male", "Female"]);
  const { fields, current } = P.assistantFields(results);
  assert.deepEqual(plain(fields), [{ key: "f0", label: "Gender", kind: "dropdown", options: ["Male", "Female"], required: true }]);
  assert.deepEqual(plain(current), { f0: "" });

  const optional = [{ field: { ...dropdown, required: false }, status: "optional", optional: true }];
  assert.deepEqual(plain(P.nextPrompt(optional).choices), ["Male", "Female", P.SKIP_REPLY]);
  // Without readable options there's nothing to offer.
  assert.deepEqual(plain(P.assistantGreeting([{ field: { ...dropdown, options: [] }, status: "unresolved" }]).choices), []);
});

test("optional personal facts are not offered as an AI draft", () => {
  const optional = (label, el = {}) => [{ field: { kind: "text", label, el }, status: "optional", optional: true }];
  for (const [label, el] of [["Middle Name", {}], ["Date of birth", {}], ["PAN number", {}], ["Phone", { type: "tel" }], ["Contact", { type: "email" }], ["Portfolio", { type: "url" }]]) {
    const prompt = P.nextPrompt(optional(label, el));
    assert.deepEqual(plain(prompt.choices), [P.SKIP_REPLY], label);
    assert.match(prompt.text, /is optional: tell me what to put, or leave it blank\.$/, label);
    assert.equal(P.draftable(optional(label, el)[0].field), false, label);
  }
});

test("optional open questions still offer a draft", () => {
  for (const label of ["Why do you want to join us?", "Tell us about a project you're proud of", "Why are you a good candidate?", "Personal statement", "Describe your capacity to lead"]) {
    const field = { kind: "text", label, el: { type: "textarea" } };
    assert.equal(P.draftable(field), true, label);
    assert.deepEqual(plain(P.nextPrompt([{ field, status: "optional", optional: true }]).choices), [P.DRAFT_REPLY, P.SKIP_REPLY], label);
  }
  assert.equal(P.draftable({ kind: "select", label: "Why do you want to join us?" }), false);
  assert.equal(P.draftable(null), false);
});

test("a required open question offers a draft before the user types", () => {
  const field = { kind: "text", label: "Why do you think you are suitable for this position? Brief in less than 100 words", required: true, el: { tagName: "TEXTAREA" } };
  const prompt = P.nextPrompt([{ field, status: "unresolved" }]);
  assert.deepEqual(plain(prompt.choices), [P.DRAFT_REPLY]);
  assert.equal(prompt.question.note, "Type your answer, or I can draft one.");
  // Personal facts and choice questions get no draft button.
  assert.deepEqual(plain(P.nextPrompt([{ field: { kind: "text", label: "Years of work experience (in years)", required: true }, status: "unresolved" }]).choices), []);
  assert.equal(P.nextPrompt([{ field: { kind: "text", label: "Notice period", required: true }, status: "unresolved" }]).question.note, undefined);
  for (const label of ["How many years have you worked with Python?", "How soon can you join, if selected? Answer in number of weeks."]) {
    assert.equal(P.draftable({ kind: "text", label }), false, label);
  }
});

test("a typed draft request is never written into the form as the answer", () => {
  for (const m of ["draft it for me", "Draft it for me", "please draft one", "write it for me", "Draft", "can you draft an answer?"]) {
    assert.equal(P.isDraftRequest(m), true, m);
    assert.equal(P.directAnswer({ field: { kind: "text" }, status: "unresolved" }, m), null, m);
  }
  for (const m of ["I draft legal documents for a living", "Drafting tools and CAD", "write code daily"]) assert.equal(P.isDraftRequest(m), false, m);
});

test('a sign-in page is recognised by its password box or its path', () => {
  assert.equal(P.loginWall('/careers/apply', true), true);
  assert.equal(P.loginWall('/en-US/login', false), true);
  assert.equal(P.loginWall('/auth/callback', false), true);
  assert.equal(P.loginWall('/careers/apply', false), false);
  assert.equal(P.loginWall('/blogin-tips', false), false);
});
