// Added 2026-11-18. The hard limits of the Agent based form assistant agent, enforced in code whatever the model decides (no model is involved here):
// never submit, never touch a human check, consent and legal facts only from the profile or the user, no overwrite, optional fields
// left alone when the user turned that off, and the list of required fields still empty that `done` is checked against.
import assert from "node:assert/strict";
import test from "node:test";
import { createGuards, newGuardState } from "../src/agent-based/agent-guards.js";

const el = (ref, role, name, more = {}) => ({ ref, role, name, value: "", required: true, ...more });
const page = (elements, more = {}) => ({ url: "https://jobs.example/apply", observation_id: "o1", text: "", elements, tabs: [], blockers: [], ...more });
const setup = (profile = {}, options = {}) => {
  const guards = createGuards({ profile, job: { title: "Engineer", location: "Berlin" }, allowDrafts: () => options.allowDrafts ?? true, fillOptional: () => options.fillOptional !== false });
  return { guards, state: newGuardState() };
};
const vet = ({ guards, state }, observation, action) => guards.vet(action, observation, state);

test("a text write to a text box passes and becomes a loop action", () => {
  const ctx = setup();
  const result = vet(ctx, page([el("e1", "textbox", "First name")]), { type: "type", ref: "e1", text: "Asha" });
  assert.equal(result.ok, true);
  assert.deepEqual([result.action.type, result.action.ref, result.action.text], ["type", "e1", "Asha"]);
  assert.match(result.action.label, /Filled First name/);
});

test("a ref that is not on the page, a disabled field and a password are refused with a reason", () => {
  const ctx = setup();
  const obs = page([el("e1", "textbox", "Code", { disabled: true }), el("e2", "textbox", "Password", { input_type: "password" })]);
  assert.match(vet(ctx, obs, { type: "type", ref: "e9", text: "x" }).error, /no longer on the page|not on the page/i);
  assert.match(vet(ctx, obs, { type: "type", ref: "e1", text: "x" }).error, /cannot be changed/i);
  assert.match(vet(ctx, obs, { type: "type", ref: "e2", text: "x" }).error, /cannot be changed/i);
});

test("typing into a button or a dropdown explains which tool fits", () => {
  const ctx = setup();
  const obs = page([el("e1", "button", "Add"), el("e2", "select", "Country", { options: ["India", "Germany"] })]);
  assert.match(vet(ctx, obs, { type: "type", ref: "e1", text: "x" }).error, /not a text field/i);
  assert.match(vet(ctx, obs, { type: "type", ref: "e2", text: "India" }).error, /not a text field.*select/i);
  assert.equal(vet(ctx, obs, { type: "select", ref: "e2", text: "India" }).ok, true);
});

test("a final submit, sign-in or payment click is refused; an apply or next click passes", () => {
  const ctx = setup();
  const obs = page([el("e1", "button", "Submit application", { submit_like: true }), el("e2", "button", "Log in"), el("e3", "button", "Next"), el("e4", "textbox", "Name"), el("e5", "textbox", "Email"), el("e6", "textbox", "Phone")]);
  assert.match(vet(ctx, obs, { type: "click", ref: "e1" }).error, /direct approval/i);
  assert.match(vet(ctx, obs, { type: "click", ref: "e2" }).error, /direct approval/i);
  assert.equal(vet(ctx, obs, { type: "click", ref: "e3" }).ok, true);
});

test("a forward button on the last step counts as the final submit", () => {
  const ctx = setup();
  const obs = page([el("e1", "button", "Continue")], { text: "Step 3 of 3 Review your answers" });
  assert.match(vet(ctx, page(obs.elements, { text: obs.text }), { type: "click", ref: "e1" }).error, /final submit|direct approval/i);
});

test("a human check (I am not a robot) is never touched", () => {
  const ctx = setup();
  const obs = page([el("e1", "checkbox", "I'm not a robot", { checked: false })]);
  assert.match(vet(ctx, obs, { type: "check", ref: "e1", checked: true }).error, /human check/i);
});

test("a consent or eligibility choice needs the profile or the user: refused with an instruction to ask", () => {
  const ctx = setup({ preferences: {} });
  const obs = page([el("e1", "checkbox", "I certify that the information above is true", { checked: false })]);
  assert.match(vet(ctx, obs, { type: "check", ref: "e1", checked: true }).error, /consent|approval|ask/i);
});

test("a privacy checkbox is ticked only with the user's standing consent setting", () => {
  const obs = page([el("e1", "checkbox", "I accept the privacy policy", { checked: false })]);
  assert.match(vet(setup({ preferences: {} }), obs, { type: "check", ref: "e1", checked: true }).error ?? "", /consent|approval/i);
  assert.equal(vet(setup({ preferences: { auto_consent: true } }), obs, { type: "check", ref: "e1", checked: true }).ok, true);
});

