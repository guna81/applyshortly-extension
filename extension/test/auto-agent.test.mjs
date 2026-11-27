import test from "node:test";
import assert from "node:assert/strict";
import { autoAgent } from "../src/auto-mode/auto-agent.js";
import { ruleAgent } from "../src/rule-based/rule-agent.js";
import { formAgent } from "../src/agent-based/form-agent.js";

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

const makeObs = (elements, extra = {}) => ({
  url: "https://example.test/apply",
  document_id: "doc-1",
  observation_id: "obs-1",
  elements,
  blockers: [],
  errors: [],
  ...extra,
});

test("autoAgent fills known fields via rules (0 LLM calls) then runs 1 Agent review when credits are available", async () => {
  const modelCalls = [];
  const request = async (_cfg, messages) => {
    modelCalls.push(messages);
    return { text: "Everything looks accurate.", tool_calls: [{ name: "done", arguments: { summary: "Reviewed all filled fields." } }] };
  };
  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, request),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );

  const fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "textbox", name: "Email", required: true, value: "" },
  ];

  // Step 1: Rule fills Full name
  let res = await step({ observation: makeObs(fields), results: [] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.local_rule_step, true);
  assert.equal(modelCalls.length, 0);
  fields[0].value = res.actions[0].text;

  // Step 2: Rule fills Email
  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(modelCalls.length, 0);
  fields[1].value = res.actions[0].text;

  // Step 3: Rule hands off -> Agent runs 1 review turn and calls done
  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(modelCalls.length, 1);
  assert.equal(res.status, "ready_for_review");
  assert.equal(res.agent_engine, "ai_led");
  assert.match(modelCalls[0][1].content, /Auto mode handoff/);
  assert.equal(res.filled.some((f) => f.label === "Full name" && f.source === "profile"), true);
  assert.equal(res.filled.some((f) => f.label === "Email" && f.source === "profile"), true);
  assert.deepEqual(res.pre_messages, ["Filled Full name and Email."]);
});

test("ruleAgent records file uploads and emits unified natural-language pre_messages on handoff", async () => {
  const request = async () => ({ text: "Looks good.", tool_calls: [{ name: "done", arguments: { summary: "Done." } }] });
  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, request),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );
  const fields = [
    { ref: "0.1", role: "file", name: "Resume/CV *", required: true, value: "" },
    { ref: "0.2", role: "textbox", name: "Full name✱", required: true, value: "" },
  ];
  let res = await step({ observation: makeObs(fields), results: [] });
  assert.equal(res.actions[0].type, "upload");
  fields[0].value = "ALEX_RESUME.PDF";

  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { value: "ALEX_RESUME.PDF" } }] });
  assert.equal(res.actions[0].type, "type");
  assert.equal(res.filled.some((f) => f.label === "Resume/CV" && f.value === "ALEX_RESUME.PDF"), true);
  fields[1].value = res.actions[0].text;

  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "ready_for_review");
  assert.deepEqual(res.pre_messages, ["Filled Full name, and attached your resume."]);
  assert.equal(res.filled.some((f) => f.label === "Full name" && f.value === PROFILE.full_name), true);
});

test("autoAgent skips Agent review and goes straight to ready_for_review when 0 credits and rules finished cleanly", async () => {
  let agentCreated = false;
  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => { agentCreated = true; return async () => { throw new Error("should not call agent"); }; },
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => false },
  );

  const fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
  ];

  let res = await step({ observation: makeObs(fields), results: [] });
  assert.equal(res.status, "continue");
  fields[0].value = res.actions[0].text;

  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(agentCreated, false);
  assert.equal(res.status, "ready_for_review");
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.filled.some((f) => f.label === "Full name" && f.source === "profile"), true);
});

