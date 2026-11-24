// Added 2026-11-18. The Agent based form assistant form agent: a real tool-calling (ReAct) agent. The model decides every step from its own message
// history (its tool calls, their results, page snapshots); the code only enforces hard limits. These tests drive it with a scripted
// model and check what the agent SENDS (history, ids, results) and what it hands back to the loop (plans).
import assert from "node:assert/strict";
import test from "node:test";
import { readSnapshot } from "./replay/fake-model.mjs";
import { formAgent } from "../src/agent-based/form-agent.js";

const el = (ref, role, name, more = {}) => ({ ref, role, name, value: "", required: true, ...more });
const observation = (elements, more = {}) => ({ url: "https://jobs.example/apply", observation_id: "obs-1", document_id: "d1", text: "Apply for Engineer", elements, tabs: [], blockers: [], ...more });
const call = (name, args = {}) => {
  if (!args || typeof args !== "object") return { name, arguments: args };
  const { question, summary, reason, actions, ...rest } = args;
  return { name, arguments: rest, fixtureResult: { message: question || summary || reason || "Working on the form.", actions: [...new Set((actions ?? []).filter((a) => ["draft", "skip", "on_page"].includes(a)))] } };
};
/** A scripted model: each reply is {text?, tool_calls}. It records every request it receives. */
const scripted = (...replies) => {
  const seen = [];
  const request = async (config, messages, maxTokens, look) => { seen.push({ messages, look }); const reply = replies.shift(); if (!reply) throw new Error("the script ran out of replies"); if (reply.tool_calls?.length) {
    const terminal = reply.tool_calls.find((c) => ["ask_user", "done", "posting_gone"].includes(c.name));
    reply.text = JSON.stringify(terminal?.fixtureResult ?? { message: reply.text || "Working on the form.", actions: [] });
  }
  return reply; };
  return { request, seen };
};
const profile = { full_name: "Asha Kumar", email: "asha@example.test", preferences: {}, has_resume_file: false };
const make = (request, extra = {}) => formAgent({}, profile, { title: "Engineer", company_name: "Acme", location: "Berlin", description: "Build things." }, request, undefined, true, undefined, { vision: false, ...extra });
const body = (obs, more = {}) => ({ observation: obs, results: [], request_id: "r", ...more });

test("one step: the model gets system + snapshot, native tools and run_js; a write becomes a loop action with ids", async () => {
  const { request, seen } = scripted({ text: "Filling the name.", tool_calls: [call("type_text", { ref: "e1", text: "Asha" })] });
  const step = make(request);
  const plan = await step(body(observation([el("e1", "textbox", "First name")])));
  assert.equal(plan.status, "continue");
  assert.equal(plan.actions.length, 1);
  const [action] = plan.actions;
  assert.deepEqual([action.type, action.ref, action.text, action.observation_id], ["type", "e1", "Asha", "obs-1"]);
  assert.ok(action.command_id);
  assert.equal(plan.guarded_commands, true);
  assert.equal(plan.agent_engine, "ai_led");
  assert.equal(seen[0].messages[0].role, "system");
  assert.match(seen[0].messages[0].content, /Asha/, "the candidate profile is in the system message");
  assert.match(seen[0].messages[1].content, /First name/, "the page snapshot is the user message");
  assert.equal(seen[0].look.native_tools, true);
  assert.equal(seen[0].look.allow_js, true);
  assert.deepEqual(seen[0].look.history ?? [], []);
});

test("the next step sends its own history and the tool result for exactly the call it made", async () => {
  const { request, seen } = scripted({ tool_calls: [call("type_text", { ref: "e1", text: "Asha" })] }, { tool_calls: [call("done", { summary: "all set" })] });
  const step = make(request);
  const first = await step(body(observation([el("e1", "textbox", "First name")])));
  await step(body(observation([el("e1", "textbox", "First name", { value: "Asha" })], { observation_id: "obs-2" }), {
    results: [{ index: 0, ok: true, command_id: first.actions[0].command_id, result: { verified: true, value_after: "Asha" } }],
  }));
  const { history, results } = seen[1].look;
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
  assert.equal(history[1].calls.length, 1);
  assert.equal(history[1].calls[0].name, "type_text", "the model sees its own call as it made it");
  assert.deepEqual(results.map((r) => r.id), [history[1].calls[0].id], "results answer exactly the assistant's call ids");
  assert.match(results[0].content, /verified/i);
  assert.match(results[0].content, /Asha/);
});

test("a failed or unverified write is reported to the model as such", async () => {
  const { request, seen } = scripted({ tool_calls: [call("select_option", { ref: "e1", text: "India" })] }, { tool_calls: [call("ask_user", { question: "Which country?", ref: "e1" })] });
  const step = make(request);
  const obs = observation([el("e1", "select", "Country", { options: ["India", "Germany"] })]);
  const first = await step(body(obs));
  await step(body(observation(obs.elements, { observation_id: "obs-2" }), { results: [{ index: 0, ok: false, command_id: first.actions[0].command_id, detail: "No option matches India" }] }));
  assert.match(seen[1].look.results[0].content, /failed.*No option matches India/i);
  assert.equal(seen[1].look.results[0].is_error, true);
});

test("a look (find) is answered inside the same step and the model is called again", async () => {
  const { request, seen } = scripted({ tool_calls: [call("find", { query: "phone" })] }, { tool_calls: [call("type_text", { ref: "e2", text: "555" })] });
  const step = make(request);
  const plan = await step(body(observation([el("e1", "textbox", "Name"), el("e2", "textbox", "Phone number")])));
  assert.equal(seen.length, 2);
  assert.match(seen[1].look.results[0].content, /Phone number/);
  assert.equal(plan.actions[0].ref, "e2");
});

