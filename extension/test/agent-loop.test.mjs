// Tests for src/agent/loop.js with a scripted driver (no browser) and a scripted platform.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/bridge.js";
import { Agent, execute, explain, observeTab, questionChoices } from "../src/agent/loop.js";

const TOP = { frameId: "top", isTop: true, parentId: null };
const FRAME = { frameId: "child", isTop: false, parentId: "top", sessionId: "oopif" };

function frameObs(elements, extra = {}) {
  return { url: "https://careers.example.com/apply", title: "Apply", dialog: null, blockers: [], errors: [], text: "", elements, more_below: false, ...extra };
}

class FakeDriver {
  constructor({ top, child = null, refuse = new Set() }) {
    this.pages = { top, child };
    this.refuse = refuse;
    this.calls = [];
  }
  async attach() { this.calls.push(["attach"]); }
  async detach() { this.calls.push(["detach"]); }
  async frames() { return this.pages.child ? [TOP, FRAME] : [TOP]; }
  async offset(frame) { return frame.isTop ? { x: 0, y: 0 } : { x: 100, y: 200 }; }
  async inDialog() { return this.frameInDialog ?? false; }
  async click(x, y) { this.calls.push(["click", x, y]); }
  async insertText(text) { this.calls.push(["insertText", text]); }
  async press(key) { this.calls.push(["press", key]); }
  async screenshot() { return "SHOT"; }
  async call(frame, name, ...args) {
    switch (name) {
      case "observe": return frame.isTop ? this.pages.top() : this.pages.child?.();
      case "settle": return "complete";
      case "clickable": return this.refuse.has(args[0]) ? "Submitting is left to you." : null;
      case "box": return { x: 10, y: 20, width: 40, height: 20 };
      case "focusForTyping": return { ok: true, mode: "keys" };
      case "blur": return true;
      case "selectNative": return { native: false };
      case "noteShown": return true;
      case "matchOption": return { ok: true, ref: "opt", text: "Bengaluru, India" };
      case "attach": this.calls.push(["attach-file", args[0], args[2]]); return { ok: true, value: args[2] };
      case "state": return { checked: false };
      case "shownChoices": return this.shown ?? [];
      default: throw new Error(`unexpected ${name}`);
    }
  }
}

test("observeTab merges frames with prefixed refs, and an open modal hides the rest", async () => {
  const driver = new FakeDriver({
    top: () => frameObs([{ ref: "1", role: "textbox", name: "First name" }]),
    child: () => frameObs([{ ref: "1", role: "button", name: "Next" }], { blockers: ["captcha"], text: "Step 1" }),
  });
  const { observation, refs } = await observeTab(driver, { screenshot: true });
  assert.deepEqual(observation.elements.map((e) => [e.ref, e.name]), [["0.1", "First name"], ["1.1", "Next"]]);
  assert.deepEqual(observation.blockers, ["captcha"]);
  assert.equal(observation.screenshot, "SHOT");
  assert.equal(refs.get("1.1").frame, FRAME);

  driver.pages.top = () => frameObs([{ ref: "2", role: "button", name: "Close" }], { dialog: "Apply to Acme" });
  const modal = await observeTab(driver);
  assert.deepEqual(modal.observation.elements.map((e) => e.name), ["Close"]);
  assert.equal(modal.observation.screenshot, undefined);
  driver.frameInDialog = true; // an ATS iframe inside the "Apply" modal
  const embedded = await observeTab(driver);
  assert.deepEqual(embedded.observation.elements.map((e) => e.name), ["Close", "Next"]);
});

test("Agent stops an action batch on failure and returns to observation", async () => {
  const driver = new FakeDriver({ top: () => frameObs([{ ref: "n", role: "textbox", name: "Name" }]) });
  const bodies = [];
  const agent = new Agent({
    tabId: 3, driver, files: async () => null, notify: async () => {}, report: async () => {},
    step: async (body) => {
      bodies.push(structuredClone(body));
      return bodies.length === 1
        ? { session_id: "s", status: "continue", actions: [
          { type: "click", ref: "stale" }, { type: "type", ref: "0.n", text: "must not run" },
        ] }
        : { session_id: "s", status: "failed", actions: [] };
    },
  });
  await agent.run();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].results, [{ index: 0, ok: false, detail: "That element is no longer on the page." }]);
  assert.equal(driver.calls.some(([name]) => name === "insertText"), false);
});

