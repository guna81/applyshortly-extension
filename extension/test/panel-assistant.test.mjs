// The autofill panel's assistant, end to end in jsdom: fill.js + panel-model.js + panel-view.js + content.js
// with a fake chrome runtime standing in for the background worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { ashbyYesNo, ashbyProviders, ashbyConsent, ashbyReceipt } from "./ashby-fixture.mjs";

const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const FORM = `
  <form>
    <label for="name">Full name</label><input id="name" required>
    <fieldset><legend>Willing to relocate?</legend>
      <label><input type="radio" name="reloc" value="yes" required> Yes</label>
      <label><input type="radio" name="reloc" value="no"> No</label>
    </fieldset>
  </form>`;

function panelPage(assist, { form = FORM, suggest = () => ({ answer: null }), app = { title: "Engineer", company_name: "Acme" }, context } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${form}</body>`, { url: "https://jobs.example/apply", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  win.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  win.Element.prototype.getClientRects = () => [{}];
  win.HTMLElement.prototype.scrollIntoView = () => {};
  // The real panel uses a closed shadow root; open it so the test can read it.
  const attach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function () { return attach.call(this, { mode: "open" }); };

  const sent = [];
  let onMessage;
  const handlers = {
    hello: () => ({ mode: "idle" }),
    context: context ?? (() => ({ profile: { full_name: "Ada Lovelace" }, app, aiDrafts: false })),
    resume: () => null,
    suggest: (msg) => suggest(msg),
    report: () => null,
    autoApplied: () => false,
    panelPreference: () => false,
    assist: (msg) => assist(msg),
    webSession: () => ({ connected: true }),
    openProfile: () => true,
    agentStart: () => ({ started: true, appId: 5 }),
    agentControl: () => true,
  };
  const respond = async (msg) => {
    sent.push(plain(msg));
    try { return { ok: true, data: await handlers[msg.type](msg) }; } catch (err) { return { ok: false, error: err.message, status: err.status, code: err.code }; }
  };
  let onStorage;
  win.chrome = {
    storage: { onChanged: { addListener: (fn) => { onStorage = fn; } } },
    runtime: {
      id: "fixture",
      lastError: undefined,
      sendMessage: (msg, cb) => (cb ? void respond(msg).then(cb) : respond(msg)),
      onMessage: { addListener: (fn) => { onMessage = fn; } },
    },
  };
  for (const name of ["fill.js", "panel-model.js", "panel-view.js", "content.js"]) win.eval(src(name));
  const shadow = () => win.document.querySelector("jobhunt-autofill-panel")?.shadowRoot;
  const start = (extra = {}) => onMessage({ type: "run", appId: 5, ...extra }, { id: "fixture" }, () => {});
  const message = (msg) => onMessage(msg, { id: "fixture" }, () => {});
  return { win, sent, start, shadow, message, handlers, storage: (changes) => onStorage?.(changes, "local") };
}

async function until(check, label) {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value && value.length !== 0) return value; // an empty list is not there yet
    await tick(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("consecutive answers let batched form state commit between fields", async () => {
  const page = panelPage(() => ({}), {
    form: '<label>Name<input id="name" required></label><label>Email<input id="email" type="email" required></label>',
    context: () => ({ profile: { full_name: "Ada Lovelace", email: "ada@example.com" }, app: { id: 5 }, aiDrafts: false }),
  });
  let committed = {};
  let pending;
  let scheduled = false;
  page.win.document.addEventListener("input", (event) => {
    pending = { ...committed, [event.target.id]: event.target.value };
    if (scheduled) return;
    scheduled = true;
    page.win.setTimeout(() => { committed = pending; scheduled = false; }, 0);
  });
  page.start();
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "filled form");
  assert.deepEqual(committed, { name: "Ada Lovelace", email: "ada@example.com" });
  page.win.close();
});

test("the assistant asks the open question, offers its options, and fills the answer without AI", async () => {
  const page = panelPage(() => ({ reply: "Updated your name.", updates: {}, warnings: [], done: true, choices: [] }));
  page.start();
  const greeting = (await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting")).textContent;
  assert.equal(page.shadow().querySelector('[role="tab"]'), null); // the panel has no tabs, only the assistant
  assert.equal(greeting, "One question needs your answer before you can submit.");
  // Like the website's chat: a bot avatar, and the question as a card with its options.
  assert.ok(page.shadow().querySelector(".turn .avatar svg"));
  const card = page.shadow().querySelector(".question");
  assert.equal(card.querySelector(".step").textContent, "Required");
  assert.equal(card.querySelector(".label").textContent, "Willing to relocate?");
  const quick = [...page.shadow().querySelectorAll(".quick button")];
  assert.deepEqual(quick.map((b) => b.textContent), ["Yes", "No"]);

  quick[0].click();
  await until(() => page.win.document.querySelector('input[value="yes"]').checked && !page.shadow().querySelector(".thinking"), "the answer on the page");
  assert.equal(page.sent.some((m) => m.type === "assist"), false); // a plain answer costs no AI credit
  const bubbles = [...page.shadow().querySelectorAll(".bubble")].map((b) => b.textContent);
  assert.match(bubbles.at(-1), /^Got it\. That's everything\./);
  assert.deepEqual([...page.shadow().querySelectorAll('.turn:last-child [aria-label="Filled"] li')].map((li) => li.textContent), ["Willing to relocate?"]);
  const filled = page.sent.filter((m) => m.type === "report" && m.event.event === "filled").at(-1);
  assert.ok(filled.event.filled_fields.some((f) => f.label === "Willing to relocate?" && f.source === "assistant"));

  // Anything that isn't an answer to the question goes to the assistant.
  const input = page.shadow().querySelector(".composer-input");
  input.value = "Use my middle name too";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.sent.some((m) => m.type === "assist") && !page.shadow().querySelector(".thinking"), "assistant reply");
  const call = page.sent.find((m) => m.type === "assist");
  assert.equal(call.appId, 5);
  assert.equal(call.messages.at(-1).text, "Use my middle name too");
  assert.ok(call.fields.every((f) => ["text", "select", "radio", "dropdown"].includes(f.kind)));
});

test("a typed answer to a free-text question is written in without AI", async () => {
  const form = `<label for="city">Current city</label><input id="city" required>`;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, { form });
  page.start();
  const input = await until(() => page.shadow()?.querySelector(".composer-input"), "composer");
  assert.equal(page.shadow().querySelector(".question .label").textContent, "Current city?");
  input.value = "Pune";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.win.document.querySelector("#city").value === "Pune" || null, "the answer on the page");
  await until(() => !page.shadow().querySelector(".thinking"), "reply");
  assert.match([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent, /^Got it\. That's everything/);
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
});

test("a failed turn keeps the typed message and says why", async () => {
  const page = panelPage(() => { throw new Error("Not enough credits"); });
  page.start();
  const input = await until(() => page.shadow()?.querySelector(".composer-input"), "composer");
  input.value = "I can relocate";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.shadow().querySelector(".toast"), "toast");
  assert.match(page.shadow().querySelector(".toast").textContent, /Not enough credits/);
  assert.equal(page.shadow().querySelector(".composer-input").value, "I can relocate");
  assert.equal(page.shadow().querySelectorAll(".bubble.user").length, 0);
});

test("an optional question nobody could answer is offered for drafting, not counted as a to-do", async () => {
  const form = `<label for="name">Full name</label><input id="name" required>
    <label for="fit">Why are you a good fit?</label><textarea id="fit"></textarea>`;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form,
    suggest: (msg) => (msg.allowGenerate ? { answer: "I build ML systems end to end.", source: "generated", needs_review: true } : { answer: null }),
  });
  page.start();
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  assert.match(page.shadow().querySelector(".hero strong").textContent, /^All set/); // optional is not a to-do
  assert.match(page.shadow().querySelector(".bubble.assistant").textContent, /“Why are you a good fit” is optional/);

  const draft = [...page.shadow().querySelectorAll(".quick button")].find((b) => b.textContent === "Draft it for me");
  draft.click();
  await until(() => page.win.document.querySelector("#fit").value, "draft written");
  assert.equal(page.win.document.querySelector("#fit").value, "I build ML systems end to end.");
  assert.ok(page.sent.some((m) => m.type === "suggest" && m.allowGenerate === true));
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
  await until(() => !page.shadow().querySelector(".thinking"), "reply");
  assert.match([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent, /Here's a draft/);
});

test("on an untracked page, Draft it for me sends the page's job, and a failed draft says why", async () => {
  const form = `<title>Software Engineer @ Outmarket AI</title><h1>Software Engineer</h1>
    <p>Outmarket builds AI agents for B2B marketing teams.</p>
    <label for="why">What interests you about Outmarket?</label><textarea id="why" required></textarea>`;
  let fail = true;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form,
    app: null,
    suggest: (msg) => {
      if (!msg.allowGenerate) return { answer: null };
      if (fail) throw new Error("Not enough AI credits.");
      return { answer: "Your agents for marketing teams match my work.", source: "generated", needs_review: true };
    },
  });
  page.start({ appId: null });
  await until(() => page.shadow()?.querySelector(".quick button"), "the question");
  const draft = () => [...page.shadow().querySelectorAll(".quick button")].find((b) => b.textContent === "Draft it for me");
  draft().click();
  await until(() => !page.shadow().querySelector(".thinking") && /couldn't draft/.test([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent), "failure");
  assert.match([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent, /I couldn't draft this one \(Not enough AI credits\)\./);

  fail = false;
  const input = page.shadow().querySelector(".composer-input");
  input.value = "draft it for me";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.win.document.querySelector("#why").value, "draft written");
  const call = page.sent.filter((m) => m.type === "suggest" && m.allowGenerate).at(-1);
  assert.equal(call.page.title, "Software Engineer @ Outmarket AI");
  assert.match(call.page.description, /AI agents for B2B marketing teams/);
  // Free lookups (profile, answer bank) never send the page text.
  assert.equal(page.sent.some((m) => m.type === "suggest" && !m.allowGenerate && m.page), false);
});

test("a required open question shows Draft it for me, and a typed draft request drafts it", async () => {
  const form = `<label for="name">Full name</label><input id="name" required>
    <label for="fit">Why do you think you are suitable for this position? Brief in less than 100 words</label><textarea id="fit" required></textarea>`;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form,
    suggest: (msg) => (msg.allowGenerate ? { answer: "I build ML systems end to end.", source: "generated", needs_review: true } : { answer: null }),
  });
  page.start();
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  assert.equal(page.shadow().querySelector(".question .note").textContent, "Type your answer, or I can draft one.");
  assert.deepEqual([...page.shadow().querySelectorAll(".quick button")].map((b) => b.textContent), ["Draft it for me"]);

  const input = page.shadow().querySelector(".composer-input");
  input.value = "draft it for me";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.win.document.querySelector("#fit").value, "draft written");
  assert.equal(page.win.document.querySelector("#fit").value, "I build ML systems end to end.");
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
  await until(() => !page.shadow().querySelector(".thinking"), "reply");
  assert.match([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent, /Here's a draft/);
});

test("a consent checkbox is brought up in the chat and ticked only on the user's tap", async () => {
  const form = `<label for="name">Full name</label><input id="name" required>
    <label><input type="checkbox" id="consent" required> I agree to the privacy policy</label>`;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, { form });
  page.start();
  const bubble = await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  assert.match(bubble.textContent, /One thing only you can do: “I agree to the privacy policy”\. Tick it yourself if you agree/);
  const consent = page.win.document.querySelector("#consent");
  assert.equal(consent.checked, false);

  const quick = () => [...page.shadow().querySelectorAll(".quick button")];
  assert.deepEqual(quick().map((b) => b.textContent), ["I agree, tick it", "Show me"]);
  quick()[0].click();
  await until(() => consent.checked && !page.shadow().querySelector(".thinking"), "ticked");
  assert.match([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent, /^Ticked\. That's everything\./);
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
});

test("Contact Form 7 required skills block submission until an option is selected", async () => {
  const form = `<form><p><label>Programming Languages*</label><br>
    <span class="wpcf7-form-control-wrap"><span class="wpcf7-checkbox wpcf7-validates-as-required">
      <span><input type="checkbox" name="skills[]" value="Python"><span>Python</span></span>
      <span><input type="checkbox" name="skills[]" value="SQL"><span>SQL</span></span>
    </span></span></p><input type="submit" value="Send"></form>`;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, { form });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  await until(() => page.shadow()?.querySelector(".toast"), "blocked auto apply");
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  assert.match(page.shadow().textContent, /Select the options that apply/);
  const quick = () => [...page.shadow().querySelectorAll(".quick button")];
  assert.deepEqual(quick().map((b) => b.textContent), ["Show me", "I've done it"]);
  assert.equal(submits.length, 0);
  quick().find((b) => b.textContent === "I've done it").click();
  await until(() => /Select at least one option/.test(page.shadow().textContent), "missing selection message");
  assert.ok([...page.win.document.querySelectorAll('input[type="checkbox"]')].every((el) => !el.checked));
  const submit = () => [...page.shadow().querySelectorAll("button")].find((b) => b.textContent.trim() === "Submit for me");
  assert.equal(submit().disabled, true);
  const sql = page.win.document.querySelector('input[value="SQL"]');
  sql.click();
  await until(() => !submit().disabled, "submission enabled after selecting second option");
  sql.click();
  await until(() => submit().disabled, "submission blocked after clearing group");
  assert.equal(submits.length, 0);
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
});

const AUTO_FORM = `
  <form>
    <label for="name">Full name</label><input id="name" required>
    <button type="button">Back</button>
    <button type="submit">Submit application</button>
  </form>`;

test("calendar answers use saved dates or immediate availability without AI prose", async () => {
  for (const prefs of [{ available_from: "2026-11-02" }, { notice_period_days: 0 }, {}]) {
    const page = panelPage(() => ({}), {
      form: '<form><label>When would you be available to start?<input class="ashby-application-form-input-date" required></label><button type="submit">Submit application</button></form>',
      context: () => ({ profile: { full_name: "Ada Lovelace", preferences: prefs }, app: { id: 5 }, aiDrafts: true }),
      suggest: () => { throw new Error("A calendar date must not be generated"); },
    });
    page.start();
    await until(() => page.sent.some((m) => m.event?.event === "filled"), "calendar fill");
    const today = new Date();
    const expected = prefs.available_from ? "11/02/2026" : prefs.notice_period_days === 0
      ? `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}` : "";
    assert.equal(page.win.document.querySelector("input").value, expected);
    assert.equal(page.sent.some((m) => m.type === "suggest"), false);
    page.win.close();
  }
});

test("a typeahead that clears an unselected value no longer counts as answered", async () => {
  const page = panelPage(() => ({}), {
    form: '<form><label for="city">Location*</label><input id="city" role="combobox"><button type="submit">Submit application</button></form>',
    context: () => ({ profile: { location: "London, UK" }, app: { id: 5 }, aiDrafts: false }),
  });
  page.start();
  await until(() => page.sent.some((m) => m.event?.event === "filled"), "typeahead fill");
  const input = page.win.document.querySelector("input");
  input.value = "";
  input.dispatchEvent(new page.win.Event("input", { bubbles: true }));
  await until(() => /needs your answer/.test(page.shadow()?.textContent ?? ""), "cleared typeahead question");
  assert.equal([...page.shadow().querySelectorAll("button")].find((b) => b.textContent === "Submit for me").disabled, true);
  page.win.close();
});

function watchSubmits(page) {
  const submits = [];
  page.win.document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); submits.push(e); });
  return submits;
}

test("Auto apply submits a complete form after the countdown and reports the attempt once", async () => {
  const page = panelPage(() => ({}), { form: AUTO_FORM });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  await until(() => /Submitting in 3s/.test(page.shadow()?.textContent ?? ""), "countdown");
  assert.equal(submits.length, 0, "nothing is submitted before the countdown ends");
  await tick(3000);
  await until(() => submits.length, "submit");
  assert.equal(page.win.document.getElementById("name").value, "Ada Lovelace");
  const attempts = page.sent.filter((m) => m.type === "report" && m.event.event === "submission_attempted");
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].event.note, /auto apply/);
  await tick(2100);
  page.start({ autoSubmit: true });
  await tick(3500);
  assert.equal(submits.length, 1, "a repeat request cannot submit the same page twice");
});

test("Auto apply tells the background it clicked Submit, so Autopilot's window can close", async () => {
  const page = panelPage(() => ({}), { form: AUTO_FORM });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  await tick(3600);
  await until(() => submits.length, "submit");
  assert.equal(page.sent.filter((m) => m.type === "autoApplied").length, 1);
});

const CHECK_FORM = `
  <form>
    <label for="name">Full name</label><input id="name" required>
    <label for="notice">Notice period</label><input id="notice" required>
    <button type="submit">Submit application</button>
  </form>`;
const noticeSuggest = (needsReview) => (msg) => (/notice/i.test(msg.question) ? { answer: "30 days", source: "answer_bank", needs_review: needsReview } : { answer: null });

test("Autopilot's window leaves an answer that needs a check for the user, but a person's own Auto apply sends it", async () => {
  const unattended = panelPage(() => ({}), { form: CHECK_FORM, suggest: noticeSuggest(true) });
  const quiet = watchSubmits(unattended);
  unattended.start({ autoSubmit: true, unattended: true });
  await until(() => /1 answer needs your check/.test(unattended.shadow()?.textContent ?? ""), "check message");
  await tick(3600);
  assert.equal(quiet.length, 0);
  assert.equal(unattended.sent.some((m) => m.type === "autoApplied"), false);

  const attended = panelPage(() => ({}), { form: CHECK_FORM, suggest: noticeSuggest(true) });
  const submits = watchSubmits(attended);
  attended.start({ autoSubmit: true });
  await tick(3600);
  await until(() => submits.length, "submit");
});

test("Autopilot's window submits when every answer is certain", async () => {
  const page = panelPage(() => ({}), { form: CHECK_FORM, suggest: noticeSuggest(false) });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true, unattended: true });
  await tick(3600);
  await until(() => submits.length, "submit");
  assert.equal(page.sent.filter((m) => m.type === "autoApplied").length, 1);
});

test("Auto apply never submits on a sign-in page and leaves the window for the user", async () => {
  const form = `<form><label for="name">Full name</label><input id="name" required>
    <label for="pw">Password</label><input id="pw" type="password">
    <button type="submit">Submit application</button></form>`;
  const page = panelPage(() => ({}), { form });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  await until(() => /needs you to sign in/.test(page.shadow()?.textContent ?? ""), "sign-in message");
  await tick(3600);
  assert.equal(submits.length, 0);
  assert.equal(page.sent.some((m) => m.type === "autoApplied"), false);
  assert.equal(page.sent.some((m) => m.type === "report" && m.event.event === "submission_attempted"), false);
});

test("Auto apply can be cancelled, and never submits with a required field empty", async () => {
  const page = panelPage(() => ({}), { form: AUTO_FORM });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  const cancel = await until(() => [...(page.shadow()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Cancel"), "cancel");
  cancel.click();
  await tick(3200);
  assert.equal(submits.length, 0);
  assert.match(page.shadow().querySelector(".toast").textContent, /cancelled/);

  const incomplete = panelPage(() => ({}), { form: AUTO_FORM.replace('<label for="name">Full name</label>', '<label for="name">Favourite colour</label>') });
  const none = watchSubmits(incomplete);
  incomplete.start({ autoSubmit: true });
  await until(() => incomplete.shadow()?.querySelector(".toast"), "blocked toast");
  assert.match(incomplete.shadow().querySelector(".toast").textContent, /Not submitted: 1 required field still needs you/);
  await tick(3200);
  assert.equal(none.length, 0);
});

test("the Submit button is enabled only when it would submit, and says why not", async () => {
  const submitButton = async (page) => {
    page.start();
    return until(() => [...(page.shadow()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Submit for me"), "Submit");
  };
  const ready = await submitButton(panelPage(() => ({}), { form: AUTO_FORM, app: { title: "Engineer", status: "ready_for_review" } }));
  assert.equal(ready.disabled, false);
  assert.match(ready.title, /countdown/);

  const unconfirmed = await submitButton(panelPage(() => ({}), { form: AUTO_FORM, app: { title: "Engineer", status: "submission_unconfirmed" } }));
  assert.equal(unconfirmed.disabled, true);
  assert.equal(unconfirmed.title, "Not ready: A previous attempt needs verification in ApplyShortly first.");

  const incomplete = await submitButton(panelPage(() => ({}), { form: AUTO_FORM.replace("Full name", "Favourite colour") }));
  assert.equal(incomplete.disabled, true);
  assert.equal(incomplete.title, "Not ready: 1 required field still needs you.");
});

test("Submit sits at the bottom of the panel, disabled until every answer is in", async () => {
  const page = panelPage(() => ({}), { form: AUTO_FORM.replace('<label for="name">Full name</label>', '<label for="name">Favourite colour</label>') });
  page.start();
  await until(() => page.shadow()?.querySelector(".composer"), "panel");
  const buttons = () => [...page.shadow().querySelectorAll("button")];
  assert.ok(!buttons().some((b) => /Auto apply/.test(b.textContent)));
  const submit = buttons().find((b) => b.textContent === "Submit for me");
  assert.equal(submit.disabled, true);
  assert.match(submit.title, /1 required field still needs you/);
  // The last thing in the panel, below the message box.
  const panel = page.shadow().querySelector(".composer").parentElement;
  assert.ok(panel.lastElementChild.contains(submit));

  // Answering the last question enables it.
  page.win.document.getElementById("name").value = "blue";
  page.win.document.getElementById("name").dispatchEvent(new page.win.Event("input", { bubbles: true }));
  await until(() => !buttons().find((b) => b.textContent === "Submit for me").disabled, "Submit enabled");
});

test("the website's sign-in mark is relayed once per change, and other pages send nothing", async () => {
  const page = panelPage(() => ({}));
  const marks = () => page.sent.filter((m) => m.type === "webSession").map((m) => m.signedIn);
  await tick(20);
  assert.deepEqual(marks(), []);
  const root = page.win.document.documentElement;
  root.dataset.applyshortlySession = "signed-in";
  await until(() => marks().length === 1, "sign-in relay");
  root.dataset.applyshortlySession = "signed-in";
  root.dataset.applyshortlySession = "signed-out";
  await until(() => marks().length === 2, "sign-out relay");
  assert.deepEqual(marks(), [true, false]);
});

test("a missing profile offers the website's profile setup, then tries again", async () => {
  let ready = false;
  const context = () => {
    if (!ready) throw Object.assign(new Error("Profile not created yet"), { status: 404, code: "profile_missing" });
    return { profile: { full_name: "Ada Lovelace" }, app: { title: "Engineer", company_name: "Acme" }, aiDrafts: false };
  };
  const page = panelPage(() => ({}), { context });
  page.start();
  const alert = await until(() => page.shadow()?.querySelector('[role="alert"]'), "error");
  assert.match(alert.textContent, /^Finish setting up your profile/);
  const [setup, retry] = alert.querySelectorAll("button");
  assert.deepEqual([setup.textContent, retry.textContent], ["Set up profile", "Try again"]);
  setup.click();
  await until(() => page.sent.some((m) => m.type === "openProfile"), "profile page");
  ready = true;
  retry.click();
  await until(() => page.shadow().querySelector(".composer"), "filled panel");
});

test("dropdowns are filled, values the site rejects are retried or flagged, and nothing pretends to be done", async () => {
  const form = `
    <label for="name">Full name</label><input id="name" required>
    <label for="exp">Total experience (in years)</label><input id="exp" required>
    <label id="nl">Notice period</label>
    <mat-select id="notice" role="combobox" aria-required="true" aria-labelledby="nl"><span class="mat-mdc-select-placeholder">Notice period*</span></mat-select>
    <label id="gl">Gender</label>
    <mat-select id="gender" role="combobox" aria-required="true" aria-labelledby="gl"><span class="mat-mdc-select-placeholder">Gender*</span></mat-select>
    <button type="submit" id="go" disabled>Submit</button>`;
  const page = panelPage(() => ({}), {
    form,
    context: () => ({ profile: { full_name: "Ada Lovelace", total_experience_years: 5.6 }, app: null, aiDrafts: false }),
    suggest: (msg) => (/notice/i.test(msg.question) ? { answer: "30 days", source: "answer_bank", needs_review: false } : { answer: null }),
  });
  const doc = page.win.document;
  // The site rejects letters in the experience field, like a numbers-only validator would.
  doc.querySelector("#exp").addEventListener("input", (e) => e.target.setAttribute("aria-invalid", String(/[a-z]/i.test(e.target.value))));
  for (const [id, names] of [["notice", ["15 days", "30 days", "60 days"]], ["gender", ["Male", "Female"]]]) {
    const select = doc.querySelector(`#${id}`);
    select.addEventListener("click", () => {
      const list = doc.createElement("div");
      list.setAttribute("role", "listbox");
      for (const name of names) {
        const option = doc.createElement("mat-option");
        option.setAttribute("role", "option");
        option.textContent = name;
        option.addEventListener("click", () => { select.textContent = name; list.remove(); });
        list.append(option);
      }
      doc.body.append(list);
    });
  }
  page.start();
  await until(() => page.shadow()?.querySelector(".composer"), "panel");

  assert.equal(doc.querySelector("#exp").value, "5.6");
  assert.equal(doc.querySelector("#notice").textContent, "30 days");
  assert.equal(doc.querySelector("#gender").textContent, "Gender*"); // nothing to answer it with
  const text = page.shadow().textContent;
  assert.match(text, /1 thing left for you/);
  assert.doesNotMatch(text, /All set/);

  const submit = [...page.shadow().querySelectorAll("button")].find((b) => b.textContent === "Submit for me");
  assert.equal(submit.disabled, true);
  assert.match(submit.title, /1 required field still needs you/);
});


