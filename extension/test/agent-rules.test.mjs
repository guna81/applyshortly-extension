// The shared agent rules (test/agent-rules.json) applied to the custom-provider planner's code.
// The platform engine runs the same file in apply-assistant/backend/tests/test_agent_rules_shared.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { customPlanner } from "../src/custom-agent.js";
import { addTypedLinks, isTypedLink } from "../src/web-fetch.js";

const rules = JSON.parse(readFileSync(new URL("./agent-rules.json", import.meta.url), "utf8"));

test("standing consent offers a privacy or terms tick to the model, and never a declaration", async () => {
  for (const { label, tick } of rules.standing_consent_labels) {
    let suggested;
    // A model that ticks the box whenever it can: the code decides whether that is allowed.
    const step = customPlanner({}, { full_name: "C", preferences: { auto_consent: true } }, {}, async (_c, messages) => {
      suggested = JSON.parse(messages[1].content).suggested_actions;
      return JSON.stringify({ status: "continue", message: "Ticking", action: { type: "check", ref: "0.1", checked: true } });
    });
    const el = { ref: "0.1", role: "checkbox", name: label, required: true, checked: false };
    const res = await step({ observation: { observation_id: "o", url: "https://jobs.example/apply", elements: [el], tabs: [] }, results: [] });
    // Only the acknowledgements the rules list are offered to the model as a tick; and a tick of one is accepted.
    assert.equal(suggested.some((a) => a.type === "check"), tick, label);
    if (tick) assert.equal(res.actions[0]?.type, "check", label);
    // A truth, eligibility or legal declaration is never ticked, whatever the model proposes.
    if (/certif|declar|truthful|swear|authori[sz]ed to work/i.test(label)) assert.deepEqual(res.actions, [], label);
  }
});

test("only a link the user typed is opened, matched exactly", () => {
  for (const { typed, links } of rules.typed_links) assert.deepEqual(addTypedLinks([], typed), links, typed);
  for (const { typed, probe, allowed } of rules.typed_link_probes) assert.equal(isTypedLink(addTypedLinks([], typed), probe), allowed, probe);
});

// The JS runtime module is generated for MV3 workers, which cannot import JSON modules.
test("runtime policy module matches the JSON source", async () => {
  const { AGENT_RULES } = await import("../src/agent-rules.js");
  assert.deepEqual(AGENT_RULES, JSON.parse(readFileSync(new URL("../src/agent-rules.json", import.meta.url), "utf8")));
});

const scenarios = JSON.parse(readFileSync(new URL("./agent-scenarios.json", import.meta.url), "utf8"));
for (const scenario of scenarios) test(`scenario replay: ${scenario.name}`, async () => {
  let scripted, replies;
  const fetched = [];
  const planner = customPlanner({}, { full_name: "Candidate", preferences: { auto_consent: scenario.auto_consent === true } }, {}, async (_c, messages) => {
    const reply = replies.length ? replies.shift() : scripted;
    // A model that uses the answers the extension already grounded in the profile instead of asking the user for them.
    const { suggested_actions: grounded = [] } = JSON.parse(messages[1].content);
    if (reply.tool === "ask_user" && grounded.length) return JSON.stringify({ status: "continue", message: "Using the profile", actions: grounded.map(({ field: _field, ...action }) => action) });
    return JSON.stringify(reply.tool === "ask_user"
      ? { status: "ask_user", message: "Question", question: { kind: "question", text: reply.question, ref: reply.ref } }
      : { status: "continue", message: "Fill", action: { type: reply.tool, ref: reply.ref, text: reply.text, checked: reply.checked, url: reply.url } });
  }, undefined, true, async (url) => { fetched.push(url); return "WEB PAGE fixture project"; });
  for (const turn of scenario.turns) {
    replies = [...(turn.replies || [turn.reply])];
    scripted = replies.at(-1);
    const observation = structuredClone(scenario.observation);
    if (turn.ref) observation.elements[0].ref = turn.ref;
    const result = await planner({ observation, results: [], skip_question: turn.skip_question, user_message: turn.user_message });
    if (turn.fetches !== undefined) assert.equal(fetched.length, turn.fetches);
    if (turn.expected === "check") assert.ok(result.actions.some((a) => a.type === "check" && a.checked === true));
    else if (turn.expected === "click") assert.ok(result.actions.some((a) => a.type === "click"));
    else {
      assert.equal(result.actions.length, 0);
      if (turn.expected === "ask") assert.equal(result.question?.kind, "question");
      if (turn.expected === "no_reask") assert.notEqual(result.question?.kind, "question");
    }
  }
});