test("ask_user stops the step with a question; the user's reply is the tool result next step", async () => {
  const { request, seen } = scripted({ tool_calls: [call("ask_user", { question: "What is your salary expectation?", ref: "e1" })] }, { tool_calls: [call("type_text", { ref: "e1", text: "90000" })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "Salary expectation")]);
  const asked = await step(body(obs));
  assert.equal(asked.status, "ask_user");
  assert.equal(asked.question.kind, "question");
  assert.equal(asked.question.ref, "e1");
  const next = await step(body(observation(obs.elements, { observation_id: "obs-2" }), { user_reply: "90000", resumed: undefined }));
  assert.match(seen[1].look.results[0].content, /user answered.*90000/is);
  assert.equal(next.actions[0].text, "90000");
});

test("ask_user carries the buttons the model chose, and drops any it invented", async () => {
  const { request } = scripted({ tool_calls: [call("ask_user", { question: "Summary?", ref: "e1", actions: ["draft", "skip", "skip", "buy"] })] });
  const asked = await make(request)(body(observation([el("e1", "textbox", "Summary", { required: false })])));
  assert.deepEqual(asked.question.actions, ["draft", "skip"]);
});

test("a skipped question tells the model the user fills it themselves, and a write to it is refused", async () => {
  const { request, seen } = scripted({ tool_calls: [call("ask_user", { question: "Cover note?", ref: "e1" })] }, { tool_calls: [call("type_text", { ref: "e1", text: "x" })] }, { tool_calls: [call("done", { summary: "ok" })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "Cover note", { required: false })]);
  await step(body(obs));
  const plan = await step(body(observation(obs.elements, { observation_id: "obs-2" }), { skip_question: true }));
  assert.match(seen[1].look.results[0].content, /fill this (?:on the page )?themselves/i);
  assert.equal(plan.status, "ready_for_review", "the refused write went back to the model, which then finished");
  assert.match(seen[2].look.results[0].content, /themselves/i);
});

test("the same question is never asked twice", async () => {
  const { request, seen } = scripted({ tool_calls: [call("ask_user", { question: "Your phone number?", ref: "e1" })] }, { tool_calls: [call("ask_user", { question: "your phone number?", ref: "e1" })] }, { tool_calls: [call("type_text", { ref: "e1", text: "555" })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "Phone")]);
  await step(body(obs));
  const plan = await step(body(observation(obs.elements, { observation_id: "obs-2" }), { user_reply: "555" }));
  assert.match(seen[2].look.results[0].content, /already asked/i);
  assert.equal(plan.status, "continue");
});

test("done preserves the model summary when optional filling is disabled", async () => {
  const { request, seen } = scripted({ text: "That is everything I can fill.", tool_calls: [call("done", { summary: "Filled what the profile supports." })] });
  const plan = await make(request, { fillOptional: false })(body(observation([el("e1", "textbox", "Last name", { value: "Kumar" }), el("e2", "textbox", "Website", { required: false })])));
  assert.equal(seen.length, 1);
  assert.equal(plan.status, "ready_for_review");
  assert.equal(plan.message, "Filled what the profile supports.");
});

test("a question carries the model's own words, and no canned message beside it", async () => {
  const { request } = scripted({ tool_calls: [call("ask_user", { question: "What is your notice period?", ref: "e1" })] });
  const plan = await make(request)(body(observation([el("e1", "textbox", "Notice period")])));
  assert.equal(plan.question.text, "What is your notice period?");
  assert.equal(plan.message, "What is your notice period?");
});

test("an unknown tool or malformed arguments give an error result, never a crash", async () => {
  const { request, seen } = scripted({ tool_calls: [call("format_disk", {}), call("type_text", "not an object")] }, { tool_calls: [call("done", { summary: "ok" })] });
  const step = make(request);
  await step(body(observation([el("e1", "textbox", "Name", { value: "A" })])));
  const results = seen[1].look.results;
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.is_error));
  assert.match(results[0].content, /unknown tool/i);
});

test("plain-text conversational replies work directly without JSON envelope nudges", async () => {
  const { request, seen } = scripted({ text: "Which last name should I use?" });
  const plan = await make(request)(body(observation([el("e1", "textbox", "Last name")])));
  assert.equal(seen.length, 1);
  assert.equal(plan.status, "ask_user");
  assert.equal(plan.message, "Which last name should I use?");
});

test("raw JSON or markup without tool calls is nudged and never surfaced to the user", async () => {
  const { request, seen } = scripted({ text: '{"msg":1}' }, { text: '{"msg":2}' }, { text: '{"msg":3}' });
  const plan = await make(request)(body(observation([el("e1", "textbox", "Last name")])));
  assert.equal(seen.length, 3);
  assert.equal(plan.status, "ask_user");
  assert.equal(plan.message, "");
});

test("a turn that only fills may be silent; a question must have words", async () => {
  const replies = [
    { text: "", tool_calls: [{ name: "type_text", arguments: { ref: "e1", text: "Asha" } }] },
  ];
  const plan = await make(async () => replies.shift())(body(observation([el("e1", "textbox", "First name")])));
  assert.equal(plan.status, "continue");
  assert.equal(plan.message, "");
  let count = 0;
  const asks = [
    { text: "", tool_calls: [{ name: "ask_user", arguments: { ref: "e1" } }] },
    { text: "What is your notice period?", tool_calls: [{ name: "ask_user", arguments: { ref: "e1" } }] },
  ];
  const asked = await make(async () => { count += 1; return asks.shift(); })(body(observation([el("e1", "textbox", "Notice period")])));
  assert.equal(count, 2, "an empty question is rejected by checkQuestion");
  assert.equal(asked.question.text, "What is your notice period?");
});

