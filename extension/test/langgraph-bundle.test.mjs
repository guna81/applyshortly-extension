// Added 2026-11-18. The Agent based form assistant agent runs on LangGraph JS (npm). src/agent-based/langgraph.js is a one-line re-export that Node
// resolves from node_modules in tests; scripts/build_extension.py replaces it with one bundled ES module in the package,
// because a Chrome extension loads plain files and cannot resolve node_modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pinned = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).devDependencies["@langchain/langgraph"];

test("LangGraph is pinned exactly and its notice names that version and license", () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/, "pin an exact version, not a range");
  const text = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.ok(text.includes(`@langchain/langgraph | ${pinned}`), "THIRD_PARTY_NOTICES.md must list the pinned version");
  assert.match(text, /MIT License/);
});

test("a small graph runs: tool loop, stop at a question, resume with the answer from plain state", async () => {
  const { StateGraph, Annotation, START, END } = await import("../src/agent-based/langgraph.js");
  const State = Annotation.Root({ messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) });
  const script = [{ calls: [{ id: "c1", name: "find" }] }, { calls: [{ id: "c2", name: "ask_user" }] }, { calls: [{ id: "c3", name: "done" }] }];
  let turn = 0;
  const graph = new StateGraph(State)
    .addNode("model", async () => ({ messages: [{ role: "assistant", ...script[turn++] }] }))
    .addNode("tools", async (s) => ({ messages: s.messages.at(-1).calls.map((c) => ({ role: "tool", id: c.id, content: `ok ${c.name}` })) }))
    .addEdge(START, "model")
    .addConditionalEdges("model", (s) => (s.messages.at(-1).calls.some((c) => ["ask_user", "done"].includes(c.name)) ? END : "tools"), ["tools", END])
    .addEdge("tools", "model")
    .compile();
  const first = await graph.invoke({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(first.messages.at(-1).calls[0].name, "ask_user");
  // The agent keeps its own state as plain JSON (saved to chrome.storage.session), so a new run starts from it.
  const saved = JSON.parse(JSON.stringify(first.messages));
  const second = await graph.invoke({ messages: [...saved, { role: "tool", id: "c2", content: "555-0100" }] });
  assert.equal(second.messages.at(-1).calls[0].name, "done");
  assert.equal(second.messages.some((m) => m.content === "555-0100"), true);
});
