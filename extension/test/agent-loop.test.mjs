// Tests for src/agent/loop.js with a scripted driver (no browser) and a scripted platform.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeError } from "../src/bridge.js";
import { ProgressGuard, Agent, execute, explain, holdsTyped, observeTab, questionChoices, isEditingInstruction } from "../src/agent/loop.js";

test("recovery commands allow edits while questions and negations remain read-only", () => {
  for (const text of ["Recover this application using my saved profile", "Proceed with the edits", "Please remove the blank rows", " Clear the inaccurate title", "Go ahead", "Do the edits now"]) {
    assert.equal(isEditingInstruction(text), true, text);
  }
  for (const text of ["Can you see City?", "What would you change?", "Don't change anything", "Please do not edit", "Do not fill this", "Go away"]) {
    assert.equal(isEditingInstruction(text), false, text);
  }
});

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
      case "phoneTypePlan": return this.phonePlans?.shift() ?? null;
      case "committedValue": return this.committed ?? "Bengaluru, India";
      case "typedSuggestion": return this.suggestion ?? { ok: false };
      case "matchOption": return { ok: true, ref: "opt", text: "Bengaluru, India" };
      case "attach": this.calls.push(["attach-file", args[0], args[2]]); return { ok: true, value: args[2] };
      case "state": return { checked: false };
      case "shownChoices": return this.shown ?? [];
      case "pickerOpen": return this.pickerOpen ?? true;
      case "hasText": return (this.texts ?? []).includes(args[0]);
      default: throw new Error(`unexpected ${name}`);
    }
  }
}

test("execute select: reports what the widget shows and flags a click that did not stick", async () => {
  const driver = new FakeDriver({ top: () => frameObs([]) });
  const refs = new Map([["0.1", { frame: TOP, local: "1" }]]);
  const files = async () => null;
  driver.committed = "";
  const result = await execute(driver, refs, [TOP], { type: "select", ref: "0.1", text: "Bengaluru" }, files);
  assert.equal(result.verified, false);
  assert.equal(result.committed, "");
  assert.equal(result.matched, "Bengaluru, India");
});

test("execute select: a pick that does not read back is retried once and reported as it ends", async () => {
  class Late extends FakeDriver {
    reads = 0;
    async call(frame, name, ...args) {
      // The widget shows nothing for the first attempt's reads, then the pick on the second attempt.
      if (name === "committedValue") return ++this.reads <= 4 ? "" : "Bengaluru, India";
      return super.call(frame, name, ...args);
    }
  }
  const driver = new Late({ top: () => frameObs([]) });
  const refs = new Map([["0.1", { frame: TOP, local: "1" }]]);
  const result = await execute(driver, refs, [TOP], { type: "select", ref: "0.1", text: "Bengaluru" }, async () => null);
  assert.deepEqual(result, { matched: "Bengaluru, India", committed: "Bengaluru, India", verified: true });
  assert.equal(driver.calls.filter((c) => c[0] === "click").length >= 4, true, "opened and picked twice");
});

test("execute type: a phone box with a country selector picks the country, then types the national number", async () => {
  const driver = new FakeDriver({ top: () => frameObs([]) });
  driver.phonePlans = [
    { ok: false, needCountry: "+91", reason: "Choose +91 as the country first", countryRef: "c" },
    { ok: true, text: "6381868258", countryRef: "c" },
  ];
  driver.committed = "India";
  const refs = new Map([["0.1", { frame: TOP, local: "1" }]]);
  const result = await execute(driver, refs, [TOP], { type: "type", ref: "0.1", text: "+91 6381868258" }, async () => null);
  assert.ok(driver.calls.some((c) => c[0] === "insertText" && c[1] === "6381868258"));
  assert.equal(result.country, "India");
  assert.equal(result.matched, "6381868258");
});