test("an unanswered custom dropdown's options are read once, offered as quick replies and sent to the assistant", async () => {
  const form = `
    <label for="name">Full name</label><input id="name" required>
    <label id="gl">Gender</label>
    <mat-select id="gender" role="combobox" aria-required="true" aria-labelledby="gl"><span class="mat-mdc-select-placeholder">Gender*</span></mat-select>`;
  const page = panelPage((msg) => ({ reply: "Done.", updates: { [msg.fields.find((f) => f.kind === "dropdown").key]: "Female" }, warnings: [], done: false, choices: [] }), { form });
  const doc = page.win.document;
  const select = doc.querySelector("#gender");
  let opens = 0;
  select.addEventListener("click", () => {
    opens++;
    const list = doc.createElement("div");
    list.setAttribute("role", "listbox");
    for (const name of ["Male", "Female"]) {
      const option = doc.createElement("mat-option");
      option.setAttribute("role", "option");
      option.textContent = name;
      option.addEventListener("click", () => { select.textContent = name; list.remove(); });
      list.append(option);
    }
    doc.body.append(list);
  });
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") doc.querySelectorAll('[role="listbox"]').forEach((l) => l.remove()); });
  page.start();
  await until(() => page.shadow()?.querySelector(".composer"), "panel");
  assert.equal(doc.querySelector('[role="listbox"]'), null, "closed again after reading");
  assert.equal(select.textContent, "Gender*", "nothing chosen while reading");
  assert.deepEqual([...page.shadow().querySelectorAll(".quick button")].map((b) => b.textContent), ["Male", "Female"]);

  const input = page.shadow().querySelector(".composer-input");
  input.value = "I'm a woman";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.sent.some((m) => m.type === "assist") && !page.shadow().querySelector(".thinking"), "assistant reply");
  const call = page.sent.find((m) => m.type === "assist");
  assert.deepEqual(call.fields.find((f) => f.kind === "dropdown").options, ["Male", "Female"]);
  await until(() => select.textContent === "Female" || null, "dropdown picked");
  assert.ok(opens >= 2, "opened once to read, once to pick");
});