test("a legacy ```json envelope is still unpacked cleanly", async () => {
  const replies = [{ text: '```json\n{"message":"Filling your name.","actions":[]}\n```', tool_calls: [{ name: "type_text", arguments: { ref: "e1", text: "Asha" } }] }];
  const plan = await make(async () => replies.shift())(body(observation([el("e1", "textbox", "First name")])));
  assert.equal(plan.message, "Filling your name.");
  assert.equal(plan.actions.length, 1);
});

test("ask_user prefers tool question over assistant summary text so fill summaries never replace the question card", async () => {
  const replies = [
    { text: "Filled your contact details and attached your resume.", tool_calls: [{ name: "ask_user", arguments: { ref: "e1", question: "What's your preferred name?", actions: ["skip"] } }] },
  ];
  const plan = await make(async () => replies.shift())(body(observation([el("e1", "textbox", "Preferred name", { required: false })])));
  assert.equal(plan.status, "ask_user");
  assert.equal(plan.message, "Filled your contact details and attached your resume.");
  assert.equal(plan.question.text, "What's your preferred name?");
  assert.deepEqual(plan.question.actions, ["skip"]);
});

test("ask_user accepts plain text or tool arguments for question and UI actions, filtering invalid buttons", async () => {
  const replies = [
    { text: "What should your summary say?", tool_calls: [{ name: "ask_user", arguments: { ref: "e1", actions: ["draft", "on_page", "buy"] } }] },
    { text: "", tool_calls: [{ name: "done", arguments: { summary: "Leaving this field for your review." } }] },
  ];
  const step = make(async () => replies.shift());
  const obs = observation([el("e1", "textbox", "Summary", { required: false })]);
  const asked = await step(body(obs));
  assert.equal(asked.question.text, "What should your summary say?");
  assert.deepEqual(asked.question.actions, ["draft", "on_page"]);
  const done = await step(body(obs, { skip_question: true }));
  assert.equal(done.message, "Leaving this field for your review.");
});

test("conversation while a field question is pending is answered without recording a field answer", async () => {
  const saved = [];
  const replies = [
    { text: JSON.stringify({ message: "What is your salary expectation?", actions: [] }), tool_calls: [{ name: "ask_user", arguments: { ref: "e1" } }] },
    { text: JSON.stringify({ message: "I can help you fill this application using your profile.", actions: [] }), tool_calls: [] },
  ];
  const step = make(async () => replies.shift(), { onState: (s) => saved.push(s) });
  const obs = observation([el("e1", "textbox", "Salary expectation")]);
  await step(body(obs));
  const plan = await step(body(obs, { user_message: "What can you do?" }));
  assert.equal(plan.message, "I can help you fill this application using your profile.");
  assert.equal(plan.status, "ask_user");
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(saved.at(-1).answered, []);
  assert.deepEqual(saved.at(-1).gs.answers, {});
});

test("a provider that cannot call tools stops the run with a clear error", async () => {
  const step = make(async () => ({ text: "{}", tool_calls: [], tool_calls_unsupported: true }));
  await assert.rejects(() => step(body(observation([el("e1", "textbox", "Name")]))), /cannot call tools/i);
});

test("a refused click (final submit) goes back to the model in the same step; four refusals in a row hand the form back", async () => {
  const refuse = { tool_calls: [call("click", { ref: "e2" })] };
  const { request, seen } = scripted(refuse, refuse, refuse, refuse);
  const step = make(request);
  const plan = await step(body(observation([el("e1", "textbox", "Name"), el("e2", "button", "Submit application", { submit_like: true })])));
  assert.match(seen[1].look.results[0].content, /direct approval/i);
  assert.equal(plan.status, "ask_user");
  assert.equal(seen.length, 4);
});

test("fill_form expands into one action per field, each vetted; results come back as one tool result", async () => {
  const { request, seen } = scripted({ tool_calls: [call("fill_form", { fields: [{ ref: "e1", text: "Asha" }, { ref: "e2", text: "Kumar" }] })] }, { tool_calls: [call("done", { summary: "x" })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "First name"), el("e2", "textbox", "Last name")]);
  const plan = await step(body(obs));
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions.map((a) => a.ref), ["e1", "e2"], "batch preserves page order");
  await step(body(observation(obs.elements.map((e) => ({ ...e, value: "x" })), { observation_id: "obs-2" }), {
    results: plan.actions.map((a, index) => ({ index, ok: true, command_id: a.command_id, result: { verified: true, value_after: "x" } })),
  }));
  assert.equal(seen[1].look.results.length, 1);
  assert.match(seen[1].look.results[0].content, /First name|e1/);
  assert.match(seen[1].look.results[0].content, /Last name|e2/);
});

test("actions the loop did not run (an earlier one failed) are reported as not executed", async () => {
  const { request, seen } = scripted({ tool_calls: [call("type_text", { ref: "e1", text: "A" }), call("type_text", { ref: "e2", text: "B" })] }, { tool_calls: [call("done", { summary: "x" })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "First"), el("e2", "textbox", "Second")]);
  const plan = await step(body(obs));
  await step(body(observation(obs.elements.map((e) => ({ ...e, value: "x" })), { observation_id: "obs-2" }), { results: [{ index: 0, ok: false, command_id: plan.actions[0].command_id, detail: "blocked" }] }));
  const results = seen[1].look.results;
  assert.equal(results.length, 2);
  assert.match(results[1].content, /not executed/i);
});

test("click_at becomes a click on the one control under the point", async () => {
  const { request } = scripted({ tool_calls: [call("click_at", { x: 20, y: 20 })] });
  const step = make(request);
  const plan = await step(body(observation([el("e1", "button", "Next", { bounds: [0, 0, 100, 40] })], { viewport_width: 800, viewport_height: 600 })));
  assert.deepEqual([plan.actions[0].type, plan.actions[0].ref], ["click", "e1"]);
});

