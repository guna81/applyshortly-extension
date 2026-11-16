// Tier 0, loop level: what the Agent does when the provider fails, the page stalls or the model keeps talking.
// Scripted driver, no browser, no AI. `todo` = wanted behavior of a known bug (Phase C); it reports but does not fail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/bridge.js";
import { Agent, ProgressGuard } from "../src/agent/loop.js";
import { FakeDriver, frameObs } from "./replay/fake-driver.mjs";

const stuck = () => ({ top: () => frameObs([{ ref: "n", role: "textbox", name: "Name", value: "" }]) });
const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run an agent whose planning step throws `error`; resolves with the status it reached after a moment. */
async function runWith(error, planner) {
  const updates = [];
  const agent = new Agent({
    tabId: 1, appId: 1, driver: new FakeDriver(stuck()), files: async () => null, report: async () => {},
    notify: async (message) => { updates.push(message); },
    step: async () => { throw error; },
  });
  agent.planner = planner;
  const run = agent.run();
  const deadline = Date.now() + 8000;
  while (!["paused", "failed", "stopped"].includes(agent.status) && Date.now() < deadline) await flush();
  const status = agent.status;
  const log = [...agent.log];
  if (status === "paused") { agent.stop("test over"); }
  await run;
  return { status, log, updates };
}

// What custom-ai.js throws for an HTTP error: the message names the status and the Error carries it.
const providerError = (status) => Object.assign(new Error(`AI provider returned HTTP ${status}. Check your endpoint, key and model.`), { status });

test("recovery: a platform 502 pauses the run for Resume with the request kept (not failed)", async () => {
  const { status, log } = await runWith(new BridgeError(502, "Bad Gateway"), "platform");
  assert.equal(status, "paused");
  assert.match(log.join("\n"), /temporarily unavailable/);
});

test("recovery: a custom or local provider 502 pauses the run for Resume (not failed)", async () => {
  const { status, log } = await runWith(providerError(502), "custom");
  assert.equal(status, "paused", `ended ${status}: ${log.at(-1)}`);
  assert.match(log.join("\n"), /AI provider (?:is )?unavailable|temporarily unavailable/i);
});

test("recovery: a custom provider network error (offline, timeout) pauses the run (not failed)", async () => {
  const { status, log } = await runWith(new TypeError("fetch failed"), "custom");
  assert.equal(status, "paused", `ended ${status}: ${log.at(-1)}`);
});

test("recovery: a provider quota error (429) pauses the run (not failed)", async () => {
  const { status, log } = await runWith(providerError(429), "custom");
  assert.equal(status, "paused", `ended ${status}: ${log.at(-1)}`);
});

test("stall: the same page three times asks for help instead of spending more calls", () => {
  const guard = new ProgressGuard();
  const obs = { url: "https://jobs.example/apply", dialog: null, text: "Apply", errors: [], blockers: [], elements: [{ role: "textbox", name: "Name", value: "" }] };
  assert.equal(guard.check(obs), null);
  assert.equal(guard.check(obs), null);
  assert.match(guard.check(obs), /without progress/);
});

test("stall: a run that keeps making progress is stopped only by the call limit", () => {
  const guard = new ProgressGuard();
  let message = null;
  for (let i = 0; i < 41 && !message; i += 1) message = guard.check({ url: "u", dialog: null, text: String(i), errors: [], blockers: [], elements: [] });
  assert.match(message, /safety limit/);
});