test("a prefilled application is recognized and Auto apply reaches its cancellable countdown", async () => {
  const form = `<form>
    <label for="name">First name</label><input id="name" required value="Grace">
    <label for="city">Current location</label><input id="city" required value="Bengaluru">
    <label for="source">Source</label><select id="source" required><option value="">Choose</option><option selected>LinkedIn</option></select>
    <label id="notice-label">Notice period</label>
    <mat-select role="combobox" aria-required="true" aria-labelledby="notice-label"><span class="mat-mdc-select-value-text">Immediate</span></mat-select>
    <fieldset><legend>Relocate?</legend><label><input type="radio" name="relocate" checked required>Yes</label></fieldset>
    <label><input type="checkbox" required checked>Consent</label>
    <label for="cv">Resume</label><input id="cv" type="file">
    <button type="submit">Submit application</button></form>`;
  const page = panelPage(() => ({}), { form });
  Object.defineProperty(page.win.document.querySelector('#cv'), 'files', { value: [new page.win.File(['fixture'], 'fixture.pdf')] });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  const cancel = await until(() => [...(page.shadow()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel'), 'countdown');
  assert.doesNotMatch(page.shadow().textContent, /No fields found/);
  assert.match(page.shadow().textContent, /All set/);
  assert.equal(page.win.document.querySelector('#name').value, 'Grace', 'existing answers are not overwritten');
  assert.equal(page.sent.some((m) => m.type === 'suggest'), false);
  assert.deepEqual(page.sent.find((m) => m.type === 'report' && m.event.event === 'filled').event.filled_fields, [], 'existing answers are not reported as newly filled');
  cancel.click();
  await tick(3200);
  assert.equal(submits.length, 0);
  // Existing answers remain live: clearing one blocks submission again.
  const city = page.win.document.querySelector('#city');
  city.value = '';
  city.dispatchEvent(new page.win.Event('input', { bubbles: true }));
  await until(() => /1 thing left/.test(page.shadow().textContent), 'cleared answer');
  assert.equal([...page.shadow().querySelectorAll('button')].find((b) => b.textContent === 'Submit for me').disabled, true);
  page.win.close();
});

test("prefilled answers rejected by the site still block Auto apply", async () => {
  const page = panelPage(() => ({}), { form: AUTO_FORM.replace('id="name" required', 'id="name" required value="Rejected" aria-invalid="true"') });
  const submits = watchSubmits(page);
  page.start({ autoSubmit: true });
  await until(() => /Not submitted: 1 required field/.test(page.shadow()?.textContent ?? ''), 'validation blocker');
  assert.equal(submits.length, 0);
  assert.doesNotMatch(page.shadow().textContent, /No fields found|Submitting in/);
  page.win.close();
});

test("rerunning a filled form preserves answer provenance and review requirements", async () => {
  const page = panelPage(() => ({}), { form: CHECK_FORM, suggest: noticeSuggest(true) });
  const submits = watchSubmits(page);
  page.start();
  await until(() => page.shadow()?.querySelector('.composer'), 'filled panel');
  page.start({ autoSubmit: true, unattended: true });
  await until(() => /1 answer needs your check/.test(page.shadow()?.textContent ?? ''), 'review still required');
  const report = page.sent.filter((m) => m.type === 'report' && m.event.event === 'filled').at(-1);
  assert.ok(report.event.filled_fields.some((f) => f.label === 'Notice period' && f.source === 'answer_bank' && f.needs_review));
  assert.equal(submits.length, 0);
  page.win.close();
});

test("Auto apply rechecks newly required fields and changed submit buttons after the countdown", async () => {
  const changes = [
    (doc) => doc.querySelector("form").insertAdjacentHTML("beforeend", '<label>New required answer<input required></label>'),
    (doc) => doc.querySelector('button[type="submit"]').setAttribute("aria-disabled", "true"),
    (doc) => doc.querySelector("form").insertAdjacentHTML("beforeend", '<button type="submit">Submit another application</button>'),
  ];
  await Promise.all(changes.map(async (change) => {
    const page = panelPage(() => ({}), { form: AUTO_FORM });
    const submits = watchSubmits(page);
    page.start({ autoSubmit: true });
    await until(() => /Submitting in 3s/.test(page.shadow()?.textContent ?? ""), "countdown");
    change(page.win.document);
    await tick(3200);
    assert.equal(submits.length, 0);
    assert.equal(page.sent.filter((m) => m.type === "report" && m.event.event === "submission_attempted").length, 0);
    assert.match(page.shadow().textContent, /Not submitted: the form changed/);
    page.win.close();
  }));
});

test("'I already submitted it' asks once more, then reports the submission", async () => {
  const page = panelPage(() => ({}));
  page.start();
  const button = (label) => [...(page.shadow()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
  (await until(() => button("I already submitted it"), "the button")).click();
  button("Not yet").click();
  button("I already submitted it").click();
  button("Yes, I submitted it").click();
  await until(() => page.sent.filter((m) => m.type === "report" && m.event.event === "submitted"), "submitted report");
  await until(() => page.shadow().querySelector(".msg.good"), "saved message");
  assert.match(page.shadow().querySelector(".msg.good").textContent, /marked Submitted/);
});

test("a 'Select' box with a plain list (no ARIA options) offers its options in the chat and takes the pick", async () => {
  const form = `
    <label for="name">Full name</label><input id="name" required>
    <label for="sal">Salutation *</label><input id="sal" role="combobox" placeholder="Select" required>
    <ul class="menu" hidden><li>Miss</li><li>Mr.</li><li>Mrs.</li><li>Ms.</li><li>Mx.</li></ul>`;
  const page = panelPage((msg) => ({ reply: "Set.", updates: { [msg.fields.find((f) => f.kind === "dropdown").key]: "Mr." }, warnings: [], done: false, choices: [] }), { form });
  const doc = page.win.document;
  const input = doc.querySelector("#sal");
  const menu = doc.querySelector(".menu");
  input.addEventListener("click", () => { menu.hidden = false; });
  doc.addEventListener("mousedown", (e) => { if (e.target !== input && !menu.contains(e.target)) menu.hidden = true; });
  for (const li of menu.children) li.addEventListener("click", () => { input.value = li.textContent; menu.hidden = true; });
  page.start();
  await until(() => page.shadow()?.querySelectorAll(".quick button"), "quick replies");
  assert.equal(page.shadow().querySelector(".question .label").textContent, "Salutation?");
  assert.deepEqual([...page.shadow().querySelectorAll(".quick button")].map((b) => b.textContent), ["Miss", "Mr.", "Mrs.", "Ms.", "Mx."]);
  assert.equal(menu.hidden, true, "closed again after reading");
  assert.equal(input.value, "", "nothing chosen while reading");

  [...page.shadow().querySelectorAll(".quick button")][1].click();
  await until(() => (input.value === "Mr." ? [1] : null), "the pick on the page");
  assert.equal(page.sent.some((m) => m.type === "assist"), false); // tapping an option costs no AI credit
});

const CHOICE_FORM = `
  <form>
    <label for="auth">Work authorization</label>
    <select id="auth" required><option value="">Choose</option><option value="y">I am legally authorized</option><option value="n">I am not legally authorized</option></select>
    <fieldset><legend>Highest degree</legend>
      <label><input type="radio" name="deg" value="b" required> Bachelor's degree</label>
      <label><input type="radio" name="deg" value="m"> Master's degree</label>
    </fieldset>
  </form>`;
const SENTENCES = { "Work authorization": "I am not sure if I am legally authorized", "Highest degree": "Master's degree in Computing" };
const aiContext = () => ({ profile: { full_name: "Ada Lovelace" }, app: { title: "Engineer", company_name: "Acme" }, aiDrafts: true });

test("automatic drafting asks for salary facts and rejects answers beyond the field's limit", async () => {
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form: '<label for="salary">What is your expected salary package?</label><input id="salary" required maxlength="50">' +
      '<label for="fit">Why are you a good fit?</label><textarea id="fit" required maxlength="20"></textarea>',
    context: aiContext,
    suggest: (msg) => msg.allowGenerate ? { answer: "An AI-generated paragraph that is too long for this field.", source: "generated", needs_review: true } : { answer: null },
  });
  page.start();
  await until(() => page.sent.some((m) => m.type === "report" && m.event.event === "filled"), "filled report");
  assert.equal(page.sent.some((m) => m.type === "suggest" && m.allowGenerate && /salary/.test(m.question)), false);
  assert.equal(page.win.document.querySelector("#salary").value, "");
  assert.equal(page.win.document.querySelector("#fit").value, "");
  const report = page.sent.filter((m) => m.type === "report" && m.event.event === "filled").at(-1);
  assert.equal(report.event.unresolved_fields.length, 2);
  page.win.close();
});

test("Rippling SMS consent is named and left to the user even when the answer bank has an answer", async () => {
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form: '<div role="radiogroup" data-testid="sms_opt_in"><div role="radio" aria-label="Yes - I consent" data-value="true" aria-checked="false"></div><div role="radio" aria-label="No - I do not consent" data-value="false" aria-checked="false"></div></div>',
    context: aiContext,
    suggest: () => ({ answer: "Yes - I consent", source: "answer_bank", needs_review: false }),
  });
  page.start();
  await until(() => page.sent.some((m) => m.type === "report" && m.event.event === "filled"), "filled report");
  assert.equal(page.sent.some((m) => m.type === "suggest"), false);
  assert.equal(page.win.document.querySelector('[aria-checked="true"]'), null);
  assert.match(page.shadow().textContent, /Receive text message updates about your application/);
  page.win.close();
});

test("an AI draft that only contains an option's words leaves the choice to the user", async () => {
  const page = panelPage(() => ({ reply: "", updates: {}, warnings: [], done: false, choices: [] }), {
    form: CHOICE_FORM,
    context: aiContext,
    suggest: (msg) => (msg.allowGenerate ? { answer: SENTENCES[msg.question], source: "generated", needs_review: true } : { answer: null }),
  });
  page.start();
  await until(() => page.sent.filter((m) => m.type === "report" && m.event.event === "filled"), "filled report");
  assert.ok(page.sent.some((m) => m.type === "suggest" && m.allowGenerate === true), "drafts were requested");
  const doc = page.win.document;
  assert.equal(doc.querySelector("#auth").value, "");
  assert.equal([...doc.querySelectorAll('input[name="deg"]')].some((r) => r.checked), false);
  const report = page.sent.filter((m) => m.type === "report" && m.event.event === "filled").at(-1);
  assert.deepEqual(plain(report.event.filled_fields), []);
  assert.deepEqual(report.event.unresolved_fields.map((f) => f.label).sort(), ["Highest degree", "Work authorization"]);
  assert.match(page.shadow().querySelector(".bubble.assistant").textContent, /2 questions need your answer/);
});

test("an answer-bank answer still picks the one option it contains", async () => {
  const page = panelPage(() => ({ reply: "", updates: {}, warnings: [], done: false, choices: [] }), {
    form: CHOICE_FORM,
    context: aiContext,
    suggest: (msg) => (msg.allowGenerate ? { answer: null } : { answer: SENTENCES[msg.question], source: "answer_bank", needs_review: false }),
  });
  page.start();
  await until(() => page.sent.filter((m) => m.type === "report" && m.event.event === "filled"), "filled report");
  const doc = page.win.document;
  assert.equal(doc.querySelector("#auth").value, "y"); // non-strict containment, as before
  assert.equal(doc.querySelector('input[value="m"]').checked, true);
  const report = page.sent.filter((m) => m.type === "report" && m.event.event === "filled").at(-1);
  assert.deepEqual(report.event.filled_fields.map((f) => [f.label, f.source]).sort(), [["Highest degree", "answer_bank"], ["Work authorization", "answer_bank"]]);
});

test("an optional personal fact gets no Draft button, and a typed draft request isn't drafted", async () => {
  const form = `<label for="name">Full name</label><input id="name" required>
    <label for="mid">Middle Name</label><input id="mid">`;
  const page = panelPage(() => ({ reply: "What's your middle name?", updates: {}, warnings: [], done: false, choices: [] }), {
    form,
    suggest: (msg) => (msg.allowGenerate ? { answer: "Marie", source: "generated", needs_review: true } : { answer: null }),
  });
  page.start();
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  assert.match(page.shadow().querySelector(".bubble.assistant").textContent, /“Middle Name” is optional: tell me what to put, or leave it blank\./);
  assert.deepEqual([...page.shadow().querySelectorAll(".quick button")].map((b) => b.textContent), ["Leave it blank"]);

  const input = page.shadow().querySelector(".composer-input");
  input.value = "Draft it for me";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.shadow().querySelectorAll(".bubble.user"), "user line");
  await until(() => !page.shadow().querySelector(".thinking"), "reply");
  assert.match([...page.shadow().querySelectorAll(".bubble")].at(-1).textContent, /a detail only you know/);
  assert.equal(page.sent.some((m) => m.type === "suggest" && m.allowGenerate === true), false);
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
  assert.equal(page.win.document.querySelector("#mid").value, "");
});

