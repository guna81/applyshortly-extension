// Tests for src/agent/commands.js: the guarded, verified commands every controller shares.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE, isPageRule } from "./page-rules.mjs";
import { CommandRunner, driftOf, readinessOf, scanFields } from "../src/agent/commands.js";
import { Agent } from "../src/agent/loop.js";

const TOP = { frameId: "top", isTop: true, parentId: null };

/** A form whose controls get new local refs on every observation, as a site that re-mounts does. */
function makeDriver({ names = ["First", "Last", "Email"], blockers = [], userEdited = new Set(), extra = {}, remount = true, readBack = true } = {}) {
  const values = {};
  const typed = [];
  let generation = 0;
  const page = () => ({
    url: "https://fixture.example/apply", title: "Apply", dialog: null, blockers, errors: [], text: "page text", more_below: false, document_id: "doc",
    elements: names.map((name, i) => ({ ref: String(generation * 10 + i + 1), role: "textbox", name, input_type: name === "Secret" ? "password" : "text", value: values[name] ?? "", required: true, ...(userEdited.has(name) && values[name] ? { user_edited: true } : {}), ...(extra[name] ?? {}) })),
  });
  const driver = {
    tabId: 9, typed, values,
    async attach() {}, async detach() {},
    async frames() { return [TOP]; },
    async offset() { return { x: 0, y: 0 }; },
    async click() {},
    async call(frame, name, ...args) {
      switch (name) {
        case "observe": if (remount || !generation) generation++; this.map = new Map(page().elements.map((e) => [e.ref, e.name])); return page();
        case "freshState": return { document_id: "doc", present: args[0] === "" || this.map.has(args[0]), user_edited: userEdited.has(this.map.get(args[0])), value: values[this.map.get(args[0])] ?? "" };
        case "clickable": return null;
        case "box": return { x: 1, y: 1, width: 5, height: 5 };
        case "focusForTyping": return { ok: true, mode: "direct" };
        case "setDirect": values[this.map.get(args[0])] = args[1]; typed.push([this.map.get(args[0]), args[1]]); return { ok: true };
        case "committedValue": return readBack ? values[this.map.get(args[0])] ?? "" : null; // null: the page cannot say
        case "blur": return true;
        case "settle": return "complete";
        case "hitTest": return true;
        case "snapshotState": case "executionState": return undefined;
        default: if (isPageRule(name)) return PAGE[name](...args); throw new Error(`unexpected ${name}`);
      }
    },
  };
  return driver;
}

const read = async (driver, policy = {}) => {
  const runner = new CommandRunner({ driver, policy });
  await runner.observe();
  return runner;
};
const refsOf = (runner) => Object.fromEntries(runner.observed.observation.elements.map((e) => [e.name, e.ref]));

test("fill_form writes every field from the first observation's refs and reports each one", async () => {
  const driver = makeDriver();
  const committed = [];
  const runner = await read(driver, { onCommitted: (name, value) => committed.push([name, value]) });
  const refs = refsOf(runner);
  const first = runner.observed.observation.observation_id;
  const out = await runner.fillForm([{ ref: refs.First, text: "Guna" }, { ref: refs.Last, text: "P" }, { ref: refs.Email, text: "g@x.y" }], { observationId: first, commandId: "c1" });
  assert.deepEqual(driver.typed, [["First", "Guna"], ["Last", "P"], ["Email", "g@x.y"]]);
  assert.equal(out.done, 3);
  assert.equal(out.requested_count, 3);
  assert.deepEqual(out.fields.map((f) => f.ok), [true, true, true]);
  assert.equal(committed.length, 3);
});

test("fill_form types a text entry the platform sends with checked: null (it is not a checkbox)", async () => {
  const driver = makeDriver();
  const runner = await read(driver);
  const refs = refsOf(runner);
  const out = await runner.fillForm([{ ref: refs.First, text: "Guna", checked: null }, { ref: refs.Last, text: "P", checked: null }],
    { observationId: runner.observed.observation.observation_id, commandId: "c-null" });
  assert.deepEqual(driver.typed, [["First", "Guna"], ["Last", "P"]]);
  assert.deepEqual(out.fields.map((f) => f.type), ["type", "type"]);
  assert.equal(out.done, 2);
});