test("run_js becomes a run_js action carrying the code", async () => {
  const { request } = scripted({ tool_calls: [call("run_js", { code: "document.title" })] });
  const step = make(request);
  const plan = await step(body(observation([el("e1", "textbox", "Name")])));
  assert.deepEqual([plan.actions[0].type, plan.actions[0].code], ["run_js", "document.title"]);
  assert.equal(plan.actions[0].observation_id, "obs-1");
});

test("older snapshots shrink to a stub while the latest snapshot carries current delta metadata", async () => {
  const { request, seen } = scripted({ tool_calls: [call("scroll", { direction: "down" })] }, { tool_calls: [call("scroll", { direction: "down" })] }, { tool_calls: [call("done", { summary: "x" })] });
  const step = make(request);
  const obs = (id) => observation([el("e1", "textbox", "Name", { value: "A" })], { observation_id: id, text: "A very long page text ".repeat(50) });
  let plan = await step(body(obs("o1")));
  plan = await step(body(obs("o2"), { results: [{ index: 0, ok: true, command_id: plan.actions[0].command_id }] }));
  await step(body(obs("o3"), { results: [{ index: 0, ok: true, command_id: plan.actions[0].command_id }] }));
  const history = seen[2].look.history;
  const users = history.filter((m) => m.role === "user");
  assert.equal(users.length, 2);
  for (const message of users) assert.ok(message.text.length < 200, `older snapshot not shrunk: ${message.text.length}`);
  assert.match(seen[2].messages[1].content, /Page text unchanged; get_page_text retrieves it/, "the current snapshot explains the omitted text");
});

test("past 16 messages the oldest pair is dropped and the new first message loses its orphan results", async () => {
  const replies = Array.from({ length: 45 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] }));
  const { request, seen } = scripted(...replies);
  const step = make(request);
  let plan = await step(body(observation([el("e1", "textbox", "Name")], { observation_id: "o0" })));
  for (let i = 1; i < 44; i++) plan = await step(body(observation([el("e1", "textbox", "Name")], { observation_id: `o${i}` }), { results: [{ index: 0, ok: true, command_id: plan.actions[0].command_id }] }));
  const { history } = seen.at(-1).look;
  assert.ok(history.length <= 16, `history grew to ${history.length}`);
  assert.equal(history[0].role, "user");
  assert.deepEqual(history[0].results ?? [], [], "the first message answers nothing that was dropped");
  const roles = history.map((m) => m.role);
  assert.ok(roles.every((role, i) => i === 0 || role !== roles[i - 1]), "roles alternate");
});

test("state is saved after every step and a fresh agent built from it carries on with the same history", async () => {
  const saved = [];
  const first = scripted({ tool_calls: [call("ask_user", { question: "Salary expectation?", ref: "e1" })] });
  const stepA = make(first.request, { onState: (state) => saved.push(state) });
  const obs = observation([el("e1", "textbox", "Salary")]);
  await stepA(body(obs));
  assert.ok(saved.length >= 1);
  const restored = JSON.parse(JSON.stringify(saved.at(-1)));
  const second = scripted({ tool_calls: [call("type_text", { ref: "e1", text: "90000" })] }, { tool_calls: [call("ask_user", { question: "salary expectation?", ref: "e1" })] });
  const stepB = make(second.request, { state: restored });
  await stepB(body(observation(obs.elements, { observation_id: "obs-2" }), { user_reply: "90000" }));
  const { history, results } = second.seen[0].look;
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
  assert.equal(results[0].id, history[1].calls[0].id);
  assert.match(results[0].content, /90000/);
});

test("fillOptional is read fresh in the snapshot every turn", async () => {
  let fill = true;
  const { request, seen } = scripted({ tool_calls: [call("done", { summary: "x" })] });
  const step = formAgent({}, profile, {}, request, undefined, true, undefined, { vision: false, get fillOptional() { return fill; } });
  fill = false;
  const plan = await step(body(observation([el("e1", "textbox", "Website", { required: false })])));
  assert.match(seen[0].messages[1].content, /Fill optional fields: OFF/);
  assert.equal(plan.status, "ready_for_review");
});

test("user_message keeps full write tools so the user can ask questions or request edits", async () => {
  const { request, seen } = scripted(
    { text: "The form asks for your name." },
    { text: "Updating your name.", tool_calls: [call("type_text", { ref: "e1", text: "Asha K" })] },
  );
  const step = make(request);
  const obs = observation([el("e1", "textbox", "Name", { value: "A" })]);
  const chat = await step(body(obs, { user_message: "What does this form ask?" }));
  assert.equal(seen[0].look.tool_names, undefined);
  assert.equal(chat.status, "ask_user");
  assert.equal(chat.question.kind, "click");
  assert.match(chat.message, /asks for your name/);
  const edit = await step(body(observation([el("e1", "textbox", "Name", { value: "" })]), { user_message: "Change my name to Asha K" }));
  assert.equal(seen[1].look.tool_names, undefined);
  assert.equal(edit.status, "continue");
  assert.equal(edit.actions[0].text, "Asha K");
});

test("command ids are unique across steps", async () => {
  const { request } = scripted({ tool_calls: [call("scroll", { direction: "down" })] }, { tool_calls: [call("scroll", { direction: "down" })] });
  const step = make(request);
  const a = await step(body(observation([el("e1", "textbox", "Name")])));
  const b = await step(body(observation([el("e1", "textbox", "Name")], { observation_id: "obs-2" }), { results: [{ index: 0, ok: true, command_id: a.actions[0].command_id }] }));
  assert.notEqual(a.actions[0].command_id, b.actions[0].command_id);
});