const STEP_FORM = `<form>
  <label for="name">Full name</label><input id="name" required>
  <button type="button">Next</button>
</form>`;

test("explicit Auto apply continues after the form agent is ready, through the usual countdown", async () => {
  const page = panelPage(() => ({}), { form: STEP_FORM.replace('<button', '<label>Department<input required></label><button') });
  page.start({ autoSubmit: true });
  await until(() => page.sent.find((m) => m.type === "agentStart"), "agent handoff");
  assert.equal(page.sent.find((m) => m.type === "agentStart").autoSubmit, true);
  page.win.document.querySelector("form").innerHTML = '<label>Full name<input required value="Ada Lovelace"></label><button type="submit">Submit application</button>';
  const submits = watchSubmits(page);
  page.message({ type: "agentUpdate", status: "ready", appId: 5, autoSubmit: true });
  await until(() => /Submitting in 3s/.test(page.shadow()?.textContent ?? ""), "countdown after agent");
  assert.equal(submits.length, 0);
  await tick(3100);
  await until(() => submits.length, "submission after agent");
  assert.equal(page.sent.filter((m) => m.event?.event === "submission_attempted").length, 1);
  page.message({ type: "agentUpdate", status: "ready", appId: 5, autoSubmit: true });
  await tick(20);
  assert.equal(submits.length, 1);
});