/** After `Email` is written, `First` is reset to `reset` (as a later dropdown moves an earlier phone country). */
function undoingDriver(reset, { sticky = false } = {}) {
  const driver = makeDriver();
  const call = driver.call.bind(driver);
  let emailWritten = false;
  driver.call = async (frame, name, ...args) => {
    const out = await call(frame, name, ...args);
    if (name === "setDirect") {
      const who = driver.map.get(args[0]);
      if (who === "Email") { emailWritten = true; driver.values.First = reset; }
      else if (who === "First" && emailWritten && sticky) driver.values.First = reset;
    }
    return out;
  };
  return driver;
}

test("a field a later one undid is written once more, and the batch still counts it", async () => {
  const driver = undoingDriver("+93 changed");
  const runner = await read(driver);
  const refs = refsOf(runner);
  const out = await runner.fillForm([{ ref: refs.First, text: "Guna" }, { ref: refs.Email, text: "g@x.y" }],
    { observationId: runner.observed.observation.observation_id, commandId: "c-undo" });
  assert.equal(out.done, 2);
  assert.equal(driver.values.First, "Guna");
  assert.deepEqual(driver.typed.filter(([n]) => n === "First").map(([, v]) => v), ["Guna", "Guna"]);
});

test("a field that keeps changing is reported as not stuck, naming what it shows", async () => {
  const driver = undoingDriver("+93 changed", { sticky: true });
  const runner = await read(driver);
  const refs = refsOf(runner);
  const out = await runner.fillForm([{ ref: refs.First, text: "Guna" }, { ref: refs.Email, text: "g@x.y" }],
    { observationId: runner.observed.observation.observation_id, commandId: "c-undo2" });
  assert.equal(out.done, 1);
  assert.equal(out.fields[0].ok, false);
  assert.equal(out.fields[0].verified, false);
  assert.match(out.fields[0].detail, /later field changed this one.*\+93 changed/);
});

test("a phone number is checked against its country selector's dial code", () => {
  const phone = { ref: "p", name: "Phone", role: "textbox", input_type: "tel", section: "Phone", value: "+91 6381868258" };
  const country = (value) => ({ ref: "c", name: "Country", role: "textbox", popup: true, section: "Phone", value });
  const result = { type: "type", requested: "+91 6381868258", committed: "+91 6381868258" };
  const field = { ref: "p", text: "+91 6381868258" };
  assert.equal(driftOf(result, field, phone, [country("+91"), phone]), "");
  assert.match(driftOf(result, field, phone, [country("+93"), phone]), /country shows \+93/);
  assert.equal(driftOf(result, field, phone, [country(""), phone]), ""); // no code shown: nothing to judge
  // a dropdown that reads back empty is not judged; a plain box that went empty is
  const box = { ref: "b", name: "Years", role: "textbox", popup: true, value: "" };
  assert.equal(driftOf({ type: "select", requested: "7-10 years", committed: "7-10 years" }, { ref: "b", text: "7-10 years" }, box, [box]), "");
  const text = { ref: "t", name: "City", role: "textbox", value: "" };
  assert.match(driftOf({ type: "type", requested: "Pune", committed: "Pune" }, { ref: "t", text: "Pune" }, text, [text]), /empty/);
});

test("a write the page cannot read back is not reported as done, and the batch stops there", async () => {
  const driver = makeDriver({ readBack: false });
  const runner = await read(driver);
  const refs = refsOf(runner);
  const out = await runner.fillForm([{ ref: refs.First, text: "Guna" }, { ref: refs.Last, text: "P" }],
    { observationId: runner.observed.observation.observation_id, commandId: "c-unread" });
  assert.equal(out.done, 0);
  assert.equal(out.fields.length, 1);
  assert.equal(out.fields[0].ok, false);
  assert.match(out.fields[0].detail, /not confirmed/);
});

test("clearing a field has no text to read back and still counts", async () => {
  const driver = makeDriver({ readBack: false });
  const runner = await read(driver);
  const out = await runner.fillForm([{ ref: refsOf(runner).First, text: "" }],
    { observationId: runner.observed.observation.observation_id, commandId: "c-clear" });
  assert.equal(out.done, 1);
});