test("the system message tells the model to quote the field's own label when it asks", async () => {
  const { request, seen } = scripted({ tool_calls: [call("done", { summary: "x" })] });
  await make(request)(body(observation([el("e1", "textbox", "Name", { value: "A" })])));
  assert.match(seen[0].messages[0].content, /field's own label/i);
});

test("the system message asks for one question about each optional field the facts cannot fill, in page order", async () => {
  // Added 2026-11-18, found live: without this rule optional fields went unasked (Greenhouse optional 8 -> 3 of 10 against the old planner).
  // Changed 2026-11-18: optional questions keep their place in the page order instead of waiting until the required ones are done.
  const { request, seen } = scripted({ tool_calls: [call("done", { summary: "x" })] });
  await make(request)(body(observation([el("e1", "textbox", "Name", { value: "A" })])));
  const system = seen[0].messages[0].content;
  assert.match(system, /optional field[^.]*(?:ask|question)[^.]*once/i);
  assert.match(system, /top to bottom, in page order/i);
  assert.match(system, /separate tool calls in page order, including uploads/i);
  assert.doesNotMatch(system, /after the required/i);
  assert.doesNotMatch(system, /two plain sentences/i);
});

test("every snapshot shows the user's three switches as they are now", async () => {
  const switches = { fillOptional: true, allowDrafts: true, autoApply: false };
  const { request, seen } = scripted({ tool_calls: [call("scroll", { direction: "down" })] }, { tool_calls: [call("scroll", { direction: "down" })] });
  const step = formAgent({}, profile, {}, request, undefined, true, undefined, {
    vision: false, get fillOptional() { return switches.fillOptional; }, get allowDrafts() { return switches.allowDrafts; }, get autoApply() { return switches.autoApply; },
  });
  const first = await step(body(observation([el("e1", "textbox", "Name")])));
  assert.match(seen[0].messages[1].content, /Fill optional fields: ON.*Auto-draft open-ended answers: ON.*Auto apply: OFF/);
  Object.assign(switches, { fillOptional: false, allowDrafts: false, autoApply: true });
  await step(body(observation([el("e1", "textbox", "Name")], { observation_id: "obs-2" }), { results: [{ index: 0, ok: true, command_id: first.actions[0].command_id }] }));
  assert.match(seen[1].messages[1].content, /Fill optional fields: OFF.*Auto-draft open-ended answers: OFF.*Auto apply: ON/);
});

test("Auto-draft open-ended answers is read fresh in the snapshot and does not hard-block factual textarea writes", async () => {
  let drafts = true;
  const { request, seen } = scripted({ tool_calls: [call("type_text", { ref: "e1", text: "https://github.com/example" })] });
  const step = formAgent({}, profile, {}, request, undefined, true, undefined, { vision: false, get allowDrafts() { return drafts; } });
  drafts = false;
  const plan = await step(body(observation([el("e1", "textarea", "Github profile")])));
  assert.match(seen[0].messages[1].content, /Auto-draft open-ended answers: OFF/);
  assert.equal(plan.status, "continue");
  assert.equal(plan.actions[0].type, "type");
});

test("Draft it for me lets the agent write that one field with the switch off", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("ask_user", { question: "Why do you want this job?", ref: "e1", actions: ["draft"] })] },
    { tool_calls: [call("type_text", { ref: "e1", text: "I like the product. I have built similar tools." })] });
  const step = make(request, { allowDrafts: false });
  const obs = observation([el("e1", "textarea", "Why do you want this job?")]);
  await step(body(obs));
  const plan = await step(body(obs, { user_reply: "Draft it for me" }));
  assert.equal(plan.status, "continue");
  assert.equal(plan.actions[0].type, "type");
  assert.match(seen[1].messages[1].content, /Draft it for me/);
});


test("optional dropdowns remain in the model attention checklist and are asked before completion", async () => {
  const { request, seen } = scripted({ tool_calls: [call("ask_user", { question: "How did you hear about us?", ref: "e1" })] });
  const plan = await make(request)(body(observation([el("e1", "combobox", "How did you hear about us?", { required: false })])));
  assert.equal(plan.status, "ask_user");
  assert.match(seen[0].messages.at(-1).content, /How did you hear about us/);
  assert.match(seen[0].messages[0].content, /every applicable enabled optional field must be answered or offered once/);
});

test("an available optional cover letter is offered to the model and can be uploaded", async () => {
  const { request, seen } = scripted({ tool_calls: [call("upload", { ref: "e1", file: "cover_letter" })] });
  const step = formAgent({}, profile, { cover_letter: "Synthetic test cover letter" }, request, undefined, true, undefined, { vision: false });
  const plan = await step(body(observation([el("e1", "file", "Cover letter", { required: false })])));
  assert.match(seen[0].messages.at(-1).content, /Cover letter/);
  assert.equal(plan.actions[0].type, "upload");
  assert.equal(plan.actions[0].file, "cover_letter");
});

test("done is refused until the missing required field has been addressed", async () => {
  const { request, seen } = scripted({ tool_calls: [call("done", { summary: "Done" })] }, { tool_calls: [call("ask_user", { question: "What is your country of residence?", ref: "e1" })] });
  const plan = await make(request)(body(observation([el("e1", "combobox", "Country of residence")])));
  assert.equal(plan.status, "ask_user");
  assert.match(seen[1].look.results[0].content, /Required fields are still unanswered/);
});

test("an application that used its token limit is handed to the user with a clear message, and the model is not called again", async () => {
  const { request, seen } = scripted();
  const step = make(request, { state: { tokens: 1_000_000 } });
  const plan = await step(body(observation([el("e1", "textbox", "First name")])));
  assert.equal(plan.status, "failed");
  assert.match(plan.message, /limit of about 1,000,000 input tokens/);
  assert.equal(seen.length, 0, "no model call is made past the limit");
});