test("agent readiness without Auto apply approval leaves the completed form for review", async () => {
  const page = panelPage(() => ({}), { form: STEP_FORM });
  page.start();
  await until(() => page.sent.find((m) => m.type === "agentStart"), "agent handoff");
  assert.notEqual(page.sent.find((m) => m.type === "agentStart").autoSubmit, true);
  page.win.document.querySelector("form").innerHTML = '<label>Full name<input required value="Ada Lovelace"></label><button type="submit">Submit application</button>';
  const submits = watchSubmits(page);
  page.message({ type: "agentUpdate", status: "ready", appId: 5 });
  await until(() => /I've been through/.test(page.shadow()?.textContent ?? ""), "review prompt");
  assert.doesNotMatch(page.shadow().textContent, /Submitting in/);
  assert.equal(submits.length, 0);
  page.win.close();
});

test("Auto apply after the agent still blocks missing answers and supports cancellation", async () => {
  for (const incomplete of [false, true]) {
    const page = panelPage(() => ({}), { form: STEP_FORM });
    page.start({ autoSubmit: true });
    await until(() => page.sent.find((m) => m.type === "agentStart"), "agent handoff");
    page.win.document.querySelector("form").innerHTML = '<label>Full name<input required value="Ada Lovelace"></label>' +
      (incomplete ? '<label>Department<input required></label>' : '') + '<button type="submit">Submit application</button>';
    const submits = watchSubmits(page);
    page.message({ type: "agentUpdate", status: "ready", appId: 5, autoSubmit: true });
    if (incomplete) {
      await until(() => /Not submitted:/.test(page.shadow()?.textContent ?? ""), "required answer blocker");
      assert.doesNotMatch(page.shadow().textContent, /Submitting in/);
    } else {
      const cancel = await until(() => [...(page.shadow()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === "Cancel"), "cancellable countdown");
      cancel.click();
      await until(() => /Submit cancelled/.test(page.shadow()?.textContent ?? ""), "cancelled");
    }
    assert.equal(submits.length, 0);
    assert.equal(page.sent.some((m) => m.event?.event === "submission_attempted"), false);
    page.win.close();
  }
});

test("the chat is the agent: it clicks through a multi-step form itself and asks in the chat", async () => {
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form: STEP_FORM,
    suggest: (msg) => (msg.allowGenerate ? { answer: "I build LLM systems.", source: "generated", needs_review: true } : { answer: null }),
  });
  page.start();
  await until(() => page.sent.filter((m) => m.type === "agentStart"), "agentStart without a button");
  const shadow = () => page.shadow();
  const bubbles = () => [...shadow().querySelectorAll(".bubble")].map((b) => b.textContent);
  const buttons = () => [...shadow().querySelectorAll("button")].map((b) => b.textContent);
  await until(() => bubbles().filter((t) => /more than one step/.test(t)), "the handoff line");
  assert.ok(!buttons().includes("Fill with the agent"));

  page.message({ type: "agentUpdate", status: "running", appId: 5, log: ["Started. Watching the page…", "Clicked Next"] });
  await until(() => (shadow().querySelector(".thinking")?.textContent === "Clicked Next" ? [1] : null), "the latest step");
  assert.match(shadow().querySelector(".hero strong").textContent, /Working through the form/);
  assert.equal(shadow().querySelector(".composer-input").disabled, true);
  assert.deepEqual([...shadow().querySelectorAll(".f button")].map((b) => b.textContent), ["Pause", "Stop and take over"]);

  page.message({ type: "agentUpdate", status: "waiting", appId: 5, log: ["Clicked Next"], question: { kind: "question", text: "Notice period?", choices: ["30 days", "60 days"] } });
  await until(() => [...shadow().querySelectorAll(".question .label")].filter((q) => q.textContent === "Notice period?"), "the question as a chat card");
  assert.equal(shadow().querySelector(".ask"), null); // no separate question box
  assert.deepEqual([...shadow().querySelectorAll(".quick button")].map((b) => b.textContent), ["30 days", "60 days", "I'll fill it on the page"]);
  [...shadow().querySelectorAll(".quick button")][0].click();
  await until(() => page.sent.filter((m) => m.type === "agentControl" && m.action === "reply" && m.text === "30 days"), "the reply");

  page.message({ type: "agentUpdate", status: "running", appId: 5, log: ["Filled Notice period"] });
  page.message({ type: "agentUpdate", status: "waiting", appId: 5, log: [], question: { kind: "question", text: "Why do you want to work at Actowiz?" } });
  await until(() => [...shadow().querySelectorAll(".question .label")].filter((q) => /Why do you want to work at Actowiz/.test(q.textContent)), "the open question");
  const input = shadow().querySelector(".composer-input");
  assert.equal(input.disabled, false);
  input.value = "draft it for me";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.sent.filter((m) => m.type === "agentControl" && m.text === "I build LLM systems."), "the draft goes to the agent");
  assert.ok(!page.sent.some((m) => m.type === "agentControl" && /draft it/i.test(m.text ?? "")));
  assert.ok(bubbles().some((t) => /Here's a draft/.test(t)));

  page.message({ type: "agentUpdate", status: "ready", appId: 5, log: ["Filled Why"], filled: [{ label: "Why", value: "I build LLM systems.", needs_review: true }], unresolved: [] });
  await until(() => bubbles().filter((t) => /I've been through the form/.test(t)), "the wrap-up line");
  assert.equal(shadow().querySelector("details summary").textContent, "What I did on the page");
  assert.ok(buttons().includes("Submit for me"));
  assert.ok(!buttons().includes("Fill with the agent"));
  assert.equal(page.sent.filter((m) => m.type === "agentStart").length, 1);
});

test("a page with no form yet: the chat opens it itself", async () => {
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, { form: "<p>LLM Engineer</p><button>Apply</button>" });
  page.start();
  await until(() => page.sent.filter((m) => m.type === "agentStart"), "agentStart");
  await until(() => [...(page.shadow()?.querySelectorAll(".bubble") ?? [])].filter((b) => /can't see a form on this page yet/.test(b.textContent)), "the handoff line");
});

test("a one-page form is filled in place, and typing 'do the rest' carries on through the form", async () => {
  const page = panelPage(() => { throw new Error("assistant API not expected"); });
  page.start();
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  await tick(50);
  assert.equal(page.sent.some((m) => m.type === "agentStart"), false);
  const input = page.shadow().querySelector(".composer-input");
  input.value = "do the rest";
  input.dispatchEvent(new page.win.Event("input"));
  input.dispatchEvent(new page.win.KeyboardEvent("keydown", { key: "Enter" }));
  await until(() => page.sent.filter((m) => m.type === "agentStart"), "agentStart on request");
  assert.equal(page.win.document.querySelector("#name").value, "Ada Lovelace"); // not typed into the form
});

test("if the agent can't start, the chat says so and keeps helping", async () => {
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, { form: STEP_FORM });
  page.handlers.agentStart = () => { throw new Error("Not enough credits"); };
  page.start();
  await until(() => [...(page.shadow()?.querySelectorAll(".bubble") ?? [])].filter((b) => /couldn't click through this form/.test(b.textContent)), "the failure line");
  assert.equal(page.shadow().querySelector(".composer-input").disabled, false);
});

test("turning on AI answers in the popup drafts the open questions on a panel that's already open", async () => {
  const form = `<form><label for="name">Full name</label><input id="name" required>
    <label for="why">What interests you about Outmarket?</label><textarea id="why" required></textarea></form>`;
  const page = panelPage(() => { throw new Error("assistant API not expected"); }, {
    form,
    suggest: (msg) => (msg.allowGenerate ? { answer: "Your agent tooling.", source: "generated", needs_review: true } : { answer: null }),
  });
  page.start();
  const greeting = await until(() => page.shadow()?.querySelector(".question .label"), "greeting");
  assert.match(greeting.textContent, /What interests you about Outmarket/);
  assert.equal(page.sent.some((m) => m.type === "suggest" && m.allowGenerate), false); // switched off when the page was filled

  page.storage({ aiDrafts: { oldValue: false, newValue: true } });
  await until(() => [...page.shadow().querySelectorAll(".bubble")].filter((b) => /I drafted an answer with AI/.test(b.textContent)), "the drafted line");
  assert.equal(page.win.document.querySelector("#why").value, "Your agent tooling.");
  assert.equal(page.sent.some((m) => m.type === "assist"), false);
});

test("a hidden field the uploader fills is waited for, then named in words instead of making the browser point at it", async () => {
  const form = `<form>
    <label for="name">Full name</label><input id="name" required>
    <label for="cv">Resume</label><input id="cv" type="file">
    <input id="fileName" name="resume.fileName" required>
    <button type="submit">Submit application</button>
  </form>`;
  const resume = () => ({ name: "resume.pdf", type: "application/pdf", base64: "JVBERi0=" });
  const withUploads = (page) => {
    // jsdom has no DataTransfer, and only takes a real FileList for input.files.
    page.win.DataTransfer = class { constructor() { this.list = []; this.items = { add: (f) => this.list.push(f) }; } get files() { return this.list; } };
    Object.defineProperty(page.win.HTMLInputElement.prototype, "files", { configurable: true, get() { return this.chosen ?? []; }, set(v) { this.chosen = v; } });
    page.handlers.resume = resume;
    return page;
  };
  const longer = async (check, label) => {
    for (let i = 0; i < 80; i++) { if (check()) return check(); await tick(100); }
    throw new Error(`Timed out waiting for ${label}`);
  };

  // The upload finishes a moment later: Auto apply waits for it and submits.
  const slow = withUploads(panelPage(() => ({}), { form }));
  slow.win.document.getElementById("fileName").getClientRects = () => [];
  const sent = watchSubmits(slow);
  slow.start({ autoSubmit: true });
  setTimeout(() => { slow.win.document.getElementById("fileName").value = "resume.pdf"; }, 1200);
  await longer(() => /Submitting in 3s/.test(slow.shadow()?.textContent ?? ""), "countdown after the upload");
  await tick(3100);
  await until(() => sent.length, "submit");

  // It never does: nothing is sent, the browser isn't asked to focus the hidden field, and the
  // résumé goes back on the list.
  const stuck = withUploads(panelPage(() => ({}), { form }));
  const hidden = stuck.win.document.getElementById("fileName");
  hidden.getClientRects = () => [];
  let pointed = 0;
  hidden.reportValidity = () => { pointed++; return false; };
  stuck.win.HTMLFormElement.prototype.reportValidity = () => { pointed++; return false; };
  const none = watchSubmits(stuck);
  stuck.start({ autoSubmit: true });
  const toast = await longer(() => stuck.shadow()?.querySelector(".toast"), "the blocked message");
  assert.match(toast.textContent, /hasn't registered your file for “Resume”.*Attach it again/);
  assert.equal(pointed, 0);
  assert.equal(none.length, 0);
  assert.match(stuck.shadow().querySelector(".hero strong").textContent, /1 thing left for you/);
});


test('a newly registered application id is used for tracking instead of leaving the form untracked', async () => {
  const page = panelPage(() => ({}), { app: { id: 72, title: 'Engineer', company_name: 'Acme' } });
  page.start({ appId: null });
  await until(() => page.sent.find((m) => m.event?.event === 'filled'), 'tracked fill');
  assert.ok(page.sent.filter((m) => m.type === 'report').every((m) => m.event.application_id === 72));
  page.win.close();
});

test('SPA submit clicks sync an attempt, then an explicit receipt syncs confirmation once', async () => {
  const page = panelPage(() => ({}), { form: '<label for="name">Full name</label><input id="name" required><button type="button">Submit</button>' });
  page.start();
  await until(() => page.sent.find((m) => m.event?.event === 'filled'), 'fill');
  page.win.document.querySelector('button').click();
  await until(() => page.sent.find((m) => m.event?.event === 'submission_attempted'), 'attempt');
  assert.equal(page.sent.some((m) => m.event?.event === 'submitted'), false);
  const receipt = page.win.document.createElement('div');
  receipt.setAttribute('role', 'status');
  receipt.textContent = 'Your application has been successfully submitted';
  page.win.document.body.append(receipt);
  await until(() => page.sent.find((m) => m.event?.event === 'submitted'), 'confirmation');
  receipt.append('!');
  await tick();
  assert.equal(page.sent.filter((m) => m.event?.event === 'submitted').length, 1);
  page.win.close();
});

test('a receipt in a plain paragraph confirms the attempt, like any site that skips headings and status regions', async () => {
  const page = panelPage(() => ({}), { form: '<label for="name">Full name</label><input id="name" required><button type="button">Submit</button>' });
  page.start();
  await until(() => page.sent.find((m) => m.event?.event === 'filled'), 'fill');
  page.win.document.querySelector('button').click();
  await until(() => page.sent.find((m) => m.event?.event === 'submission_attempted'), 'attempt');
  page.win.document.body.insertAdjacentHTML('beforeend', '<div class="done"><p>Thanks for applying! We have received your application.</p></div>');
  await until(() => page.sent.find((m) => m.event?.event === 'submitted'), 'confirmation');
  assert.equal(page.sent.filter((m) => m.event?.event === 'submitted').length, 1);
  page.win.close();
});

test('moving to the site\'s own thank-you page confirms the attempt; a job path that merely contains the word does not', async () => {
  const page = panelPage(() => ({}), { form: '<label for="name">Full name</label><input id="name" required><button type="button">Submit</button>' });
  page.start();
  await until(() => page.sent.find((m) => m.event?.event === 'filled'), 'fill');
  page.win.document.querySelector('button').click();
  await until(() => page.sent.find((m) => m.event?.event === 'submission_attempted'), 'attempt');
  const route = (path, html) => {
    page.win.history.pushState({}, '', path);
    page.win.document.body.insertAdjacentHTML('beforeend', html);
  };
  route('/jobs/customer-success-manager/apply', '<p>Saving…</p>');
  await tick(30);
  assert.equal(page.sent.some((m) => m.event?.event === 'submitted'), false);
  route('/jobs/customer-success-manager/apply/thank-you', '<p>Done</p>');
  await until(() => page.sent.find((m) => m.event?.event === 'submitted'), 'confirmation page');
  assert.equal(page.sent.filter((m) => m.event?.event === 'submitted').length, 1);
  page.win.close();
});

test('a duplicate-profile error and existing receipt text never turn an attempt into Applied', async () => {
  const page = panelPage(() => ({}), { form: '<h2>Thank you for applying</h2><label for="name">Full name</label><input id="name" required><button type="button">Submit</button>' });
  page.start();
  await until(() => page.sent.find((m) => m.event?.event === 'filled'), 'fill');
  page.win.document.querySelector('button').click();
  await until(() => page.sent.find((m) => m.event?.event === 'submission_attempted'), 'attempt');
  const error = page.win.document.createElement('div');
  error.setAttribute('role', 'alert');
  error.textContent = 'Profile is already present in the system. Cannot be uploaded again.';
  page.win.document.body.append(error);
  await tick(30);
  assert.equal(page.sent.some((m) => m.event?.event === 'submitted'), false);
  page.win.close();
});


test("Ashby required questions block auto apply and Yes/No can be answered in extension chat", async () => {
  const page = panelPage(() => ({}), { form: `<form>${ashbyYesNo()}${ashbyProviders}${ashbyConsent}<button type="submit">Submit application</button></form>` });
  const submits = watchSubmits(page);
  for (const button of page.win.document.querySelectorAll("button[data-option]")) button.addEventListener("click", () => {
    for (const b of button.parentElement.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === button));
  });
  page.start({ autoSubmit: true });
  await until(() => page.shadow()?.querySelector(".question"), "screening question");
  const report = page.sent.filter((m) => m.event?.event === "filled").at(-1);
  assert.equal(report.event.unresolved_fields.length, 3);
  assert.equal(page.shadow().querySelector(".question .label").textContent, "Have you used Python professionally?");
  [...page.shadow().querySelectorAll(".quick button")].find((b) => b.textContent === "No").click();
  await until(() => page.win.document.querySelector('[data-option="no"]').getAttribute("aria-pressed") === "true", "No answer");
  await until(() => /Select the options that apply/.test(page.shadow().textContent), "provider group");
  assert.equal(submits.length, 0);
  assert.equal(page.win.document.querySelector("#consent").checked, false);
  assert.equal([...page.shadow().querySelectorAll("button")].find((b) => b.textContent === "Submit for me").disabled, true);
  page.win.close();
});

test("Ashby positive receipt confirms only a new submission attempt, not a generic Success notice", async () => {
  const page = panelPage(() => ({}), { form: '<label>Full name<input required></label><button type="button">Submit</button>' });
  page.start();
  await until(() => page.sent.some((m) => m.event?.event === "filled"), "fill");
  page.win.document.body.insertAdjacentHTML("beforeend", ashbyReceipt);
  await tick(20);
  assert.equal(page.sent.some((m) => m.event?.event === "submitted"), false, "receipt without attempt is ignored");
  page.win.document.querySelector(".ashby-application-form-success-container").remove();
  page.win.document.querySelector("button").click();
  await until(() => page.sent.some((m) => m.event?.event === "submission_attempted"), "attempt");
  page.win.document.body.insertAdjacentHTML("beforeend", '<div role="status"><h2>Success</h2><p>Saved profile</p></div>');
  await tick(20);
  assert.equal(page.sent.some((m) => m.event?.event === "submitted"), false);
  page.win.document.body.insertAdjacentHTML("beforeend", ashbyReceipt);
  await until(() => page.sent.some((m) => m.event?.event === "submitted"), "Ashby receipt");
  assert.equal(page.sent.filter((m) => m.event?.event === "submitted").length, 1);
  page.win.close();
});