test("accepting a policy that is not a privacy or terms notice needs the user, even with standing consent", () => {
  const obs = page([el("e1", "checkbox", "I accept the company attendance policy", { checked: false })]);
  assert.match(vet(setup({ preferences: { auto_consent: true } }), obs, { type: "check", ref: "e1", checked: true }).error ?? "", /consent|approval|ask/i);
});

test("the user's own answer authorises the matching choice", () => {
  const ctx = setup({ preferences: {} });
  const obs = page([
    el("e1", "radio", "Yes", { group: "Do you require visa sponsorship?", checked: false }),
    el("e2", "radio", "No", { group: "Do you require visa sponsorship?", checked: false }),
  ]);
  assert.match(vet(ctx, obs, { type: "check", ref: "e2", checked: true }).error ?? "", /decision|approval|ask/i);
  ctx.guards.recordAnswer(ctx.state, obs, "e2", "No");
  assert.equal(vet(ctx, obs, { type: "check", ref: "e2", checked: true }).ok, true);
});

test("a filled field is not overwritten, except by the agent's own earlier write", () => {
  const ctx = setup();
  const filled = page([el("e1", "textbox", "Name", { value: "Asha" })]);
  assert.match(vet(ctx, filled, { type: "type", ref: "e1", text: "Someone Else" }).error, /overwrite/i);
  assert.equal(vet(ctx, page([el("e1", "textbox", "Name", { value: "" })]), { type: "type", ref: "e1", text: "Asha" }).ok, true);
  ctx.guards.noteWrite(ctx.state, filled, "e1");
  assert.equal(vet(ctx, filled, { type: "type", ref: "e1", text: "Asha K" }).ok, true);
});

test("a dropdown with a form default can be changed unless the user edited it", () => {
  const ctx = setup();
  const defaults = page([
    el("c1", "combobox", "Currency", { value: "US Dollar", options: ["US Dollar", "INRIndian Rupee"], expanded: false, user_edited: false }),
    el("f1", "select", "Frequency", { value: "Monthly", options: ["Monthly", "Annually"], user_edited: false }),
    el("c2", "combobox", "Currency", { value: "US Dollar", options: ["US Dollar", "INRIndian Rupee"], expanded: false, user_edited: true }),
  ]);
  assert.equal(vet(ctx, defaults, { type: "select", ref: "c1", text: "INRIndian Rupee" }).ok, true);
  assert.equal(vet(ctx, defaults, { type: "select", ref: "f1", text: "Annually" }).ok, true);
  assert.match(vet(ctx, defaults, { type: "select", ref: "c2", text: "INRIndian Rupee" }).error, /overwrite/i);
});

// Changed 2026-11-18: the guards no longer fix the model's choices (no label-echo or number-box rules, no rewriting a write into
// another tool). What the model wrote goes to the page as written; the read-back tells it whether the page kept it.
test("the model's write goes out as written: no number extraction, no tool rewriting", () => {
  const ctx = setup();
  const obs = page([el("e1", "textbox", "Years of experience", { input_type: "number" })]);
  assert.equal(vet(ctx, obs, { type: "type", ref: "e1", text: "6 years" }).action.text, "6 years");
});

test("a Yes/No option or a checkbox is answered with check: type, select or click there is refused with that hint, never rewritten", () => {
  const ctx = setup();
  const obs = page([
    el("y", "button", "Yes", { group: "Are you comfortable working in a hybrid setup?", pressed: false }),
    el("n", "button", "No", { group: "Are you comfortable working in a hybrid setup?", pressed: false }),
    el("c", "checkbox", "Subscribe to job alerts", { checked: false, required: false }),
  ]);
  assert.match(vet(ctx, obs, { type: "type", ref: "y", text: "Yes" }).error, /check/i);
  assert.match(vet(ctx, obs, { type: "select", ref: "y", text: "Yes" }).error, /check/i);
  assert.match(vet(ctx, obs, { type: "click", ref: "n" }).error, /use check/i);
  assert.match(vet(ctx, obs, { type: "type", ref: "c", text: "yes" }).error, /check/i);
  assert.equal(vet(ctx, obs, { type: "check", ref: "n", checked: true }).action.type, "check");
});