test("fill_form leaves a field the user wrote by hand alone, and stops there", async () => {
  const driver = makeDriver({ userEdited: new Set(["Last"]) });
  const runner = await read(driver);
  const refs = refsOf(runner);
  driver.values.Last = "typed by hand"; // the user changed it after it was observed
  const out = await runner.fillForm([{ ref: refs.First, text: "A" }, { ref: refs.Last, text: "B" }, { ref: refs.Email, text: "C" }],
    { observationId: runner.observed.observation.observation_id, commandId: "c2" });
  assert.deepEqual(out.fields.map((f) => f.ok), [true, false]);
  assert.match(out.fields[1].detail, /user/i);
  assert.equal(out.done, 1);
  assert.deepEqual(driver.typed, [["First", "A"]]);
});

test("fill_form takes 1 to 25 fields and needs the current observation", async () => {
  const runner = await read(makeDriver());
  const id = runner.observed.observation.observation_id;
  await assert.rejects(runner.fillForm([], { observationId: id, commandId: "c" }), /1 to 25/);
  await assert.rejects(runner.fillForm(Array.from({ length: 26 }, () => ({ ref: "1", text: "x" })), { observationId: id, commandId: "c" }), /1 to 25/);
  await assert.rejects(runner.fillForm([{ ref: "1", text: "x" }], { observationId: "old", commandId: "c" }), /Observe again/);
});

test("a write is refused for a stale observation, a blocker, a password and an unapproved link", async () => {
  const driver = makeDriver({ names: ["Name", "Secret", "Docs"], extra: { Docs: { role: "link", href: "https://other.example/terms" } } });
  const runner = await read(driver, { blockers: true, allowHref: () => false });
  const refs = refsOf(runner);
  const id = runner.observed.observation.observation_id;
  await assert.rejects(runner.mutate({ type: "type", ref: refs.Name, text: "x", observation_id: "old" }, "c"), /Observe again/);
  runner.observed.refs.get(refs.Secret).inputType = "password";
  await assert.rejects(runner.mutate({ type: "type", ref: refs.Secret, text: "x", observation_id: id }, "c"), /Password/);
  runner.observed.refs.get(refs.Docs).href = "https://other.example/terms";
  await assert.rejects(runner.mutate({ type: "click", ref: refs.Docs, observation_id: id }, "c"), /Approve the new application domain/);
  runner.observed.observation.blockers = ["captcha"];
  await assert.rejects(runner.mutate({ type: "type", ref: refs.Name, text: "x", observation_id: id }, "c"), /blocker/);
  assert.deepEqual(driver.typed, []);
});

test("a controller that hands blockers to the user itself can turn the blocker refusal off", async () => {
  const driver = makeDriver({ blockers: ["login"] });
  const runner = await read(driver, { blockers: false });
  const refs = refsOf(runner);
  await runner.mutate({ type: "type", ref: refs.First, text: "x", observation_id: runner.observed.observation.observation_id }, "c");
  assert.deepEqual(driver.typed, [["First", "x"]]);
});

test("reply returns only what changed with delta, keeps the full refs valid, and never returns a password", async () => {
  const driver = makeDriver({ names: ["First", "Secret"], remount: false });
  const runner = await read(driver);
  const full = await runner.reply();
  assert.equal(full.elements.length, 2);
  assert.equal(full.elements.find((e) => e.name === "Secret").value, undefined);
  driver.values.First = "Guna";
  const delta = await runner.reply({ delta: true });
  assert.equal(delta.delta, true);
  assert.equal(delta.text, "");
  assert.deepEqual(delta.elements.map((e) => e.name), ["First"]);
  assert.equal(delta.unchanged_count, 1);
});

test("review lists every field, the required ones still empty, and options reads a dropdown", async () => {
  const driver = makeDriver({ names: ["First", "Last"] });
  driver.values.First = "Guna";
  const runner = await read(driver);
  const review = await runner.review();
  assert.equal(review.type, "review");
  assert.equal(review.field_count, 2);
  assert.deepEqual(review.missing_required.map((m) => m.name), ["Last"]);
  await assert.rejects(runner.options({ ref: "nope" }), /no longer on the page/);
});

