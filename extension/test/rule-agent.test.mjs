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

test("ruleAgent matches notice period and fractional years of experience against dropdown options", async () => {
  const profile = {
    ...PROFILE,
    total_experience_years: 5.6,
    preferences: { ...PROFILE.preferences, notice_period_days: 30 },
  };
  const step = ruleAgent(profile, null);
  const exp = await step(obs([
    { ref: "0.1", role: "combobox", name: "How many years of experience do you have?", required: true, value: "", options: ["No experience", "1+ year", "5+ year", "6+ year", "15+ year"] },
    { ref: "0.2", role: "combobox", name: "What is your notice period?", required: true, value: "", options: ["Immediately", "10 days", "30 days", "60 days"] },
  ]));
  assert.equal(exp.status, "continue");
  assert.deepEqual([exp.actions[0].type, exp.actions[0].ref, exp.actions[0].text], ["select", "0.1", "5+ year"]);

  const notice = await step(obs([
    { ref: "0.1", role: "combobox", name: "How many years of experience do you have?", required: true, value: "5+ year", options: ["No experience", "1+ year", "5+ year", "6+ year", "15+ year"] },
    { ref: "0.2", role: "combobox", name: "What is your notice period?", required: true, value: "", options: ["Immediately", "10 days", "30 days", "60 days"] },
  ]));
  assert.equal(notice.status, "continue");
  assert.deepEqual([notice.actions[0].type, notice.actions[0].ref, notice.actions[0].text], ["select", "0.2", "30 days"]);
});

test("ruleAgent summarizes the actual fields filled and reuses matching saved answers", async () => {
  const profile = {
    ...PROFILE,
    answers: [
      {
        question_pattern: "Tell us about a problem you solved building close to the customer",
        answer: "Built a clinical RAG pipeline directly with healthcare stakeholders.",
        tags: ["customer", "problem"],
      },
    ],
  };
  const step = ruleAgent(profile, null);
  const fields = [
    { ref: "0.1", role: "textbox", name: "Name*", required: true, value: "" },
    { ref: "0.2", role: "textbox", name: "Email*", required: true, value: "" },
    { ref: "0.3", role: "file", name: "Resume*", required: true, value: "" },
    { ref: "0.4", role: "textarea", name: "Tell us about a problem you've solved by building close to the customer", required: true, value: "" },
    { ref: "0.5", role: "textbox", name: "Favorite database?", required: true, value: "" },
  ];

  // Fill 4 known fields (3 profile/upload + 1 saved answer), silent while filling.
  for (let i = 0; i < 4; i++) {
    const res = await step(obs(fields));
    assert.equal(res.status, "continue");
    assert.equal(res.message, "");
    const act = res.actions[0];
    const target = fields.find((f) => f.ref === act.ref);
    target.value = act.type === "upload" ? "resume.pdf" : act.text;
  }
  assert.equal(fields[3].value, "Built a clinical RAG pipeline directly with healthcare stakeholders.");

  // Next step asks the unknown field and emits a single summary of the actual filled fields.
  const ask = await step(obs(fields));
  assert.equal(ask.status, "ask_user");
  assert.equal(ask.question.ref, "0.5");
  assert.equal(
    ask.message,
    "Filled Name, Email, and Tell us about a problem you've solved by building close to the customer, and attached your resume.",
  );

  // User answers the unknown field; once verified, filled includes source: "user" for learning.
  const applyReply = await step({ ...obs(fields), user_reply: "PostgreSQL" });
  assert.equal(applyReply.status, "continue");
  fields[4].value = "PostgreSQL";
  const done = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(done.status, "ready_for_review");
  const userEntry = done.filled.find((f) => f.label === "Favorite database?");
  assert.deepEqual(userEntry, {
    label: "Favorite database?",
    value: "PostgreSQL",
    kind: "text",
    source: "user",
    needs_review: false,
  });
});

test("ruleAgent matches question_variants, falls back to lookupSaved, and propagates answer_id", async () => {
  const profile = {
    full_name: "Guna P",
    answers: [
      {
        id: 42,
        question_pattern: "Describe a technical challenge",
        question_variants: ["Tell us about a tough engineering problem you solved"],
        answer: "Scaled vector search latency down by 60%.",
        tags: [],
      },
    ],
    answers_total: 2,
  };
  const lookups = [];
  const step = ruleAgent(profile, {}, {
    lookupSaved: async (question) => {
      lookups.push(question);
      if (/deployment/i.test(question)) return { answer: "Kubernetes + ArgoCD", answer_id: 99 };
      return null;
    },
  });
  const fields = [
    { ref: "0.1", role: "textarea", name: "Tell us about a tough engineering problem you solved*", value: "", required: true },
    { ref: "0.2", role: "textbox", name: "Preferred deployment stack?", value: "", required: true },
  ];
  const r1 = await step(obs(fields));
  assert.equal(r1.status, "continue");
  assert.equal(r1.actions[0].text, "Scaled vector search latency down by 60%.");
  fields[0].value = r1.actions[0].text;

  const r2 = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(r2.status, "continue");
  assert.equal(r2.actions[0].text, "Kubernetes + ArgoCD");
  fields[1].value = r2.actions[0].text;

  const done = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(done.status, "ready_for_review");
  assert.equal(lookups.length, 1);
  assert.equal(done.filled.find((f) => f.answer_id === 42)?.source, "answer_bank");
  assert.equal(done.filled.find((f) => f.answer_id === 99)?.source, "answer_bank");
});