test("any click that is not a final submit, sign-in or payment passes: add another, open a dropdown, pick an option, confirm location", () => {
  const ctx = setup();
  const obs = page([
    el("a", "button", "Add another"), el("d", "combobox", "City"), el("o", "option", "Berlin", { group: "City" }), el("orphan", "option", "Paris"),
    el("t", "textbox", "Name"), el("u", "textbox", "Email"), el("v", "textbox", "Phone"), el("c", "button", "Confirm location"), el("p", "button", "Pay now"),
  ]);
  for (const ref of ["a", "d", "o", "c"]) assert.equal(vet(ctx, obs, { type: "click", ref }).ok, true, ref);
  assert.match(vet(ctx, obs, { type: "click", ref: "orphan" }).error, /picker/i);
  assert.match(vet(ctx, obs, { type: "click", ref: "p" }).error, /direct approval/i);
});

test("optional fields are not hard-blocked in code when fillOptional is off (controlled via prompt)", () => {
  const ctx = setup({}, { fillOptional: false });
  const obs = page([el("e1", "textbox", "Website", { required: false })]);
  assert.equal(vet(ctx, obs, { type: "type", ref: "e1", text: "https://x.test" }).ok, true);
});

test("upload checks file availability without English filename regexes", () => {
  const withResume = setup({ resume_url: "https://files.example/resume.pdf" });
  const obs = page([el("f1", "file", "Lebenslauf hochladen")]);
  assert.equal(vet(withResume, obs, { type: "upload", ref: "f1", file: "resume" }).ok, true);
  assert.equal(vet(withResume, obs, { type: "upload", ref: "f1", file: "cover_letter" }).ask?.kind, "click");
});

test("textarea writes are not hard-blocked by DOM role when Auto-draft open-ended answers is off (model decides what is open-ended vs a profile fact)", () => {
  const ctx = setup({}, { allowDrafts: false });
  const obs = page([el("e1", "textarea", "Github profile"), el("e2", "textarea", "Cover letter")]);
  assert.equal(vet(ctx, obs, { type: "type", ref: "e1", text: "https://github.com/example" }).ok, true);
  assert.equal(vet(ctx, obs, { type: "type", ref: "e2", text: "Dear team, I build things." }).ok, true);
});

test("a field the user said they will fill themselves is refused", () => {
  const ctx = setup();
  const obs = page([el("e1", "textbox", "Cover note")]);
  ctx.guards.skip(ctx.state, obs, "e1");
  assert.match(vet(ctx, obs, { type: "type", ref: "e1", text: "x" }).error, /themselves|on the page/i);
});

// Changed 2026-11-18: a page that re-renders gives the field a new ref; the user's "I'll do this one" must still stick (by the question).
test("a skip holds after the page gives the field a new ref", () => {
  const ctx = setup();
  const before = page([el("e1", "textarea", "Describe your project")]);
  const after = page([el("e7", "textarea", "Describe your project")]);
  ctx.guards.skip(ctx.state, after, "e1", "Describe your project");
  assert.match(vet(ctx, after, { type: "type", ref: "e7", text: "x" }).error, /themselves|on the page/i);
  assert.equal(before.elements.length, 1);
});

test("keys: only safe keys; run_js needs code; wait is capped", () => {
  const ctx = setup();
  const obs = page([el("e1", "combobox", "City")]);
  assert.equal(vet(ctx, obs, { type: "press", ref: "e1", key: "ArrowDown" }).ok, true);
  assert.match(vet(ctx, obs, { type: "press", ref: "e1", key: "F12" }).error, /key is not allowed/i);
  assert.match(vet(ctx, obs, { type: "run_js", code: "  " }).error, /code/i);
  assert.equal(vet(ctx, obs, { type: "run_js", code: "document.title" }).ok, true);
  for (let i = 0; i < 6; i++) assert.equal(vet(ctx, obs, { type: "wait", ms: 500 }).ok, true);
  assert.equal(vet(ctx, obs, { type: "wait", ms: 500 }).ask?.kind, "blocker");
});

test("required fields still empty: skipped, human-check and optional ones are not counted", () => {
  const ctx = setup();
  const obs = page([
    el("e1", "textbox", "Name"), el("e2", "textbox", "Phone"), el("e3", "textbox", "Website", { required: false }),
    el("e4", "checkbox", "I am not a robot", { checked: false }), el("e5", "textbox", "Note"),
  ]);
  ctx.guards.skip(ctx.state, obs, "e5");
  assert.deepEqual(ctx.guards.missingRequired(obs, ctx.state).map((m) => m.name), ["Name", "Phone"]);
});

test("a review step is named in plain words, not by their tool", () => {
  const ctx = setup();
  const obs = page([el("e1", "textbox", "First name")]);
  assert.equal(vet(ctx, obs, { type: "review" }).action.label, "Reviewing the form");
});
