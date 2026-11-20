import test from "node:test";
import assert from "node:assert/strict";
import { ruleAgent } from "../src/rule-based/rule-agent.js";

const PROFILE = {
  full_name: "Alex Testperson",
  email: "alex.testperson@example.test",
  phone: "+1 555 010 0199",
  location: "Austin, Texas, United States",
  total_experience_years: 6,
  links: [{ label: "LinkedIn", url: "https://www.linkedin.example.test/in/alex-testperson" }],
  experience: [{ company: "Example Test Co", title: "Backend Engineer", is_current: true }],
  education: [{ school: "Example Test University", degree: "BSc Computer Science", end_year: 2019 }],
  preferences: { expected_ctc: 120000, currency: "USD", willing_to_relocate: false, auto_consent: false },
  resume_url: "/api/extension/resume",
};

const obs = (elements, extra = {}) => ({
  observation: { url: "https://example.test/apply", observation_id: "obs-1", elements, blockers: [], ...extra },
  results: [],
});

test("ruleAgent fills profile fields one per step and disambiguates Company/School name from candidate name", async () => {
  const step = ruleAgent(PROFILE, null);
  const fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "textbox", name: "Company name", required: true, value: "" },
    { ref: "0.3", role: "textbox", name: "School name", required: true, value: "" },
    { ref: "0.4", role: "textbox", name: "Email", required: true, value: "" },
  ];
  const written = [];
  for (let i = 0; i < 4; i++) {
    const res = await step(obs(fields));
    assert.equal(res.status, "continue");
    assert.equal(res.agent_engine, "rules_led");
    assert.equal(res.actions.length, 1);
    const act = res.actions[0];
    written.push([act.ref, act.text]);
    fields.find((f) => f.ref === act.ref).value = act.text;
  }
  assert.deepEqual(written, [
    ["0.1", "Alex Testperson"],
    ["0.2", "Example Test Co"],
    ["0.3", "Example Test University"],
    ["0.4", "alex.testperson@example.test"],
  ]);
});

test("ruleAgent never overwrites user_edited fields, never ticks consent/certify, and stops at ready_for_review", async () => {
  const step = ruleAgent(PROFILE, null);
  const first = await step(obs([
    { ref: "0.1", role: "textbox", name: "Expected salary (USD)", required: true, value: "99000", user_edited: true },
    { ref: "0.2", role: "checkbox", name: "I agree to the privacy policy", required: true, checked: false },
  ]));
  // Should ask about the consent checkbox, never auto-tick it, and never touch the user-edited salary.
  assert.equal(first.status, "ask_user");
  assert.equal(first.question.ref, "0.2");

  const second = await step({
    ...obs([
      { ref: "0.1", role: "textbox", name: "Expected salary (USD)", required: true, value: "99000", user_edited: true },
      { ref: "0.2", role: "checkbox", name: "I agree to the privacy policy", required: true, checked: false },
    ]),
    skip_question: true,
  });
  assert.equal(second.status, "ready_for_review");
});

test("ruleAgent stops as blocked on login walls and standalone CAPTCHAs", async () => {
  const step = ruleAgent(PROFILE, null);
  const login = await step(obs([{ ref: "0.1", role: "textbox", name: "Email", value: "" }], { blockers: ["login"] }));
  assert.equal(login.status, "ask_user");
  assert.equal(login.question.kind, "blocker");
  assert.match(login.question.text, /sign in/i);

  const captcha = await step(obs([], { blockers: ["captcha"] }));
  assert.equal(captcha.status, "ask_user");
  assert.equal(captcha.question.kind, "blocker");
  assert.match(captcha.question.text, /captcha/i);
});

test("ruleAgent asks unknown required fields, writes user reply, and advances Next without clicking Submit", async () => {
  const step = ruleAgent(PROFILE, null);
  const ask = await step(obs([
    { ref: "0.1", role: "textbox", name: "Favorite database?", required: true, value: "" },
    { ref: "0.2", role: "button", name: "Next" },
  ]));
  assert.equal(ask.status, "ask_user");
  assert.equal(ask.question.ref, "0.1");

  const write = await step({
    ...obs([
      { ref: "0.1", role: "textbox", name: "Favorite database?", required: true, value: "" },
      { ref: "0.2", role: "button", name: "Next" },
    ]),
    user_reply: "PostgreSQL",
  });
  assert.equal(write.status, "continue");
  assert.equal(write.actions[0].type, "type");
  assert.equal(write.actions[0].text, "PostgreSQL");

  const nav = await step(obs([
    { ref: "0.1", role: "textbox", name: "Favorite database?", required: true, value: "PostgreSQL" },
    { ref: "0.2", role: "button", name: "Next" },
  ]));
  assert.equal(nav.status, "continue");
  assert.equal(nav.actions[0].type, "click");
  assert.equal(nav.actions[0].ref, "0.2");

  // On final step (Step 2 of 2), Next is treated as final submit by guards and must NOT be clicked.
  const end = await step(obs([
    { ref: "0.3", role: "button", name: "Next" },
  ], { url: "https://example.test/apply#step2", text: "Step 2 of 2" }));
  assert.equal(end.status, "ready_for_review");
});

test("ruleAgent waits briefly for async-rendered forms before settling", async () => {
  const step = ruleAgent(PROFILE, null);
  for (let i = 0; i < 3; i++) {
    const w = await step(obs([]));
    assert.equal(w.status, "continue");
    assert.equal(w.actions[0].type, "wait");
  }
  const done = await step(obs([]));
  assert.equal(done.status, "ready_for_review");
});