test("an answer longer than the box's maxlength is refused, not typed half", async () => {
  const driver = makeDriver({ names: ["Why"] });
  const original = driver.call.bind(driver);
  driver.call = async (frame, name, ...args) => (name === "textLimit" ? 10 : original(frame, name, ...args));
  const runner = await read(driver);
  const refs = refsOf(runner);
  const out = await runner.fillForm([{ ref: refs.Why, text: "this is far longer than ten" }], { observationId: runner.observed.observation.observation_id, commandId: "c" });
  assert.equal(out.done, 0);
  assert.match(out.fields[0].detail, /at most 10 characters.*27/);
  assert.deepEqual(driver.typed, []);
  const fresh = await read(driver);
  const ok = await fresh.fillForm([{ ref: refsOf(fresh).Why, text: "short" }], { observationId: fresh.observed.observation.observation_id, commandId: "c" });
  assert.equal(ok.done, 1);
});

test("review names an attached file even though its file input is gone", async () => {
  const driver = makeDriver({ names: ["First"] });
  const original = driver.call.bind(driver);
  driver.call = async (frame, name, ...args) => {
    const out = await original(frame, name, ...args);
    return name === "observe" ? { ...out, text: "Apply | resume.pdf | Attach | Enter manually", elements: [...out.elements, { ref: "99", role: "button", name: "Remove file" }] } : out;
  };
  const runner = await read(driver);
  assert.deepEqual((await runner.review()).attached_files, ["resume.pdf"]);
  const plain = await read(makeDriver({ names: ["First"] }));
  assert.equal((await plain.review()).attached_files, undefined);
});

// The platform's AI-led engine gets the same verified results through the Agent loop.
const frameObs = (elements) => ({ url: "https://careers.example.com/apply", title: "Apply", dialog: null, blockers: [], errors: [], text: "", elements, more_below: false, document_id: "doc", observation_id: "o1", viewport_width: 1000, viewport_height: 800 });

async function runAgent({ verifiedCommands, actions }) {
  const driver = makeDriver({ names: ["First", "Last"] });
  const original = driver.call.bind(driver);
  driver.call = async (frame, name, ...args) => {
    if (name === "observe") { const page = await original(frame, name, ...args); return { ...page, observation_id: undefined }; }
    return original(frame, name, ...args);
  };
  const requests = [];
  let calls = 0;
  const agent = new Agent({ tabId: 1, appId: null, driver, files: async () => null, notify: () => {}, report: async () => {}, controllerVersion: 2, verifiedCommands,
    step: async (req) => {
      requests.push(req);
      if (++calls === 1) {
        const ids = Object.fromEntries(req.observation.elements.map((e) => [e.name, e.ref]));
        return { controller_version: 2, session_id: "s", status: "continue", actions: actions(ids, req.observation.observation_id) };
      }
      return { controller_version: 2, session_id: "s", status: "failed", actions: [] };
    } });
  await agent.run();
  return { requests, driver };
}

test("the AI-led engine sends verified_commands and gets a result for a batched fill_form", async () => {
  const { requests, driver } = await runAgent({ verifiedCommands: true,
    actions: (ids, obs) => [{ type: "fill_form", command_id: "s:1:0", observation_id: obs, label: "Filling your saved answers",
      fields: [{ ref: ids.First, text: "Guna" }, { ref: ids.Last, text: "P" }] }] });
  assert.equal(requests[0].verified_commands, true);
  assert.deepEqual(driver.typed, [["First", "Guna"], ["Last", "P"]]);
  const [result] = requests[1].results;
  assert.equal(result.ok, true);
  assert.equal(result.result.type, "fill_form");
  assert.equal(result.result.done, 2);
});

test("the AI-led engine types a fill_form exactly as the platform serialises it (checked: null on text entries)", async () => {
  const { requests, driver } = await runAgent({ verifiedCommands: true,
    actions: (ids, obs) => [{ type: "fill_form", command_id: "s:1:0", observation_id: obs, label: "Filled 2 saved answers", ref: null, text: null, checked: null,
      fields: [{ ref: ids.First, text: "Guna", checked: null }, { ref: ids.Last, text: "P", checked: null }] }] });
  assert.deepEqual(driver.typed, [["First", "Guna"], ["Last", "P"]]);
  const [result] = requests[1].results;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.fields.map((f) => f.type), ["type", "type"]);
});