test("every model call adds its input to the application's token count, history included", async () => {
  const saved = [];
  const { request } = scripted({ tool_calls: [call("type_text", { ref: "e1", text: "Asha" })] });
  const step = make(request, { onState: (state) => saved.push(state) });
  await step(body(observation([el("e1", "textbox", "First name")])));
  assert.ok(saved.at(-1).tokens > 100, "the system message and snapshot are counted");
});

test("an old tool result is shortened in the history, its call id kept, so the input does not grow with every page read", async () => {
  const big = "x".repeat(20000);
  const { request, seen } = scripted({ tool_calls: [call("get_page_text")] }, { tool_calls: [call("type_text", { ref: "e1", text: "Asha" })] }, { tool_calls: [call("done", { summary: "all set" })] });
  const step = make(request, { readPage: async () => big });
  const obs = observation([el("e1", "textbox", "First name")]);
  const first = await step(body(obs));
  await step(body(observation([el("e1", "textbox", "First name", { value: "Asha" })], { observation_id: "obs-2" }), { results: [{ index: 0, ok: true, command_id: first.actions?.[0]?.command_id, result: { verified: true, value_after: "Asha" } }] }));
  const sizes = seen.at(-1).look.history.flatMap((m) => (m.results ?? []).map((r) => r.content.length));
  assert.ok(sizes.every((n) => n < 1700), `older results are short, got ${sizes}`);
});

test("page messages that follow each other without a model answer in between do not stack whole snapshots", async () => {
  const old = observation([el("e1", "textbox", "OLD-SNAPSHOT-MARKER")]);
  const state = { messages: [{ role: "user", text: `Page: ${old.url}\nOLD-SNAPSHOT-MARKER ${"y".repeat(5000)}`, stub: "[Earlier snapshot: 1 elements; superseded by a later one.]", results: [] }] };
  const { request, seen } = scripted({ tool_calls: [call("type_text", { ref: "e2", text: "Asha" })] });
  const step = make(request, { state });
  await step(body(observation([el("e2", "textbox", "First name")], { observation_id: "obs-2" })));
  const sent = seen[0].messages[1].content;
  assert.ok(!sent.includes("OLD-SNAPSHOT-MARKER"), "the old snapshot is shrunk to its stub");
  assert.match(sent, /First name/);
});

test("fill_form selects popup textboxes and exposes their dropdown capability", async () => {
  const { request, seen } = scripted({ tool_calls: [call("fill_form", { fields: [{ ref: "e1", text: "India" }] })] });
  const plan = await make(request)(body(observation([el("e1", "textbox", "Country", { popup: true })])));
  assert.equal(plan.actions[0].type, "select");
  assert.match(seen[0].messages[1].content, /"popup":true/);
});

test("only unchanged verified filled controls disappear; changed and empty controls return", async () => {
  const { request, seen } = scripted(...Array.from({ length: 4 }, (_, i) => ({ tool_calls: [call(i ? "scroll" : "type_text", i ? { direction: "down" } : { ref: "e1", text: "Asha" })] })));
  const step = make(request);
  await step(body(observation([el("e1", "textbox", "First name")])));
  const filled = el("e1", "textbox", "First name", { value: "Asha" });
  await step(body(observation([filled]), { results: [{ index: 0, ok: true, result: { verified: true } }] }));
  assert.doesNotMatch(seen[1].messages[1].content, /"ref":"e1"/);
  await step(body(observation([{ ...filled, invalid: true }])));
  assert.match(seen[2].messages[1].content, /"ref":"e1"/);
  await step(body(observation([{ ...filled, value: "" }])));
  assert.match(seen[3].messages[1].content, /"ref":"e1"/);
});

test("trimmed history retains user answers and instructions in current context", async () => {
  const { request, seen } = scripted(...Array.from({ length: 12 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] })));
  const step = make(request, { state: { answered: [{ key: "salary", answer: "120000" }], instructions: ["Keep the salary annual."] } });
  for (let i = 0; i < 12; i++) await step(body(observation([el("e1", "textbox", "Name")])));
  assert.ok(seen.at(-1).look.history.length <= 16);
  assert.match(seen.at(-1).messages[1].content, /120000/);
  assert.match(seen.at(-1).messages[1].content, /Keep the salary annual/);
});

test("field questions require a current ref; a bound skip settles the optional field", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("ask_user", { question: "Other details?" })] },
    { tool_calls: [call("ask_user", { question: "Other details?", ref: "e1" })] },
    { tool_calls: [call("done", { summary: "Ready for review." })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "If other, specify", { required: false })]);
  assert.equal((await step(body(obs))).question.ref, "e1");
  assert.match(seen[1].look.results[0].content, /current field ref/);
  assert.equal((await step(body(obs, { skip_question: true }))).status, "ready_for_review");
});

test("completion attention disambiguates duplicate labels by ref", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("done", { summary: "Ready." })] },
    { tool_calls: [call("ask_user", { question: "Other details?", ref: "e2" })] });
  await make(request)(body(observation([el("e1", "textbox", "Other", { required: false }), el("e2", "textbox", "Other", { required: false })])));
  const result = seen[0].messages.at(-1).content;
  assert.match(result, /"ref":"e1"/); assert.match(result, /"ref":"e2"/);
});

test("delta omits unchanged settled choice siblings, but a cleared group returns with every option", async () => {
  const { request, seen } = scripted(...Array.from({ length: 3 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] })));
  const step = make(request);
  const elements = [el("yes", "radio", "Yes", { group: "Available", checked: true }), el("no", "radio", "No", { group: "Available", checked: false }), el("open", "textbox", "Salary")];
  await step(body(observation(elements)));
  await step(body(observation(elements)));
  assert.doesNotMatch(seen[1].messages[1].content, /"ref":"(?:yes|no)"/);
  assert.match(seen[1].messages[1].content, /"ref":"open"/);
  await step(body(observation(elements.map((e) => e.ref === "yes" ? { ...e, checked: false } : e))));
  assert.match(seen[2].messages[1].content, /"ref":"yes"/);
  assert.match(seen[2].messages[1].content, /"ref":"no"/);
});

