// The shared agent rules (test/agent-rules.json) applied to the custom-provider planner's code.
// The platform engine runs the same file in apply-assistant/backend/tests/test_agent_rules_shared.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formAgent } from "../src/agent-based/form-agent.js";
import { addTypedLinks, isTypedLink } from "../src/shared/web-fetch.js";

const rules = JSON.parse(readFileSync(new URL("./agent-rules.json", import.meta.url), "utf8"));

// Changed 2026-11-18: the rules now run against the Agent based form assistant agent (formAgent). The old planner offered "suggested actions" to the
// model; the agent has none, so a scenario reply that asked about a box with `checked: true` now means "a model that ticks the
// box whenever it can" (it calls `check`, then falls back to asking), and the code's hard limits decide.
// Changed 2026-11-18: the agent no longer turns a click on a Yes/No option into a check (no form-fixing rewrites); it refuses with
// "use check", and a model reads that and calls check. A scripted click is therefore followed by that check, which runs only when
// the click was refused (an accepted click ends the step and the rest of the queue is dropped).
const modelCalls = (reply) => {
  const asked = { name: "ask_user", arguments: { question: reply.question, ...(reply.ref ? { ref: reply.ref } : {}) } };
  if (reply.tool === "ask_user") return reply.checked ? [[{ name: "check", arguments: { ref: reply.ref, checked: true } }], [asked]] : [[asked]];
  if (reply.tool === "type") return [[{ name: "type_text", arguments: { ref: reply.ref, text: reply.text } }]];
  if (reply.tool === "web_fetch") return [[{ name: "web_fetch", arguments: { url: reply.url } }]];
  if (reply.tool === "click") return [[{ name: "click", arguments: { ref: reply.ref } }], [{ name: "check", arguments: { ref: reply.ref, checked: true } }]];
  return [[{ name: reply.tool, arguments: { ref: reply.ref, ...(reply.checked !== undefined ? { checked: reply.checked } : {}) } }]];
};
/** A model that plays the scripted replies one call at a time, then hands the form over. Its words travel in the {message, actions} envelope. */
const player = () => {
  const queue = [];
  const request = async () => {
    const calls = queue.shift() ?? [{ name: "done", arguments: {} }];
    const asked = calls.find((c) => c.name === "ask_user");
    return { text: JSON.stringify({ message: asked?.arguments.question || "Nothing more to fill.", actions: [] }), tool_calls: calls };
  };
  return { queue, request };
};

test("standing consent ticks a privacy or terms box, and never a declaration", async () => {
  for (const { label, tick } of rules.standing_consent_labels) {
    const { queue, request } = player();
    queue.push(...modelCalls({ tool: "ask_user", ref: "0.1", question: label, checked: true }));
    const step = formAgent({}, { full_name: "C", preferences: { auto_consent: true } }, {}, request, undefined, true, undefined, { vision: false });
    const el = { ref: "0.1", role: "checkbox", name: label, required: true, checked: false };
    const res = await step({ observation: { observation_id: "o", url: "https://jobs.example/apply", elements: [el], tabs: [] }, results: [] });
    // Only the acknowledgements the rules list are ticked; a truth, eligibility or legal declaration never is, whatever the model proposes.
    assert.equal(res.actions.some((a) => a.type === "check" && a.checked === true), tick, label);
  }
});

test("only a link the user typed is opened, matched exactly", () => {
  for (const { typed, links } of rules.typed_links) assert.deepEqual(addTypedLinks([], typed), links, typed);
  for (const { typed, probe, allowed } of rules.typed_link_probes) assert.equal(isTypedLink(addTypedLinks([], typed), probe), allowed, probe);
});

// The JS runtime module is generated for MV3 workers, which cannot import JSON modules.
test("runtime policy module matches the JSON source", async () => {
  const { AGENT_RULES } = await import("../src/shared/agent-rules.js");
  assert.deepEqual(AGENT_RULES, JSON.parse(readFileSync(new URL("../src/shared/agent-rules.json", import.meta.url), "utf8")));
});

const scenarios = JSON.parse(readFileSync(new URL("./agent-scenarios.json", import.meta.url), "utf8"));
for (const scenario of scenarios) test(`scenario replay: ${scenario.name}`, async () => {
  const { queue, request } = player();
  const fetched = [];
  const planner = formAgent({}, { full_name: "Candidate", preferences: { auto_consent: scenario.auto_consent === true } }, {}, request, undefined, true,
    async (url) => { fetched.push(url); return "WEB PAGE fixture project"; }, { vision: false });
  for (const turn of scenario.turns) {
    const observation = structuredClone(scenario.observation);
    for (const reply of turn.replies || [turn.reply]) {
      // A model that is expected to tick a box (standing consent) ticks every checkbox on the page in the same turn it asks its question.
      if (turn.expected === "check" && reply.tool === "ask_user" && !reply.checked) queue.push(observation.elements.filter((e) => e.role === "checkbox").map((e) => ({ name: "check", arguments: { ref: e.ref, checked: true } })));
      queue.push(...modelCalls(reply));
    }
    if (turn.ref) observation.elements[0].ref = turn.ref;
    const result = await planner({ observation, results: [], skip_question: turn.skip_question, user_message: turn.user_message });
    queue.length = 0;
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