test("autoAgent falls back to full ruleAgent (asks user) when 0 credits and unknown fields remain", async () => {
  let agentCreated = false;
  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => { agentCreated = true; return async () => { throw new Error("should not call agent"); }; },
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => false },
  );

  const fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "textarea", name: "Why do you want to join our team?", required: true, value: "" },
  ];

  let res = await step({ observation: makeObs(fields), results: [] });
  assert.equal(res.status, "continue");
  fields[0].value = res.actions[0].text;

  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(agentCreated, false);
  assert.equal(res.status, "ask_user");
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.question.ref, "0.2");
});

test("autoAgent allows Agent to fix a rule-filled field while still protecting user_edited fields", async () => {
  let turn = 0;
  const request = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        text: "",
        tool_calls: [
          { name: "type_text", arguments: { ref: "0.1", text: "Alex Corrected" } },
          { name: "type_text", arguments: { ref: "0.2", text: "Overwritten User" } },
        ],
      };
    }
    return { text: "Fixed.", tool_calls: [{ name: "done", arguments: { summary: "Fixed rule field." } }] };
  };

  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, request),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );

  const fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "textbox", name: "Nickname", required: true, value: "Lex", user_edited: true },
  ];

  let res = await step({ observation: makeObs(fields), results: [] });
  assert.equal(res.status, "continue");
  fields[0].value = res.actions[0].text;

  // Handoff to Agent: Agent attempts to overwrite both 0.1 (rule-filled -> allowed) and 0.2 (user_edited -> refused)
  res = await step({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "ai_led");
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0].ref, "0.1");
  assert.equal(res.actions[0].text, "Alex Corrected");
});