test("page text deltas survive restoration and reset on document changes", async () => {
  let state;
  const first = scripted({ tool_calls: [call("scroll", { direction: "down" })] });
  const obs = observation([el("e1", "textbox", "Name")], { text: "Unique application instructions" });
  await make(first.request, { onState: (s) => { state = s; } })(body(obs));
  const next = scripted(...Array.from({ length: 3 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] })));
  const step = make(next.request, { state });
  await step(body(obs));
  assert.doesNotMatch(next.seen[0].messages[1].content, /Unique application instructions/);
  assert.match(next.seen[0].messages[1].content, /get_page_text/);
  await step(body({ ...obs, text: "Updated instructions" }));
  assert.match(next.seen[1].messages[1].content, /Updated instructions/);
  await step(body({ ...obs, document_id: "new-document" }));
  assert.match(next.seen[2].messages[1].content, /Unique application instructions/);
});

test("review returns unresolved tail fields first without truncating them behind filled fields", async () => {
  const { request, seen } = scripted({ tool_calls: [call("review")] }, { tool_calls: [call("ask_user", { ref: "tail", question: "Other details?" })] });
  const step = make(request);
  const elements = [...Array.from({ length: 40 }, (_, i) => el(`filled${i}`, "textbox", `Existing field ${i}`, { value: "Existing answer" })), el("tail", "textbox", "Other details", { required: false })];
  const obs = observation(elements);
  const plan = await step(body(obs));
  await step(body(obs, { results: [{ index: 0, ok: true, result: { field_count: 41, fields: elements } }] }));
  const result = seen[1].look.results[0].content;
  assert.match(result, /needs_attention/); assert.match(result, /"ref":"tail"/);
  assert.ok(result.length < 1000);
  assert.equal(plan.actions[0].type, "review");
});

test("snapshot dictionaries retain labels once and shrink repeated choice groups", async () => {
  const { request, seen } = scripted({ tool_calls: [call("scroll", { direction: "down" })] });
  const group = "A detailed question about this application ".repeat(7);
  await make(request)(body(observation(Array.from({ length: 10 }, (_, i) => el(`choice${i}`, "checkbox", `Option ${i}`, { group, section: group, checked: false })))));
  const snapshot = seen[0].messages[1].content;
  assert.equal(snapshot.split(group).length - 1, 1, "full group appears once; section is clipped independently");
  assert.match(snapshot, /Groups \(g\)/); assert.match(snapshot, /"g":"1"/);
  assert.equal(readSnapshot(snapshot).elements[0].group, group);
  assert.ok(snapshot.length < 2500);
});

test("unverified nonempty writes remain visible across unchanged observations", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("type_text", { ref: "e1", text: "Asha" })] },
    ...Array.from({ length: 2 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] })));
  const step = make(request);
  await step(body(observation([el("e1", "textbox", "Name")])));
  const obs = observation([el("e1", "textbox", "Name", { value: "Unexpected partial answer" })]);
  await step(body(obs, { results: [{ index: 0, ok: true, result: { verified: false } }] }));
  await step(body(obs));
  assert.match(seen[2].messages[1].content, /"ref":"e1"/);
});

test("popup dropdown roles are stable without inventing missing selected values", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("select_option", { ref: "e1", text: "India" })] },
    ...Array.from({ length: 3 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] })));
  const step = make(request);
  await step(body(observation([el("e1", "textbox", "Country", { popup: true })])));
  assert.match(seen[0].messages[1].content, /"role":"combobox"/);
  await step(body(observation([el("e1", "textbox", "Country", { popup: true, value: "India" })]), { results: [{ index: 0, ok: true, result: { verified: true } }] }));
  await step(body(observation([el("e1", "combobox", "Country", { value: "India" })])));
  assert.doesNotMatch(seen[2].messages[1].content, /"ref":"e1"/, "role flicker alone does not resend a settled dropdown");
  await step(body(observation([el("e1", "textbox", "Country", { popup: true })])));
  assert.match(seen[3].messages[1].content, /"ref":"e1"/);
  assert.doesNotMatch(seen[3].messages[1].content, /"value":"India"/);
});

test("delta keeps navigation discoverable and unanswered button-choice groups fully visible", async () => {
  const { request, seen } = scripted(...Array.from({ length: 2 }, () => ({ tool_calls: [call("scroll", { direction: "down" })] })));
  const step = make(request);
  const obs = observation([el("next", "button", "Continue"), el("yes", "button", "Yes", { group: "Relocate?", pressed: false }), el("no", "button", "No", { group: "Relocate?", pressed: false })]);
  await step(body(obs)); await step(body(obs));
  const snap = readSnapshot(seen[1].messages[1].content);
  assert.ok(snap.elements.some((e) => e.ref === "next" && e.name === "Continue"));
  assert.ok(snap.elements.some((e) => e.ref === "yes" && e.group === "Relocate?" && e.pressed === false));
  assert.ok(snap.elements.some((e) => e.ref === "no" && e.group === "Relocate?" && e.pressed === false));
});

test("model completion can leave optional follow-ups blank but cannot exclude required fields", async () => {
  const optional = scripted({ tool_calls: [call("done", { summary: "Review and submit." })] });
  assert.equal((await make(optional.request)(body(observation([el("e1", "textbox", "If yes, details", { required: false })])))).status, "ready_for_review");
  const required = scripted({ tool_calls: [call("done", { summary: "Review." })] }, { tool_calls: [call("ask_user", { ref: "e1", question: "What details are required?" })] });
  assert.equal((await make(required.request)(body(observation([el("e1", "textbox", "Details")])))).status, "ask_user");
  assert.match(required.seen[1].look.results[0].content, /Required fields/);
});

