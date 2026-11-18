// Added 2026-11-18. Custom (own-key) providers run the same tool-calling agent as the platform: completeTools sends the agent's message
// history and the tool results in each provider's own format, so tool calls and results pair up by id.
import assert from "node:assert/strict";
import test from "node:test";
import { completeTools } from "../src/shared/custom-ai.js";

const history = [
  { role: "user", text: "snapshot 1", results: [] },
  { role: "assistant", text: "Looking.", calls: [{ id: "call_a", name: "find", arguments: { query: "phone" } }] },
];
const results = [{ id: "call_a", content: "[{\"ref\":\"e2\"}]", is_error: false }];
const tools = [{ name: "find", description: "find", input_schema: { type: "object", properties: {}, additionalProperties: false } }];

const withFetch = async (response, run) => {
  const real = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => response }; };
  try { await run(sent); } finally { globalThis.fetch = real; }
};

test("an OpenAI-style provider gets assistant tool_calls and role:tool results before the new snapshot", async () => {
  await withFetch({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "type_text", arguments: "{\"ref\":\"e2\",\"text\":\"555\"}" } }] } }] }, async (sent) => {
    const config = { baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" };
    const reply = await completeTools(config, [{ role: "system", content: "SYS" }, { role: "user", content: "snapshot 2" }], 800, { tools, history, results });
    const messages = sent[0].body.messages;
    assert.deepEqual(messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
    assert.equal(messages[2].tool_calls[0].id, "call_a");
    assert.equal(messages[2].tool_calls[0].function.arguments, "{\"query\":\"phone\"}");
    assert.equal(messages[3].tool_call_id, "call_a");
    assert.equal(messages[4].content, "snapshot 2");
    assert.equal(reply.tool_calls[0].name, "type_text");
  });
});

test("an Anthropic provider gets tool_use blocks and tool_result blocks first in the next user message", async () => {
  await withFetch({ content: [{ type: "tool_use", id: "x", name: "done", input: { summary: "ok" } }] }, async (sent) => {
    const config = { baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "m" };
    await completeTools(config, [{ role: "system", content: "SYS" }, { role: "user", content: "snapshot 2" }], 800, { tools, history, results, images: ["AAAA"] });
    const body = sent[0].body;
    assert.equal(body.system, "SYS");
    assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user"]);
    const tool = body.messages[1].content.find((b) => b.type === "tool_use");
    assert.deepEqual([tool.id, tool.name, tool.input], ["call_a", "find", { query: "phone" }]);
    const last = body.messages[2].content;
    assert.equal(last[0].type, "tool_result");
    assert.equal(last[0].tool_use_id, "call_a");
    assert.equal(last.at(-1).text, "snapshot 2");
    assert.ok(last.some((b) => b.type === "image"), "the screenshot rides on the last user message");
  });
});

test("without history the request is the plain two-message one", async () => {
  await withFetch({ choices: [{ message: { content: "hello" } }] }, async (sent) => {
    await completeTools({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m" }, [{ role: "system", content: "S" }, { role: "user", content: "U" }], 100, {});
    assert.deepEqual(sent[0].body.messages.map((m) => m.role), ["system", "user"]);
  });
});