test("an unverified write in a batch fails the result so the model sees it did not stick", async () => {
  const { requests } = await runAgent({ verifiedCommands: true,
    actions: (ids, obs) => [{ type: "fill_form", command_id: "s:1:0", observation_id: obs, label: "Fill",
      fields: [{ ref: ids.First, text: "A" }, { ref: "ghost", text: "B" }, { ref: ids.Last, text: "C" }] }] });
  const [result] = requests[1].results;
  assert.equal(result.ok, false);
  assert.equal(result.result.done, 1);
});

test("without the capability the AI-led engine neither asks for verified commands nor sends results", async () => {
  const { requests, driver } = await runAgent({ verifiedCommands: false,
    actions: (ids, obs) => [{ type: "type", ref: ids.First, text: "Guna", command_id: "s:1:0", observation_id: obs, label: "Filled First" }] });
  assert.equal("verified_commands" in requests[0], false);
  assert.deepEqual(driver.typed, [["First", "Guna"]]);
  const [result] = requests[1].results;
  assert.equal(result.ok, true);
  assert.equal("result" in result, false);
});


test("controller blocker override also permits dropdown inspection and final review", async () => {
  const driver = makeDriver({ blockers: ["captcha"], names: ["Country"],
    extra: { Country: { role: "select", options: ["India", "USA"] } } });
  const runner = await read(driver, { blockers: false });
  const ref = refsOf(runner).Country;
  assert.deepEqual((await runner.options({ ref })).options, ["India", "USA"]);
  assert.equal((await runner.review()).fields[0].name, "Country");
  runner.policy.blockers = true;
  await assert.rejects(runner.options({ ref }), /blocker/);
  await assert.rejects(runner.review(), /blocker/);
});


test("scanFields: a choice group counts once and is answered by any chosen member", () => {
  const { fields, missing } = scanFields({ elements: [
    { ref: "1", role: "radio", name: "Yes", group: "Work authorization", required: true, checked: false },
    { ref: "2", role: "radio", name: "No", group: "Work authorization", required: true, checked: true },
    { ref: "3", role: "checkbox", name: "Remote", group: "Preferences", required: true, checked: false },
    { ref: "4", role: "textbox", name: "Notes", required: false, value: "" },
    { ref: "5", role: "button", name: "Submit" },
    { ref: "6", role: "textbox", name: "Locked", required: true, value: "", disabled: true },
  ] });
  assert.deepEqual(fields.map((f) => f.name), ["Work authorization", "Preferences", "Notes"]);
  assert.deepEqual(missing.map((m) => m.name), ["Preferences"]);
});

test("readinessOf: fields outside the top frame are counted as framed", () => {
  const top = { isTop: true };
  const child = { isTop: false };
  const refs = new Map([["0.1", { frame: top }], ["1.1", { frame: child }], ["1.2", { frame: child }]]);
  const readiness = readinessOf({ elements: [
    { ref: "0.1", role: "textbox", name: "Name", required: true, value: "Ada" },
    { ref: "1.1", role: "textbox", name: "Email", required: true, value: "" },
    { ref: "1.2", role: "file", name: "Resume", required: true, value: "" },
  ] }, refs);
  assert.deepEqual(readiness, { total: 3, framed: 2, missing: [
    { name: "Email", role: "textbox", framed: true }, { name: "Resume", role: "file", framed: true },
  ] });
});

test("readinessOf: a one-frame page reports nothing as framed and bounds the missing list", () => {
  const refs = new Map();
  const elements = Array.from({ length: 40 }, (_, i) => ({ ref: `0.${i}`, role: "textbox", name: `Q${i}`, required: true, value: "" }));
  for (const e of elements) refs.set(e.ref, { frame: { isTop: true } });
  const readiness = readinessOf({ elements }, refs);
  assert.equal(readiness.framed, 0);
  assert.equal(readiness.missing.length, 30);
});