test("resuming a paused run immediately reports running to the panel", () => {
  const updates = [];
  const agent = new Agent({ tabId: 1, driver: new FakeDriver({ top: () => frameObs([]) }),
    files: async () => null, notify: (update) => updates.push(update), report: async () => {},
    step: async () => ({}), controllerVersion: 2 });
  agent.pause();
  agent.resume();
  assert.equal(updates.at(-1).status, "running");
  agent.pause();
  agent.message("Proceed with edits");
  assert.equal(updates.at(-1).status, "running");
});

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

test("a protocol 2 screenshot changes nothing on the page: labels go into the image", async () => {
  const driver = new FakeDriver({
    top: () => frameObs([{ ref: "a", role: "textbox", name: "Name", bounds: [10, 20, 100, 30], in_viewport: true }]),
  });
  driver.canDrawLabels = true;
  let labels = null;
  driver.screenshot = async (given) => { labels = given; return "SHOT"; };
  const { observation } = await observeTab(driver, { screenshot: true, annotate: true, extended: true });
  assert.equal(observation.screenshot, "SHOT");
  assert.deepEqual(labels, [{ ref: "0.a", bounds: [10, 20, 100, 30] }]);
  const pageCalls = driver.calls.map(([name]) => name);
  for (const name of ["screenshotRefs", "clearScreenshotRefs", "snapshotState"]) assert.equal(pageCalls.includes(name), false, name);
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
  assert.deepEqual(await execute(driver, refs, frames, { type: "select", ref: "0.1", text: "Bengaluru" }, files),
    { matched: "Bengaluru, India", committed: "Bengaluru, India", verified: true });
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

test("execute: typing commits a matching typeahead suggestion instead of blurring away", async () => {
  const driver = new FakeDriver({ top: () => frameObs([]) });
  driver.suggestion = { ok: true, ref: "opt-9", text: "India" };
  const refs = new Map([["0.1", { frame: TOP, local: "1" }]]);
  await execute(driver, refs, [TOP], { type: "type", ref: "0.1", text: "India" }, async () => null);
  assert.deepEqual(driver.calls, [
    ["click", 10, 20], // focus the box
    ["insertText", "India"],
    ["click", 10, 20], // the suggestion that appeared
  ]);
});

test("execute: a masked input that drops inserted text is cleared and typed key by key", async () => {
  class MaskedDriver extends FakeDriver {
    async typeKeys(text) { this.calls.push(["typeKeys", text]); this.value = "+91 63818-68258"; }
    async call(frame, name, ...args) { return name === "state" ? { value: this.value } : super.call(frame, name, ...args); }
  }
  const driver = new MaskedDriver({ top: () => frameObs([]) });
  driver.value = "+91 "; // react-international-phone ignores the inserted string
  const refs = new Map([["0.1", { frame: TOP, local: "1" }]]);
  await execute(driver, refs, [TOP], { type: "type", ref: "0.1", text: "+91 6381868258" }, async () => null);
  assert.deepEqual(driver.calls, [
    ["click", 10, 20],
    ["insertText", "+91 6381868258"],
    ["press", "Backspace"], // the box's text was selected again before clearing
    ["typeKeys", "+91 6381868258"],
  ]);
  // A field that kept the inserted text is left alone.
  const kept = new MaskedDriver({ top: () => frameObs([]) });
  kept.value = "Ada";
  await execute(kept, refs, [TOP], { type: "type", ref: "0.1", text: "Ada" }, async () => null);
  assert.equal(kept.calls.some(([n]) => n === "typeKeys"), false);
});

test("holdsTyped reads through masks, separators and case", () => {
  assert.equal(holdsTyped("+91 63818-68258", "+91 6381868258"), true);
  assert.equal(holdsTyped("₹19,00,000", "1900000"), true);
  assert.equal(holdsTyped("+91 ", "+91 6381868258"), false);
  assert.equal(holdsTyped("+90 000 000 03", "+91 9000000003"), false);
  assert.equal(holdsTyped("Bengaluru ", "bengaluru"), true);
  assert.equal(holdsTyped("", "Ada"), false);
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

test("takeover discards a pending plan even if resumed before it returns", async () => {
  const driver = new FakeDriver({ top: () => frameObs([{ ref: "1", role: "button", name: "Next" }]) });
  let calls = 0;
  let agent;
  agent = new Agent({
    tabId: 1, appId: null, driver, files: {}, notify: () => {}, report: async () => {},
    step: async (req) => {
      if (++calls === 1) {
        agent.pause(); agent.resume();
        return { session_id: "test", status: "continue", actions: [{ type: "click", ref: "0.1" }] };
      }
      assert.equal(req.results[0].ok, false);
      assert.equal(req.observation.screenshot, "SHOT");
      return { session_id: "test", status: "ready_for_review", actions: [] };
    },
  });
  await agent.run();
  assert.equal(calls, 2);
  assert.equal(driver.calls.some(([name]) => name === "click"), false);
});

class V2Driver extends FakeDriver {
  async call(frame, name, ...args) {
    if (name === "freshState") return { document_id: this.documentId ?? "doc", user_edited: false, value: "" };
    if (name === "executionState" || name === "snapshotState") return;
    if (name === "hitTest") return true;
    return super.call(frame, name, ...args);
  }
}

for (const scenario of ["stale", "navigation", "message"]) test(`v2 rejects outdated plans: ${scenario}`, async () => {
  const driver = new V2Driver({ top: () => frameObs([{ ref: "1", role: "button", name: "Next" }], { document_id: "doc", viewport_width: 1000, viewport_height: 800 }) });
  let calls = 0;
  let agent;
  agent = new Agent({ tabId: 1, appId: null, driver, files: {}, notify: () => {}, report: async () => {}, controllerVersion: 2,
    step: async (req) => {
      if (++calls === 1) {
        if (scenario === "navigation") driver.documentId = "new-doc";
        if (scenario === "message") agent.message("Can you see City?");
        return { controller_version: 2, session_id: "s", status: "continue", actions: [{ type: "click", ref: "0.1", command_id: "c", observation_id: scenario === "stale" ? "stale" : req.observation.observation_id }] };
      }
      assert.equal(req.results[0].ok, false);
      if (scenario === "message") {
        assert.equal(req.user_message, "Can you see City?");
        assert.equal(req.inspect_only, true);
        assert.equal(req.observation.screenshot, "SHOT");
      }
      return { controller_version: 2, session_id: "s", status: "failed", actions: [] };
    },
  });
  await agent.run();
  assert.equal(calls, 2);
  assert.equal(driver.calls.some(([name]) => name === "click"), false);
});

test("v2 reports truncated observations explicitly", async () => {
  const driver = new V2Driver({ top: () => frameObs(Array.from({ length: 401 }, (_, i) => ({ ref: String(i), role: "button", name: "Next" })), { document_id: "doc" }) });
  const { observation } = await observeTab(driver, { extended: true });
  assert.equal(observation.elements.length, 400);
  assert.ok(observation.coverage.some((t) => /transport limit/.test(t)));
});

for (const approve of [false, true]) test(`v2 pauses on an unexpected origin; continue=${approve}`, async () => {
  const driver = new V2Driver({ top: () => frameObs([], { document_id: "doc" }) });
  let calls = 0;
  let agent;
  agent = new Agent({ tabId: 1, appId: null, driver, files: {}, report: async () => {}, controllerVersion: 2, startUrl: "https://original.example.test/job",
    notify: (message) => { if (message.status === "waiting") queueMicrotask(() => approve ? agent.resume() : agent.stop()); },
    step: async () => { calls += 1; return { session_id: "s", controller_version: 2, status: "failed", actions: [] }; },
  });
  await agent.run();
  assert.equal(calls, approve ? 1 : 0);
});


test("progress guard stops unchanged and cycling pages before more paid calls", () => {
  const guard = new ProgressGuard();
  const obs = (value) => frameObs([{ role: "textbox", name: "Name", value }]);
  for (let i = 0; i < 2; i++) assert.equal(guard.check({ ...obs(""), observation_id: String(i), screenshot: String(i) }), null);
  assert.match(guard.check(obs("")), /without progress/);
  guard.reset();
  // A pop-up that closes and reopens: two states taking turns.
  for (let i = 0; i < 4; i++) assert.equal(guard.check(obs(String(i % 2))), null);
  assert.match(guard.check(obs("0")), /without progress/);
  guard.reset();
  for (let i = 0; i < 40; i++) assert.equal(guard.check(obs(String(i))), null);
  assert.match(guard.check(obs("40")), /40-call safety limit/);
});

test("a step that only looked at the page is no stall", () => {
  const guard = new ProgressGuard();
  const same = frameObs([{ role: "textbox", name: "Name", value: "" }]);
  assert.equal(guard.check(same), null);
  for (let i = 0; i < 5; i++) {
    guard.noteReading(true); // a screenshot or review turn, then the same page again
    assert.equal(guard.check(same), null);
  }
  // Real inaction still stalls.
  assert.equal(guard.check(same), null);
  assert.match(guard.check(same), /without progress/);
});

test("a stall after failed fills asks the user instead of pausing", async () => {
  const driver = new FakeDriver({ top: () => frameObs([{ ref: "1", role: "textbox", name: "Describe a project" }], { document_id: "doc" }) });
  let calls = 0;
  const seen = [];
  const agent = new Agent({
    tabId: 4, controllerVersion: 2, driver, files: async () => null,
    notify: async (update) => {
      seen.push(update.status);
      if (update.status === "waiting") { agent.stop(); }
    },
    report: async () => {},
    step: async () => {
      calls += 1;
      return { controller_version: 2, session_id: "s", status: "continue", actions: [{ type: "bogus", label: "Describe a project", command_id: "c" + calls, observation_id: "stale" }] };
    },
  });
  await agent.run();
  assert.equal(seen.includes("paused"), false);
  assert.equal(seen.includes("waiting"), true);
  assert.match(agent.log.join("\n"), /couldn't fill: Describe a project/i);
});

test("ProgressGuard keeps the labels of the latest failed actions", () => {
  const guard = new ProgressGuard();
  guard.noteFailures(["a", "b", "c", "d"]);
  assert.deepEqual(guard.failures, ["a", "b", "c"]);
  guard.reset();
  assert.deepEqual(guard.failures, []);
});

test("v2 asks for help on a stalled run without issuing a third planning request", async () => {
  const driver = new FakeDriver({ top: () => frameObs([], { document_id: "doc" }) });
  let calls = 0;
  const seen = [];
  const agent = new Agent({
    tabId: 3, controllerVersion: 2, driver, files: async () => null,
    notify: async (update) => {
      seen.push(update.status);
      if (update.status === "waiting") agent.stop();
    },
    report: async () => {},
    step: async () => {
      calls += 1;
      return { controller_version: 2, session_id: "s", status: "continue", actions: [] };
    },
  });
  await agent.run();
  assert.equal(calls, 2);
  assert.equal(seen.includes("paused"), false);
  assert.equal(seen.includes("waiting"), true);
  assert.match(agent.log.join("\n"), /not getting any further/i);
  assert.equal(driver.calls.at(-1)[0], "detach");
});

test("a dropdown with no match is closed with Escape only when its own list is open", async () => {
  class NoMatch extends FakeDriver {
    async call(frame, name, ...args) {
      if (name === "matchOption") return { ok: false, options: [] };
      if (name === "focusForTyping") return { ok: true, mode: "direct" };
      if (name === "scrollOptions") return false;
      return super.call(frame, name, ...args);
    }
  }
  const driver = new NoMatch({ top: () => frameObs([{ ref: "1", role: "combobox", name: "Country" }], { dialog: "Apply to Acme" }) });
  const { refs, frames } = await observeTab(driver);
  driver.pickerOpen = false; // the list never opened: Escape would close the Apply dialog
  await assert.rejects(execute(driver, refs, frames, { type: "select", ref: "0.1", text: "India" }, async () => null), /No option matches/);
  assert.equal(driver.calls.some((c) => c[0] === "press"), false);
  driver.pickerOpen = true;
  await assert.rejects(execute(driver, refs, frames, { type: "select", ref: "0.1", text: "India" }, async () => null), /No option matches/);
  assert.deepEqual(driver.calls.filter((c) => c[0] === "press"), [["press", "Escape"]]);
});

test("select retries once when the first open shows no options, and opens the list again if it closed", async () => {
  class Slow extends FakeDriver {
    asked = 0;
    async call(frame, name, ...args) {
      if (name === "matchOption") return ++this.asked < 4 ? { ok: false, options: [] } : { ok: true, ref: "opt", text: "India +91" };
      if (name === "pickerOpen") return false;
      if (name === "scrollOptions") return false;
      return super.call(frame, name, ...args);
    }
  }
  const driver = new Slow({ top: () => frameObs([{ ref: "1", role: "combobox", name: "Country" }]) });
  driver.committed = "India +91";
  const { refs, frames } = await observeTab(driver);
  const result = await execute(driver, refs, frames, { type: "select", ref: "0.1", text: "India" }, async () => null);
  assert.deepEqual(result, { matched: "India +91", committed: "India +91", verified: true });
  assert.equal(driver.calls.filter((c) => c[0] === "click").length >= 3, true, "opened, re-opened, then clicked the option");
});

test("search text left in a combobox is not a pick: the key fallback needs the widget to show it", async () => {
  class Typed extends FakeDriver {
    async call(frame, name, ...args) {
      if (name === "matchOption") return { ok: false, options: [] };
      if (name === "scrollOptions") return false;
      if (name === "prepareKey") return true;
      if (name === "typedText") return "Yes";
      if (name === "committedValue") return args[1] ? (this.widgetShows ?? "") : "Yes";
      return super.call(frame, name, ...args);
    }
  }
  const driver = new Typed({ top: () => frameObs([{ ref: "1", role: "combobox", name: "Reference calls" }]) });
  const { refs, frames } = await observeTab(driver);
  await assert.rejects(execute(driver, refs, frames, { type: "select", ref: "0.1", text: "Yes" }, async () => null), /No option matches/);
  driver.widgetShows = "Yes";
  const ok = await execute(driver, refs, frames, { type: "select", ref: "0.1", text: "Yes" }, async () => null);
  assert.equal(ok.verified, true);
});

test("no option matches and nothing was typed: the first entry of the open menu is never pressed", async () => {
  class Unfiltered extends FakeDriver {
    async call(frame, name, ...args) {
      if (name === "matchOption") return { ok: false, options: [] };
      if (name === "scrollOptions") return false;
      if (name === "prepareKey") return true;
      if (name === "typedText") return ""; // the menu is open but unfiltered
      if (name === "committedValue") return "";
      return super.call(frame, name, ...args);
    }
  }
  const driver = new Unfiltered({ top: () => frameObs([{ ref: "1", role: "combobox", name: "Disability" }]) });
  const { refs, frames } = await observeTab(driver);
  await assert.rejects(execute(driver, refs, frames, { type: "select", ref: "0.1", text: "I don't wish to answer" }, async () => null), /No option matches/);
  assert.equal(driver.calls.some((c) => c[0] === "press" && (c[1] === "ArrowDown" || c[1] === "Enter")), false);
});

test("a wrong entry that took the Enter is taken back and reported", async () => {
  class Wrong extends FakeDriver {
    shown = "";
    async press(key) { await super.press(key); if (key === "Enter") this.shown = "Yes, I have a disability"; if (key === "Backspace") this.shown = ""; }
    async call(frame, name, ...args) {
      if (name === "matchOption") return { ok: false, options: [] };
      if (name === "scrollOptions") return false;
      if (name === "prepareKey") return true;
      if (name === "typedText") return "I don't wish to answer";
      if (name === "committedValue") return this.shown;
      return super.call(frame, name, ...args);
    }
  }
  const driver = new Wrong({ top: () => frameObs([{ ref: "1", role: "combobox", name: "Disability" }]) });
  const { refs, frames } = await observeTab(driver);
  await assert.rejects(execute(driver, refs, frames, { type: "select", ref: "0.1", text: "I don't wish to answer" }, async () => null), /No option matches/);
  assert.equal(driver.shown, "", "the wrong pick was cleared");
  assert.equal(driver.calls.some((c) => c[0] === "press" && c[1] === "Backspace"), true);
});

test("check reads the box back, falls back to activating it, and flags one that will not tick", async () => {
  class Box extends FakeDriver {
    constructor(opts, behaviour) { super(opts); this.behaviour = behaviour; this.on = false; }
    async click(x, y) { await super.click(x, y); if (this.behaviour === "click") this.on = true; }
    async call(frame, name, ...args) {
      if (name === "state") return { checked: this.on };
      if (name === "activate") { if (this.behaviour === "activate") this.on = true; return true; }
      return super.call(frame, name, ...args);
    }
  }
  const run = async (behaviour, checked = true) => {
    const driver = new Box({ top: () => frameObs([{ ref: "1", role: "checkbox", name: "Asian" }]) }, behaviour);
    const { refs, frames } = await observeTab(driver);
    return { driver, result: await execute(driver, refs, frames, { type: "check", ref: "0.1", checked }, async () => null) };
  };
  assert.equal((await run("click")).result.verified, true);
  const viaActivate = await run("activate");
  assert.equal(viaActivate.result.verified, true);
  assert.equal(viaActivate.driver.calls.filter((c) => c[0] === "click").length, 1);
  assert.deepEqual(await run("never").then((r) => [r.result.checked, r.result.verified]), [false, false]);
  // Already in the wanted state: no click.
  const same = await run("click", false);
  assert.equal(same.result.verified, true);
  assert.equal(same.driver.calls.some((c) => c[0] === "click"), false);
});

test("hover, drag and wait_for", async () => {
  class Pointer extends FakeDriver {
    async hover(x, y) { this.calls.push(["hover", x, y]); }
    async drag(from, to) { this.calls.push(["drag", from, to]); }
  }
  const driver = new Pointer({ top: () => frameObs([{ ref: "1", role: "button", name: "Menu" }, { ref: "2", role: "listbox", name: "Order" }]) });
  const { refs, frames } = await observeTab(driver);
  await execute(driver, refs, frames, { type: "hover", ref: "0.1" }, async () => null);
  await execute(driver, refs, frames, { type: "drag", ref: "0.2", to_ref: "0.1" }, async () => null);
  assert.deepEqual(driver.calls.map((c) => c[0]), ["hover", "drag"]);
  driver.texts = ["Upload complete"];
  assert.equal(await execute(driver, refs, frames, { type: "wait_for", text: "Upload complete", ms: 500 }, async () => null), null);
  await assert.rejects(execute(driver, refs, frames, { type: "wait_for", text: "Never shown", ms: 300 }, async () => null), /did not appear/);
});

test("a browser dialog is handed to the user and the run resumes when it closes, without a model call", async () => {
  const driver = new FakeDriver({ top: () => frameObs([{ ref: "1", role: "textbox", name: "Name" }]) });
  let closeDialog;
  driver.dialog = { type: "confirm", message: "Leave site?" };
  driver.dialogClosed = () => new Promise((resolve) => { closeDialog = () => { driver.dialog = null; resolve(); }; });
  const updates = [];
  let steps = 0;
  const agent = new Agent({
    tabId: 3, driver, files: async () => null, report: async () => {},
    notify: async (update) => {
      updates.push(update);
      if (update.question?.kind === "blocker") setTimeout(() => closeDialog(), 10);
    },
    step: async () => {
      steps += 1;
      agent.stop();
      return { session_id: "s", status: "continue", actions: [] };
    },
  });
  await agent.run();
  const blocker = updates.find((u) => u.question?.kind === "blocker");
  assert.match(blocker.question.text, /Leave site\?.*Answer it yourself/);
  assert.equal(steps, 1); // one decision, after the dialog closed; none while it was open
});
