// The autofill panel's Assistant tab, end to end in jsdom: fill.js + panel-model.js + content.js
// with a fake chrome runtime standing in for the background worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { test } from "node:test";

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
    panelPreference: () => false,
    assist: (msg) => assist(msg),
    webSession: () => ({ connected: true }),
    openProfile: () => true,
  };
  const respond = async (msg) => {
    sent.push(plain(msg));
    try { return { ok: true, data: await handlers[msg.type](msg) }; } catch (err) { return { ok: false, error: err.message, status: err.status, code: err.code }; }
  };
  win.chrome = {
    runtime: {
      id: "fixture",
      lastError: undefined,
      sendMessage: (msg, cb) => (cb ? void respond(msg).then(cb) : respond(msg)),
      onMessage: { addListener: (fn) => { onMessage = fn; } },
    },
  };
  for (const name of ["fill.js", "panel-model.js", "content.js"]) win.eval(src(name));
  const shadow = () => win.document.querySelector("jobhunt-autofill-panel")?.shadowRoot;
  const start = (extra = {}) => onMessage({ type: "run", appId: 5, ...extra }, { id: "fixture" }, () => {});
  return { win, sent, start, shadow };
}

async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value && value.length !== 0) return value; // an empty list is not there yet
    await tick(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("the Assistant tab asks the open question, offers its options, and fills the answer", async () => {
  const page = panelPage((msg) => ({ reply: "Thanks, I set relocation to Yes.", updates: { [msg.fields.find((f) => f.kind === "radio").key]: "Yes" }, warnings: [], done: false, choices: [] }));
  page.start();
  const tabs = await until(() => page.shadow()?.querySelectorAll('[role="tab"]'), "tabs");
  assert.deepEqual([...tabs].map((t) => t.textContent.replace(/\d+/, "").trim()), ["Assistant", "Form"]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true"); // something needs the user

  const greeting = page.shadow().querySelector(".bubble.assistant").textContent;
  assert.match(greeting, /1 question needs your answer.*Willing to relocate \(required\)\?/);
  const quick = [...page.shadow().querySelectorAll(".quick button")];
  assert.deepEqual(quick.map((b) => b.textContent), ["Yes", "No"]);

  quick[0].click();
  await until(() => page.sent.some((m) => m.type === "assist") && !page.shadow().querySelector(".thinking"), "assistant reply");
  const call = page.sent.find((m) => m.type === "assist");
  assert.equal(call.appId, 5);
  assert.deepEqual(call.messages, [{ role: "user", text: "Yes" }]); // greeting is UI copy, not sent
  assert.ok(call.fields.every((f) => ["text", "select", "radio", "dropdown"].includes(f.kind)));

  assert.equal(page.win.document.querySelector('input[value="yes"]').checked, true);
  const bubbles = [...page.shadow().querySelectorAll(".bubble")].map((b) => b.textContent);
  assert.match(bubbles.at(-1), /^Thanks, I set relocation to Yes\. That's everything\..*Filled:Willing to relocate\?$/);
  const filled = page.sent.filter((m) => m.type === "report" && m.event.event === "filled").at(-1);
  assert.ok(filled.event.filled_fields.some((f) => f.label === "Willing to relocate?" && f.source === "assistant"));

  page.shadow().querySelectorAll('[role="tab"]')[1].click();
  assert.ok(page.shadow().querySelector(".steps"), "Form tab shows the checklist");
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
  const tabs = await until(() => page.shadow()?.querySelectorAll('[role="tab"]'), "tabs");
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].querySelector(".n"), null); // optional is not a to-do
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

test("the Form tab lists optional questions in their own section", async () => {
  const form = `<label for="fit">Cover note</label><textarea id="fit"></textarea>`;
  const page = panelPage(() => ({}), { form });
  page.start();
  const tabs = await until(() => page.shadow()?.querySelectorAll('[role="tab"]'), "tabs");
  tabs[1].click();
  const sections = [...page.shadow().querySelectorAll(".sec")].map((b) => b.textContent);
  assert.ok(sections.some((t) => t.startsWith("Optional1")), sections.join("|"));
  assert.ok([...page.shadow().querySelectorAll(".row button")].some((b) => /Draft with AI/.test(b.textContent)));
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
  assert.equal(page.shadow().querySelectorAll('[role="tab"]')[1].querySelector(".n"), null);
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
  await until(() => page.shadow()?.querySelector('[role="tab"]'), "tabs after blocked auto apply");
  page.shadow().querySelector('[role="tab"]').click();
  await until(() => page.shadow()?.querySelector(".bubble.assistant"), "greeting");
  assert.match(page.shadow().textContent, /Select the options that apply/);
  const quick = () => [...page.shadow().querySelectorAll(".quick button")];
  assert.deepEqual(quick().map((b) => b.textContent), ["Show me", "I've done it"]);
  assert.equal(submits.length, 0);
  quick().find((b) => b.textContent === "I've done it").click();
  await until(() => /Select at least one option/.test(page.shadow().textContent), "missing selection message");
  assert.ok([...page.win.document.querySelectorAll('input[type="checkbox"]')].every((el) => !el.checked));
  const submit = () => [...page.shadow().querySelectorAll("button")].find((b) => b.textContent.trim() === "Submit");
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
    await until(() => page.shadow()?.querySelector('[role="tab"]'), "panel");
    [...page.shadow().querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith("Form")).click();
    return [...page.shadow().querySelectorAll("button")].find((b) => b.textContent === "Submit");
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

test("Submit sits at the bottom of the Assistant tab too, disabled until every answer is in", async () => {
  const page = panelPage(() => ({}), { form: AUTO_FORM.replace('<label for="name">Full name</label>', '<label for="name">Favourite colour</label>') });
  page.start();
  const tabs = await until(() => page.shadow()?.querySelectorAll('[role="tab"]'), "tabs");
  assert.equal(tabs[0].getAttribute("aria-selected"), "true"); // Assistant
  const buttons = () => [...page.shadow().querySelectorAll("button")];
  assert.ok(!buttons().some((b) => /Auto apply/.test(b.textContent)));
  const submit = buttons().find((b) => b.textContent === "Submit");
  assert.equal(submit.disabled, true);
  assert.match(submit.title, /1 required field still needs you/);
  // The last thing in the panel, below the message box.
  const panel = page.shadow().querySelector(".composer").parentElement;
  assert.ok(panel.lastElementChild.contains(submit));

  // Answering the last question enables it.
  page.win.document.getElementById("name").value = "blue";
  page.win.document.getElementById("name").dispatchEvent(new page.win.Event("input", { bubbles: true }));
  await until(() => !buttons().find((b) => b.textContent === "Submit").disabled, "Submit enabled");
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
  await until(() => page.shadow().querySelector('[role="tab"]'), "filled panel");
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
  const tabs = await until(() => page.shadow()?.querySelectorAll('[role="tab"]'), "tabs");
  tabs[1].click();

  assert.equal(doc.querySelector("#exp").value, "5.6");
  assert.equal(doc.querySelector("#notice").textContent, "30 days");
  assert.equal(doc.querySelector("#gender").textContent, "Gender*"); // nothing to answer it with
  const text = page.shadow().textContent;
  assert.match(text, /1 thing left for you/);
  assert.doesNotMatch(text, /All set/);

  const submit = [...page.shadow().querySelectorAll("button")].find((b) => b.textContent === "Submit");
  assert.equal(submit.disabled, true);
  assert.match(submit.title, /1 required field still needs you/);
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