test("requested ref overlays are removed from every frame even if capture fails", async () => {
  const driver = new FakeDriver({
    top: () => frameObs([{ ref: "a", role: "textbox", name: "Name" }]),
    child: () => frameObs([{ ref: "b", role: "textbox", name: "Email" }]),
  });
  const original = driver.call.bind(driver);
  driver.call = async (frame, name, ...args) => {
    if (name === "screenshotRefs" || name === "clearScreenshotRefs") {
      driver.calls.push([name, frame.frameId, args[0]]);
      return;
    }
    return original(frame, name, ...args);
  };
  driver.screenshot = async () => { throw new Error("capture unavailable"); };
  const { observation } = await observeTab(driver, { screenshot: true, annotate: true });
  assert.equal(observation.screenshot, undefined);
  assert.deepEqual(driver.calls.map(([name, frame]) => [name, frame]), [
    ["screenshotRefs", "top"], ["screenshotRefs", "child"],
    ["clearScreenshotRefs", "top"], ["clearScreenshotRefs", "child"],
  ]);
  assert.deepEqual(driver.calls[0][2], [{ ref: "0.a", local: "a" }]);
});

test("execute: trusted clicks offset into frames, typing, typeahead picks, uploads and refusals", async () => {
  const driver = new FakeDriver({ top: () => frameObs([]) });
  const refs = new Map([
    ["0.1", { frame: TOP, local: "1" }],
    ["1.1", { frame: FRAME, local: "1" }],
    ["0.9", { frame: TOP, local: "9" }],
  ]);
  const frames = [TOP, FRAME];
  const files = async (kind) => (kind === "resume" ? { name: "Ada_Resume.pdf", type: "application/pdf", base64: "JVBERg==" } : null);
  await execute(driver, refs, frames, { type: "type", ref: "0.1", text: "Ada" }, files);
  await execute(driver, refs, frames, { type: "click", ref: "1.1" }, files);
  assert.equal(await execute(driver, refs, frames, { type: "select", ref: "0.1", text: "Bengaluru" }, files), "Bengaluru, India");
  assert.equal(await execute(driver, refs, frames, { type: "upload", ref: "0.1", file: "resume" }, files), "Ada_Resume.pdf");
  await assert.rejects(execute(driver, refs, frames, { type: "upload", ref: "0.1", file: "cover_letter" }, files), /No cover letter/);
  driver.refuse.add("9");
  await assert.rejects(execute(driver, refs, frames, { type: "click", ref: "0.9" }, files), /left to you/);
  await assert.rejects(execute(driver, refs, frames, { type: "click", ref: "7.7" }, files), /no longer on the page/);
  assert.deepEqual(driver.calls, [
    ["click", 10, 20], ["insertText", "Ada"],
    ["click", 110, 220],
    ["click", 10, 20], ["click", 10, 20], // open the dropdown, then its option
    ["attach-file", "1", "Ada_Resume.pdf"],
  ]);
});

test("Agent: acts, asks the user, and stops at review without submitting", async () => {
  const driver = new FakeDriver({ top: () => frameObs([{ ref: "1", role: "textbox", name: "Notice period" }, { ref: "2", role: "button", name: "Next" }]) });
  const bodies = [];
  const responses = [
    { session_id: "s1", status: "continue", actions: [{ type: "type", ref: "0.1", text: "30 days", label: "Filled Notice period" }, { type: "click", ref: "0.5", label: "Clicked Gone" }] },
    { session_id: "s1", status: "ask_user", actions: [], question: { kind: "question", text: "Why Acme?" }, message: "Waiting for your answer" },
    { session_id: "s1", status: "ready_for_review", actions: [], filled: [{ label: "Notice period", value: "30 days", source: "answer_bank", needs_review: false }], unresolved: [], message: "Ready" },
  ];
  const updates = [];
  const reports = [];
  let agent;
  agent = new Agent({
    tabId: 3,
    appId: 9,
    driver,
    step: async (body) => {
      bodies.push(structuredClone(body));
      const res = responses.shift();
      if (res.status === "ask_user") setTimeout(() => agent.reply("I love the product"), 10);
      return res;
    },
    files: async () => null,
    notify: async (m) => updates.push(m),
    report: async (event, res, url) => reports.push([event, res.status, url]),
  });
  await agent.run();
  assert.equal(agent.status, "ready");
  assert.deepEqual(bodies.map((b) => [b.session_id, b.results, b.user_reply ?? null]), [
    [null, [], null],
    ["s1", [{ index: 0, ok: true }, { index: 1, ok: false, detail: "That element is no longer on the page." }], null],
    ["s1", [], "I love the product"],
  ]);
  assert.equal(bodies[0].in_user_tab, true);
  assert.equal(bodies[0].application_id, 9);
  assert.deepEqual(reports, [["filled", "ready_for_review", "https://careers.example.com/apply"]]);
  assert.ok(updates.some((u) => u.status === "waiting" && u.question?.text === "Why Acme?"));
  assert.deepEqual(driver.calls.at(0), ["attach"]);
  assert.deepEqual(driver.calls.at(-1), ["detach"]);
});