test("required conditional follow-ups must be resolved before later questions", async () => {
  const { request, seen } = scripted({ tool_calls: [call("ask_user", { ref: "e1", question: "What details should be entered?" })] });
  await make(request)(body(observation([el("e1", "textbox", "If yes, details")])));
  assert.match(seen[0].messages[0].content, /resolve it NOW before any later question/);
  assert.match(seen[0].messages[0].content, /Never defer a required conditional field until done/);
});

test("model-driven formatted writes report ok without is_error while staying visible for the model to check", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("type_text", { ref: "e1", text: "5550100199" })] },
    { tool_calls: [call("done", { summary: "Done." })] });
  const step = make(request);
  await step(body(observation([el("e1", "textbox", "Phone")])));
  const obs = observation([el("e1", "textbox", "Phone", { value: "(555) 010-0199" })]);
  await step(body(obs, { results: [{ index: 0, ok: true, result: { verified: false, changed: true } }] }));
  const result = seen[1].look.results[0];
  assert.equal(result.is_error, false);
  assert.match(result.content, /page formatted value; check/);
  assert.match(result.content, /\(555\) 010-0199/);
  assert.match(seen[1].messages[1].content, /"ref":"e1"/);
});

test("user_reply after a failed action (stuck blocker handoff) is delivered to the model with full write tools", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("type_text", { ref: "e1", text: "Trichy" })] },
    { tool_calls: [call("type_text", { ref: "e1", text: "Tiruchirapalli" })] });
  const step = make(request);
  const obs = observation([el("e1", "textbox", "Current Location")]);
  await step(body(obs));
  const plan = await step(body(obs, {
    results: [{ index: 0, ok: false, detail: "The page did not show the requested value." }],
    user_reply: "why dont you try tiruchirapalli?",
  }));
  assert.equal(seen[1].look.tool_names, undefined);
  assert.match(seen[1].messages[1].content, /why dont you try tiruchirapalli\?/);
  assert.equal(plan.status, "continue");
  assert.equal(plan.actions[0].text, "Tiruchirapalli");
});

test("ask_user strips the skip (Leave it blank) button on required fields", async () => {
  const { request } = scripted({
    tool_calls: [call("ask_user", { question: "What should I enter for Current Company?", ref: "e1", actions: ["skip", "on_page"] })],
  });
  const plan = await make(request)(body(observation([el("e1", "textbox", "Current Company", { required: true })])));
  assert.equal(plan.status, "ask_user");
  assert.deepEqual(plan.question.actions, ["on_page"]);
});

test("model-driven type with picker_open or search_pending reports ok without is_error", async () => {
  const { request, seen } = scripted(
    { tool_calls: [call("type_text", { ref: "e1", text: "Trichy" })] },
    { tool_calls: [call("select_option", { ref: "e1", text: "Trichy, Tamil Nadu, India" })] },
    { message: "Done", tool_calls: [call("done", {})] });
  const step = make(request);
  const obs1 = observation([el("e1", "textbox", "Current Location")]);
  await step(body(obs1));
  const obs2 = observation([
    el("e1", "textbox", "Current Location", { popup: true, expanded: true, value: "Trichy" }),
    el("e2", "option", "Trichy, Tamil Nadu, India", { group: "Current Location" }),
  ]);
  const plan2 = await step(body(obs2, {
    results: [{ index: 0, ok: true, result: { ref: "e1", type: "type", requested: "Trichy", matched: "Trichy", verified: false, picker_open: true } }],
  }));
  const result = seen[1].look.results[0];
  assert.equal(result.is_error, false);
  assert.match(result.content, /suggestions list opened; pick an option/);
  assert.equal(plan2.status, "continue");
  assert.equal(plan2.actions[0].type, "select");
});

test("bare phone dial-code prefix (+91) is treated as empty for type_text, ask_user, and done", async () => {
  const tel = () => el("e1", "textbox", "Phone", { input_type: "tel", value: "+91", required: true });

  // 1. type_text is allowed instead of being refused as overwriting an existing answer
  const typed = scripted({ tool_calls: [call("type_text", { ref: "e1", text: "+91 6381868258" })] });
  const typePlan = await make(typed.request)(body(observation([tel()])));
  assert.equal(typePlan.status, "continue");
  assert.equal(typePlan.actions[0].type, "type");
  assert.equal(typePlan.actions[0].ref, "e1");

  // 2. done is refused while a required phone field only has "+91", and ask_user is allowed on it
  const blockedDone = scripted(
    { tool_calls: [call("done", { summary: "Done." })] },
    { tool_calls: [call("ask_user", { ref: "e1", question: "Please enter your phone number.", actions: ["on_page"] })] },
  );
  const askPlan = await make(blockedDone.request)(body(observation([tel()])));
  assert.equal(askPlan.status, "ask_user");
  assert.match(blockedDone.seen[1].look.results[0].content, /Required fields are still unanswered/);
});

test("ready_for_review unresolved entries preserve each field's required flag", async () => {
  const { request } = scripted({ tool_calls: [call("done", { summary: "Review and submit." })] });
  const obs = observation([
    el("e1", "textbox", "Name", { value: "Guna P", required: true }),
    el("e2", "textbox", "Referral", { value: "", required: false }),
    el("e3", "textbox", "Photograph", { value: "", required: false }),
  ]);
  const plan = await make(request)(body(obs));
  assert.equal(plan.status, "ready_for_review");
  assert.deepEqual(plan.unresolved, [
    { label: "Referral", required: false },
    { label: "Photograph", required: false },
  ]);
});
