import assert from "node:assert/strict";
import { test } from "node:test";
import { modelBody } from "../src/shared/model-turn.js";

const turn = { session_id: "s", messages: [{ role: "system", content: "x" }, { role: "user", content: "y" }] };

test("a call without a look is the plain turn", () => {
  assert.equal(modelBody(turn, undefined), turn);
});

test("history, results, js and tool names travel with the call; screenshots are capped at three", () => {
  const body = modelBody(turn, { images: ["a", "b", "c", "d"], native_tools: true, history: [{ role: "assistant", text: "", calls: [] }], results: [{ id: "c1", content: "ok" }], allow_js: true, tool_names: ["find"] });
  assert.deepEqual(body.images, ["a", "b", "c"]);
  assert.equal(body.native_tools, true);
  assert.equal(body.history.length, 1);
  assert.equal(body.results[0].id, "c1");
  assert.equal(body.allow_js, true);
  assert.deepEqual(body.tool_names, ["find"]);
});

test("unused fields are left out so an older platform is not sent what it does not know", () => {
  const body = modelBody(turn, { images: [], native_tools: true });
  assert.deepEqual(Object.keys(body).sort(), ["messages", "native_tools", "session_id"]);
});