test("autoAgent loops back to RULE_FILL on Step 2 after Agent clicks Next on a multi-step wizard", async () => {
  let modelTurns = 0;
  const request = async () => {
    modelTurns += 1;
    if (modelTurns === 1) {
      return { text: "", tool_calls: [{ name: "click", arguments: { ref: "0.2" } }] };
    }
    return { text: "All done.", tool_calls: [{ name: "done", arguments: { summary: "Completed Step 2." } }] };
  };

  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, request),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );

  // Step 1
  const step1Fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "button", name: "Next", value: "" },
  ];
  let res = await step({ observation: makeObs(step1Fields, { url: "https://example.test/step1", document_id: "doc-1" }), results: [] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "rules_led");
  step1Fields[0].value = res.actions[0].text;

  // Handoff on Step 1 -> Agent clicks Next
  res = await step({ observation: makeObs(step1Fields, { url: "https://example.test/step1", document_id: "doc-1" }), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "ai_led");
  assert.equal(res.actions[0].type, "click");
  assert.equal(modelTurns, 1);

  // Step 2: URL changed -> loops back to RULE_FILL first (0 extra LLM calls)
  const step2Fields = [
    { ref: "0.1", role: "textbox", name: "Email", required: true, value: "" },
  ];
  res = await step({ observation: makeObs(step2Fields, { url: "https://example.test/step2", document_id: "doc-2" }), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.actions[0].text, PROFILE.email);
  assert.equal(modelTurns, 1);
  step2Fields[0].value = res.actions[0].text;

  // Step 2 handoff -> Agent runs review and finishes
  res = await step({ observation: makeObs(step2Fields, { url: "https://example.test/step2", document_id: "doc-2" }), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(modelTurns, 2);
  assert.equal(res.status, "ready_for_review");
});

test("autoAgent handles HTTP 402 during Agent review: ready_for_review if clean, rule_only fallback if unresolved", async () => {
  const err402 = Object.assign(new Error("Out of credits"), { status: 402, code: "insufficient_credits" });
  const failingRequest = async () => { throw err402; };

  // Case A: clean rule fill -> 402 -> straight to ready_for_review
  const stepClean = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, failingRequest),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );
  const cleanFields = [{ ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" }];
  let res = await stepClean({ observation: makeObs(cleanFields), results: [] });
  cleanFields[0].value = res.actions[0].text;
  res = await stepClean({ observation: makeObs(cleanFields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "ready_for_review");
  assert.equal(res.agent_engine, "rules_led");

  // Case B: unresolved field -> 402 -> falls back to full ruleAgent (asks user)
  const stepPartial = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, failingRequest),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );
  const partialFields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "textarea", name: "Why this role?", required: true, value: "" },
  ];
  res = await stepPartial({ observation: makeObs(partialFields), results: [] });
  partialFields[0].value = res.actions[0].text;
  res = await stepPartial({ observation: makeObs(partialFields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "ask_user");
  assert.equal(res.agent_engine, "rules_led");
  assert.match(res.message, /out of AI credits/i);
});

test("autoAgent loops back to RULE_FILL when an SPA gate (0 fields) reveals a form on the same URL", async () => {
  let modelTurns = 0;
  const request = async () => {
    modelTurns += 1;
    if (modelTurns === 1) {
      return { text: "", tool_calls: [{ name: "click", arguments: { ref: "0.1" } }] };
    }
    return { text: "All done.", tool_calls: [{ name: "done", arguments: { summary: "Finished form." } }] };
  };

  const step = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, request),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );

  // Initial SPA privacy gate: 0 application fields, same URL/document_id
  const gateElements = [{ ref: "0.1", role: "button", name: "I Agree", value: "" }];
  let res = await step({ observation: makeObs(gateElements, { url: "https://spa.test/#apply/1", document_id: "doc-1" }), results: [] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "ai_led");
  assert.equal(res.actions[0].type, "click");
  assert.equal(modelTurns, 1);

  // After Agent clicks "I Agree", form fields mount on the SAME URL and document_id -> loops back to RULE_FILL!
  const formElements = [{ ref: "0.2", role: "textbox", name: "Email", required: true, value: "" }];
  res = await step({ observation: makeObs(formElements, { url: "https://spa.test/#apply/1", document_id: "doc-1" }), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "continue");
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.actions[0].text, PROFILE.email);
  assert.equal(modelTurns, 1);
});

test("autoAgent falls back to rules_led on HTTP 402 during a subsequent agent turn or mid-rule user_message", async () => {
  const err402 = () => Object.assign(new Error("You are out of AI credits."), { status: 402, code: "insufficient_credits" });

  // Case A: 402 on second agent turn (after initial handoff succeeded)
  let calls = 0;
  const secondTurn402 = async () => {
    calls += 1;
    if (calls === 1) {
      return { text: "", tool_calls: [{ name: "ask_user", arguments: { ref: "0.2", question: "Why this role?" } }] };
    }
    throw err402();
  };
  const stepLater = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, secondTurn402),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );
  const fields = [
    { ref: "0.1", role: "textbox", name: "Full name", required: true, value: "" },
    { ref: "0.2", role: "textarea", name: "Why this role?", required: true, value: "" },
  ];
  let res = await stepLater({ observation: makeObs(fields), results: [] });
  fields[0].value = res.actions[0].text;
  res = await stepLater({ observation: makeObs(fields), results: [{ index: 0, ok: true, result: { verified: true } }] });
  assert.equal(res.status, "ask_user");
  assert.equal(res.agent_engine, "ai_led");
  // Next turn in agent phase hits 402 -> falls back to rule_only
  res = await stepLater({ observation: makeObs(fields), user_reply: "I love building backend systems." });
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.status, "ask_user");
  assert.match(res.message, /out of AI credits/i);

  // Case B: 402 on mid-rule user_message
  const stepMsg = autoAgent(
    () => ruleAgent(PROFILE, null, { handoffOnly: true }),
    () => formAgent(null, PROFILE, null, async () => { throw err402(); }),
    () => ruleAgent(PROFILE, null, { handoffOnly: false }),
    { canUseAgent: () => true },
  );
  const msgFields = [{ ref: "0.1", role: "textarea", name: "Why this role?", required: true, value: "" }];
  res = await stepMsg({ observation: makeObs(msgFields), user_message: "Can you help me?" });
  assert.equal(res.agent_engine, "rules_led");
  assert.equal(res.status, "ask_user");
  assert.match(res.message, /out of AI credits/i);
});