test("Agent: stop while waiting ends the run and detaches; closing the debug bar stops it too", async () => {
  const driver = new FakeDriver({ top: () => frameObs([]) });
  let agent;
  agent = new Agent({
    tabId: 1, appId: null, driver,
    step: async () => {
      setTimeout(() => driver.onDetached("canceled_by_user"), 10);
      return { session_id: "s", status: "ask_user", actions: [], question: { kind: "blocker", text: "Solve the CAPTCHA" } };
    },
    files: async () => null, notify: async () => {}, report: async () => { throw new Error("no report on a user stop"); },
  });
  await agent.run();
  assert.equal(agent.status, "stopped");
  assert.match(agent.log.at(-1), /debugging bar/);
  assert.deepEqual(driver.calls.at(-1), ["detach"]);
});

test("Agent: a platform without the agent says so and records no failure", async () => {
  const driver = new FakeDriver({ top: () => frameObs([]) });
  const updates = [];
  const reports = [];
  const agent = new Agent({
    tabId: 2, appId: 5, driver,
    step: async () => { throw new BridgeError(404, "Not Found"); },
    files: async () => null,
    notify: async (m) => updates.push(m),
    report: async (...args) => reports.push(args),
  });
  await agent.run();
  assert.equal(agent.status, "failed");
  assert.match(updates.at(-1).message, /doesn't have the form agent yet/);
  assert.deepEqual(reports, []);
  assert.deepEqual(driver.calls.at(-1), ["detach"]);
  // A real 404 from the handler keeps its own words.
  assert.equal(explain(new BridgeError(404, "Application not found")), "Application not found");
  assert.match(explain(new BridgeError(410, "gone")), /Run the agent again/);
});

test("questionChoices: radio groups, listed options, and a dropdown opened once to read its list", async () => {
  const driver = new FakeDriver({ top: () => frameObs([
    { ref: "1", role: "radio", name: "Yes", group: "Relocate?" },
    { ref: "2", role: "radio", name: "No", group: "Relocate?" },
    { ref: "3", role: "combobox", name: "Gender", options: ["Male", "Female"] },
    { ref: "4", role: "combobox", name: "First Name (salutation)", options: [] },
    { ref: "5", role: "textbox", name: "Why us?" },
  ]) });
  driver.shown = ["Mr.", "Mrs.", "Ms."];
  const { observation, refs, frames } = await observeTab(driver);
  const ask = (ref) => questionChoices(driver, refs, frames, observation, { kind: "question", text: "?", ref });
  assert.deepEqual(await ask("g0:0.1"), ["Yes", "No"]);
  assert.deepEqual(await ask("0.3"), ["Male", "Female"]);
  assert.deepEqual(driver.calls.filter((c) => c[0] === "click"), []);
  assert.deepEqual(await ask("0.4"), ["Mr.", "Mrs.", "Ms."]);
  assert.deepEqual(driver.calls.map((c) => c[0]), ["click", "press"]);
  assert.deepEqual(await ask("0.5"), []);
  assert.deepEqual(await ask(null), []);
});

test("Agent: a CAPTCHA hands the form to the user without asking the platform, then continues once", async () => {
  let captcha = true;
  const driver = new FakeDriver({ top: () => frameObs([{ ref: "1", role: "textbox", name: "Email" }], { blockers: captcha ? ["captcha"] : [] }) });
  const bodies = [];
  const updates = [];
  let agent;
  agent = new Agent({
    tabId: 4, appId: 9, driver,
    step: async (body) => {
      bodies.push(structuredClone(body));
      return { session_id: "s", status: "ready_for_review", actions: [], filled: [], unresolved: [] };
    },
    files: async () => null,
    notify: async (m) => {
      updates.push(m);
      // The user solves it (the solved widget stays on the page) and taps Continue.
      if (m.status === "waiting") setTimeout(() => agent.resume(), 10);
    },
    report: async () => {},
  });
  await agent.run();
  const waiting = updates.filter((u) => u.status === "waiting");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].question.kind, "blocker");
  assert.match(waiting[0].question.text, /CAPTCHA/);
  // Nothing reached the platform until the user said it was done.
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].resumed, true);
  assert.equal(agent.status, "ready");
});
