import assert from "node:assert/strict";
import { test } from "node:test";
import { customPlanner } from "../src/custom-agent.js";

const field = { ref: "0.1", name: "Describe a project", role: "textarea", value: "", required: true };
const body = (element = field, extra = {}) => ({ observation: { observation_id: "obs", url: "https://jobs.example/apply", elements: [element], screenshot: "private-image" }, results: [], ...extra });
const planner = (response, calls = []) => customPlanner({}, { full_name: "Candidate" }, {}, async (_config, messages) => { calls.push(messages); return JSON.stringify(response); });

test("custom planner sends context to the provider and issues a fresh guarded command", async () => {
  const calls = [];
  const step = planner({ status: "continue", message: "Filling project", action: { type: "type", ref: "0.1", text: "* **Outcome:** Built a system." } }, calls);
  const result = await step(body());
  assert.equal(result.controller_version, 2);
  assert.equal(result.agent_engine, "ai_led");
  assert.equal(result.actions[0].observation_id, "obs");
  assert.equal(result.actions[0].text, "• Outcome: Built a system.");
  assert.ok(result.actions[0].command_id);
  assert.doesNotMatch(JSON.stringify(calls), /private-image/);
  assert.match(JSON.stringify(calls), /Candidate/);
});

test("custom planner rejects unsafe, stale, or unsolicited changes", async () => {
  for (const [action, observed, extra] of [
    [{ type: "click", ref: "0.1" }, { ...field, role: "button", name: "Submit application", submit_like: true }, {}],
    [{ type: "click", ref: "0.1" }, { ...field, role: "link", name: "Apply", href: "https://other.example/apply" }, {}],
    [{ type: "type", ref: "unknown", text: "x" }, field, {}],
    [{ type: "type", ref: "0.1", text: "x" }, { ...field, value: "Existing" }, {}],
    [{ type: "type", ref: "0.1", text: "x" }, { ...field, value: "Existing" }, { user_message: "continue" }],
    [{ type: "type", ref: "0.1", text: "x" }, field, { inspect_only: true }],
    [{ type: "check", ref: "0.1" }, { ...field, role: "checkbox", name: "I agree" }, {}],
  ]) {
    const step = planner({ status: "continue", message: "Changing", action });
    await assert.rejects(step(body(observed, extra)));
  }
});

test("custom planner asks about optional unanswered fields before finishing", async () => {
  const step = planner({ status: "ready_for_review", message: "Ready" });
  const optional = { ...field, required: false };
  const first = await step(body(optional));
  assert.equal(first.status, "ask_user");
  assert.equal(first.question.optional, true);
  assert.equal((await step(body(optional, { skip_question: true }))).status, "ready_for_review");
});

test("custom planner asks instead of claiming completion with a required answer missing", async () => {
  const step = planner({ status: "ready_for_review", message: "Ready" });
  const result = await step(body());
  assert.equal(result.status, "ask_user");
  assert.equal(result.question.ref, "0.1");
});

test("verified custom AI answers are marked for review", async () => {
  let calls = 0;
  const step = customPlanner({}, {}, {}, async () => JSON.stringify(++calls === 1
    ? { status: "continue", message: "Filling project", action: { type: "type", ref: "0.1", text: "Built a system." } }
    : { status: "ready_for_review", message: "Review" }));
  await step(body());
  const result = await step(body({ ...field, value: "Built a system." }, { results: [{ ok: true, result: { verified: true } }] }));
  assert.equal(result.filled[0].needs_review, true);
  assert.equal(result.filled[0].source, "llm");
});

test("saved answers are included without generating a platform answer", async () => {
  const calls = [];
  const lookedUp = [];
  const step = customPlanner({}, {}, {}, async (_config, messages) => {
    calls.push(messages);
    return JSON.stringify({ status: "ready_for_review", message: "Ready" });
  }, async (question) => { lookedUp.push(question); return { answer: "Saved answer" }; });
  await step(body());
  assert.deepEqual(lookedUp, ["Describe a project"]);
  assert.match(JSON.stringify(calls), /Saved answer/);
});

test("when drafts are disabled the planner asks instead of writing a new draft", async () => {
  const step = customPlanner({}, {}, {}, async () => JSON.stringify({ status: "continue", message: "Writing", action: { type: "type", ref: "0.1", text: "A new draft" } }), undefined, false);
  const result = await step(body());
  assert.equal(result.status, "ask_user");
  assert.equal(result.actions.length, 0);
  assert.equal(result.question.ref, "0.1");
});

test("check commands support choices without overwriting or approving consent", async () => {
  for (const role of ["radio", "checkbox"]) {
    const choice = { ...field, role, name: "Remote", group: "Work location" };
    const step = planner({ status: "continue", message: "Choosing", action: { type: "check", ref: "0.1", checked: true } });
    const result = await step(body(choice));
    assert.equal(result.actions[0].checked, true);
    assert.equal(result.actions[0].type, "check");
    await assert.rejects(step(body({ ...choice, user_edited: true })));
    await assert.rejects(step(body({ ...choice, group: "Consent to terms" })));
    await assert.rejects(step(body(choice, { inspect_only: true })));
  }
});

test("explicit answers survive intermediate planner steps with drafts off", async () => {
  let count = 0;
  const step = customPlanner({}, {}, {}, async () => JSON.stringify(++count === 1
    ? { status: "ask_user", message: "Please answer", question: { kind: "question", text: "Describe", ref: "0.1" } }
    : count === 2 ? { status: "continue", message: "Checking", action: { type: "review" } }
    : { status: "continue", message: "Writing", action: { type: "type", ref: "0.1", text: "My own answer" } }), undefined, false);
  await step(body());
  await step(body(field, { user_reply: "My own answer" }));
  const result = await step(body());
  assert.equal(result.actions[0].text, "My own answer");
});

test("invalid populated fields prevent planner readiness", async () => {
  const step = planner({ status: "ready_for_review", message: "Ready" });
  for (const required of [true, false]) {
    const result = await step(body({ ...field, value: "bad", invalid: true, required }));
    assert.equal(result.status, "ask_user");
    assert.equal(result.question.optional, false);
  }
});

test("consent choices require the user's answer before the provider can select them", async () => {
  const step = planner({ status: "continue", message: "Selecting", action: { type: "select", ref: "0.1", text: "Yes" } });
  const consent = { ...field, role: "select", name: "Authorized to call", required: true };
  const first = await step(body(consent));
  assert.equal(first.status, "ask_user");
  assert.equal(first.actions.length, 0);
  const second = await step(body(consent, { user_reply: "Yes" }));
  assert.equal(second.actions[0].type, "select");
});