test("ruleAgent never stuffs profile values into Yes/No questions, skill-specific experience, or long essay prompts, and uses raw dial code for async phone country selectors", async () => {
  const lookups = [];
  const profile = {
    ...PROFILE,
    links: [...PROFILE.links, { label: "GitHub", url: "https://github.example.test/alex-testperson" }],
    answers: [
      { id: 7, question_pattern: "What is your current location?", answer: "Austin, TX" },
    ],
  };
  const step = ruleAgent(profile, null, {
    handoffOnly: true,
    lookupSaved: async (q) => { lookups.push(q); return { answer: "Should not be called in handoffOnly" }; },
  });
  const fields = [
    { ref: "0.1", role: "combobox", name: "Country", section: "Phone", popup: true, value: "", required: false },
    { ref: "0.2", role: "textbox", name: "Phone", section: "Phone", value: "", required: false },
    { ref: "0.3", role: "combobox", name: "Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?", popup: true, value: "", required: true },
    { ref: "0.4", role: "combobox", name: "Are you currently location in either Canada, UK or Poland?", popup: true, value: "", required: true },
    { ref: "0.5", role: "textarea", name: "Tell us about something you've built on top of our tools, in the last few years. Share a public link if you have one (GitHub, a demo, a write-up).", value: "", required: true },
    { ref: "0.6", role: "textbox", name: "How many years of experience do you have working with Python?", value: "", required: true },
  ];

  // Step 1: Country under Phone section uses raw dial code ("+1") so async comboboxes match "United States (+1)" or "USA (+1)".
  const r1 = await step(obs(fields));
  assert.equal(r1.status, "continue");
  assert.equal(r1.actions[0].ref, "0.1");
  assert.equal(r1.actions[0].text, "+1");
  fields[0].value = "+1";

  // Step 2: Phone strips leading +1 because Country (under Phone section) is present.
  const r2 = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(r2.status, "continue");
  assert.equal(r2.actions[0].ref, "0.2");
  assert.equal(r2.actions[0].text, "555 010 0199");
  fields[1].value = "555 010 0199";

  // Step 3: Hands off immediately without attempting 0.3, 0.4, 0.5, or 0.6, and without calling lookupSaved in handoffOnly mode.
  const r3 = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(r3.status, "handoff");
  assert.deepEqual(r3.handoff.failedFields, []);
  assert.equal(r3.handoff.missingRequiredCount, 4);
  assert.equal(lookups.length, 0);
});

test("ruleAgent handles split Total experience (years + 0..11 months) and maxlength-constrained Contact number", async () => {
  const step = ruleAgent({ ...PROFILE, total_experience_years: 6 }, null, { handoffOnly: true });
  const fields = [
    { ref: "0.1", role: "textbox", name: "Contact number :", maxlength: 10, value: "", required: true },
    { ref: "0.2", role: "select", name: "Total experience", options: Array.from({ length: 51 }, (_, i) => String(i)), value: "", required: true },
    { ref: "0.3", role: "select", name: "Total experience", options: Array.from({ length: 12 }, (_, i) => String(i)), value: "", required: true },
  ];
  const r1 = await step(obs(fields));
  assert.equal(r1.actions[0].text, "5550100199");
  fields[0].value = r1.actions[0].text;

  const r2 = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(r2.actions[0].text, "6");
  fields[1].value = r2.actions[0].text;

  const r3 = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(r3.actions[0].text, "0");
  fields[2].value = r3.actions[0].text;

  const r4 = await step({ ...obs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(r4.status, "handoff");
});

test("ruleAgent does not click an Apply button when application fields are already on the page", async () => {
  const step = ruleAgent(PROFILE, null);
  const res = await step(obs([
    { ref: "0.1", role: "textbox", name: "First Name", value: "Alex", required: true },
    { ref: "0.2", role: "button", name: "Apply" },
    { ref: "0.3", role: "button", name: "Submit application", submit_like: true },
  ]));
  assert.equal(res.status, "ready_for_review");
  assert.deepEqual(res.actions, []);
});
