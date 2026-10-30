// Tests for src/agent/page.js (the agent's in-frame half) in jsdom.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { ashbyYesNo } from "./ashby-fixture.mjs";

const plain = (x) => JSON.parse(JSON.stringify(x));
const FILL_SRC = readFileSync(new URL("../src/fill.js", import.meta.url), "utf8");
const PAGE_SRC = readFileSync(new URL("../src/agent/page.js", import.meta.url), "utf8");

function page(html, url = "https://careers.example.com/apply") {
  const dom = new JSDOM(`<!doctype html><title>Apply</title><body>${html}</body>`, { url, runScripts: "outside-only" });
  dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  // jsdom has no DataTransfer or DragEvent, and only takes a real FileList for input.files.
  dom.window.DataTransfer = class {
    constructor() { this.list = []; this.items = { add: (f) => this.list.push(f) }; }
    get files() { return this.list; }
  };
  dom.window.DragEvent = class extends dom.window.Event {
    constructor(type, init) { super(type, init); this.dataTransfer = init?.dataTransfer; }
  };
  Object.defineProperty(dom.window.HTMLInputElement.prototype, "files", {
    configurable: true,
    get() { return this.chosen ?? []; },
    set(value) { this.chosen = value; },
  });
  dom.window.eval(FILL_SRC);
  dom.window.eval(PAGE_SRC);
  const A = dom.window.JobHuntAgentPage;
  const observe = (opts = {}) => plain(A.observe({ checkLayout: false, ...opts }));
  return { doc: dom.window.document, win: dom.window, A, observe };
}

const byName = (obs, name) => obs.elements.find((e) => e.name === name);

test("observe: fields, radio options, buttons and the site's errors", () => {
  const { observe } = page(`
    <h1>Senior Engineer</h1>
    <form>
      <label for="fn">First name *</label><input id="fn" required>
      <label for="em">Email</label><input id="em" type="email" value="ada@example.com" aria-invalid="true" aria-describedby="em-err">
      <span id="em-err">Enter a valid email</span>
      <fieldset><legend>Willing to relocate?</legend>
        <label><input type="radio" name="rel" value="y"> Yes</label>
        <label><input type="radio" name="rel" value="n" checked> No</label>
      </fieldset>
      <label for="c">Country</label><select id="c"><option value="">Select</option><option>India</option><option>Japan</option></select>
      <label for="start">Start date</label><input id="start" type="date">
      <div contenteditable="true" aria-label="Cover note"></div>
      <label for="cv">Resume</label><input id="cv" type="file">
      <button type="button">Save &amp; Continue</button>
      <button type="submit">Submit application</button>
    </form>
    <a href="/jobs">All jobs</a>
    <a href="/privacy">Accept cookies</a>`);
  const obs = observe();
  assert.equal(obs.title, "Apply");
  assert.equal(obs.dialog, null);
  assert.deepEqual(obs.blockers, []);
  assert.match(obs.text, /Senior Engineer/);
  assert.deepEqual(
    obs.elements.map((e) => [e.role, e.name]),
    [
      ["textbox", "First name"],
      ["textbox", "Email"],
      ["radio", "Yes"],
      ["radio", "No"],
      ["select", "Country"],
      ["textbox", "Start date"],
      ["file", "Resume"],
      ["textarea", "Cover note"],
      ["button", "Save & Continue"],
      ["button", "Submit application"],
      ["link", "Accept cookies"],
    ],
  );
  const email = byName(obs, "Email");
  assert.equal(email.invalid, true);
  assert.equal(email.error, "Enter a valid email");
  assert.equal(byName(obs, "First name").required, true);
  const no = byName(obs, "No");
  assert.equal(no.group, "Willing to relocate?");
  assert.equal(no.checked, true);
  assert.deepEqual(byName(obs, "Country").options, ["India", "Japan"]);
  assert.equal(byName(obs, "Start date").input_type, "date");
  assert.equal(byName(obs, "Cover note").input_type, "richtext");
  assert.equal(byName(obs, "Submit application").submit_like, true);
  assert.equal(byName(obs, "Save & Continue").submit_like, false);
  // Refs are stable across observations of the same page.
  assert.equal(observe().elements[0].ref, obs.elements[0].ref);
});

test("observe: an open modal limits the view to it (LinkedIn-style Easy Apply)", () => {
  const { observe } = page(`
    <input aria-label="Search jobs">
    <button>Easy Apply</button>
    <div role="dialog" aria-label="Apply to Acme">
      <label for="ph">Mobile phone number</label><input id="ph" type="tel">
      <button>Next</button>
    </div>`);
  const obs = observe();
  assert.equal(obs.dialog, "Apply to Acme");
  assert.deepEqual(obs.elements.map((e) => e.name), ["Mobile phone number", "Next"]);
});

test("observe: open shadow roots, CAPTCHAs and sign-in pages", () => {
  const { doc, win, observe } = page(`<div id="host"></div><div class="g-recaptcha"></div>`, "https://ats.example.com/login");
  const shadow = doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = `<label for="city">City</label><input id="city"><button>Next</button>`;
  const closed = doc.createElement("jobhunt-autofill-panel");
  closed.attachShadow({ mode: "open" }).innerHTML = "<button>Panel button</button>";
  doc.body.append(closed);
  const obs = observe();
  assert.deepEqual(obs.elements.map((e) => e.name), ["City", "Next"]); // never the extension's own panel
  assert.deepEqual(obs.blockers, ["captcha", "login"]);
  assert.equal(observe({ isTop: false }).blockers.includes("login"), false); // URL check: top frame only
  assert.ok(win.document.querySelector("#host").shadowRoot.querySelector("[data-applyshortly-ref]"));
});

test("actions: clickable refuses the final submit; native selects, dates and uploads", async () => {
  const { A, doc, observe } = page(`
    <label for="a">Name</label><input id="a">
    <label for="b">Email</label><input id="b" type="email">
    <label for="c">Country</label><select id="c"><option value="">Select</option><option value="in">India</option><option value="jp">Japan</option></select>
    <label for="d">Start date</label><input id="d" type="date">
    <label for="f">Resume</label><input id="f" type="file">
    <div id="drop" aria-label="Drop your CV here"></div>
    <button type="submit">Submit application</button>
    <button type="button">Envoyer ma candidature</button>
    <button type="button">Bewerbung absenden</button>
    <button type="button">Next</button>
    <button type="button">Weiter</button>`);
  const obs = observe();
  const ref = (name) => byName(obs, name).ref;
  assert.equal(A.clickable(ref("Submit application"), false), "Submitting is left to you.");
  // Localized submit buttons are refused and reported as submit-like for the server's policy.
  for (const name of ["Envoyer ma candidature", "Bewerbung absenden"]) {
    assert.equal(A.clickable(ref(name), false), "Submitting is left to you.");
    assert.equal(byName(obs, name).submit_like, true);
  }
  assert.equal(A.clickable(ref("Next"), false), null);
  assert.equal(A.clickable(ref("Weiter"), false), null);
  assert.equal(A.clickable("999"), "That element is gone from the page.");

  assert.deepEqual(plain(A.selectNative(ref("Country"), "japan")), { ok: true, native: true, value: "Japan" });
  assert.equal(doc.getElementById("c").value, "jp");
  assert.equal(A.selectNative(ref("Country"), "Mars").ok, false);
  assert.equal(A.selectNative(ref("Name"), "x").native, false);

  assert.equal(A.focusForTyping(ref("Start date")).mode, "direct");
  assert.equal(A.setDirect(ref("Start date"), "05/01/2026").ok, true);
  assert.equal(doc.getElementById("d").value, "2026-01-05");
  assert.equal(A.normaliseDate("month", "2026-03-09"), "2026-03");
  // A month alone is the first of the month for a date box (profiles store jobs as "2020-12").
  assert.equal(A.normaliseDate("date", "2020-12"), "2020-12-01");
  assert.equal(A.normaliseDate("month", "2020-12"), "2020-12");
  assert.equal(A.normaliseDate("date", "2023-01-15"), "2023-01-15");
  assert.equal(A.focusForTyping(ref("Name")).mode, "keys");

  const b64 = Buffer.from("%PDF-1.4").toString("base64");
  assert.deepEqual(plain(A.attach(ref("Resume"), b64, "Ada_Resume.pdf", "application/pdf")), { ok: true, value: "Ada_Resume.pdf" });
  assert.deepEqual(plain(A.state(ref("Resume"))), { value: "Ada_Resume.pdf" });
  // A drop zone with no file input gets the file as a drop.
  const drop = doc.getElementById("drop");
  drop.setAttribute("data-applyshortly-ref", "drop");
  let dropped = null;
  drop.addEventListener("drop", (e) => { dropped = e.dataTransfer.files[0].name; });
  assert.equal(A.attach("drop", b64, "Ada_Resume.pdf", "application/pdf").ok, true);
  assert.equal(dropped, "Ada_Resume.pdf");
});

test("actions: options of an open dropdown are matched to the answer", () => {
  const { A, observe } = page(`
    <label id="l">Location</label>
    <input role="combobox" aria-labelledby="l" aria-controls="lb">
    <ul id="lb" role="listbox"><li role="option">Bengaluru, Karnataka, India</li><li role="option">Bengkulu, Indonesia</li></ul>`);
  const obs = observe();
  const combo = obs.elements.find((e) => e.role === "textbox" || e.role === "combobox");
  const match = plain(A.matchOption(combo.ref, "Bengaluru", false));
  assert.equal(match.ok, true);
  assert.equal(match.text, "Bengaluru, Karnataka, India");
  const none = plain(A.matchOption(combo.ref, "Tokyo", false));
  assert.equal(none.ok, false);
  assert.deepEqual(none.options, ["Bengaluru, Karnataka, India", "Bengkulu, Indonesia"]);
});

test("settle resolves once the DOM is quiet", async () => {
  const { A, doc, win } = page(`<div id="x"></div>`);
  let n = 0;
  const timer = win.setInterval(() => { if (n++ < 3) doc.getElementById("x").textContent = String(n); }, 50);
  const started = Date.now();
  assert.equal(await A.settle(120, 2000), "complete");
  win.clearInterval(timer);
  assert.ok(Date.now() - started >= 120);
});

test("matchOption finds a plain list that appeared after noteShown, when nothing has ARIA roles", () => {
  const { doc, A, observe } = page(`
    <label for="sal">Salutation *</label><input id="sal" role="combobox" placeholder="Select" required>
    <ul class="menu" hidden><li>Miss</li><li>Mr.</li><li>Mrs.</li></ul>`);
  const combo = byName(observe(), "Salutation");
  assert.ok(combo);
  assert.equal(A.noteShown(false), true);
  doc.querySelector(".menu").hidden = false; // what the click opens
  const match = plain(A.matchOption(combo.ref, "Mr", false));
  assert.equal(match.ok, true);
  assert.equal(match.text, "Mr.");
  assert.equal(doc.querySelector(`[data-applyshortly-ref="${match.ref}"]`).textContent, "Mr.");
});

test("observe: a closed combobox lists the options its listbox already holds, without -None-", () => {
  const { observe, A } = page(`
    <label id="g">Gender</label>
    <div role="combobox" aria-labelledby="g" aria-haspopup="listbox" aria-controls="gender-list">-None-</div>
    <div id="gender-list" role="listbox">
      <div role="option">-None-</div><div role="option">Male</div><div role="option">Female</div>
    </div>
    <label id="t">Title</label><div role="combobox" aria-labelledby="t" aria-haspopup="listbox" aria-controls="later"></div>`);
  const obs = observe();
  assert.deepEqual(byName(obs, "Gender").options, ["Male", "Female"]);
  assert.deepEqual(byName(obs, "Title").options, []);
  assert.deepEqual(plain(A.shownChoices(byName(obs, "Gender").ref, false)), ["Male", "Female"]);
});


test("Ashby yes/no observations retain the question, requirement and selected No", () => {
  const { doc, observe } = page(ashbyYesNo());
  let radios = observe().elements.filter((e) => e.role === "radio");
  assert.equal(radios.length, 2);
  assert.ok(radios.every((e) => e.required && e.group === "Have you used Python professionally?" && !e.checked));
  doc.querySelector('[data-option="no"]').setAttribute("aria-pressed", "true");
  radios = observe().elements.filter((e) => e.role === "radio");
  assert.equal(radios.find((e) => e.name === "No").checked, true);
});

test("screenshot ref labels use merged refs, do not intercept input, and are removed", () => {
  const { doc, A, observe } = page('<label for="n">Full name</label><input id="n">');
  const ref = byName(observe(), "Full name").ref;
  doc.querySelector("#n").getBoundingClientRect = () => ({ left: 10, top: 30, bottom: 50, width: 100, height: 20 });
  A.screenshotRefs([{ local: ref, ref: `2.${ref}` }]);
  const layer = doc.querySelector("[data-applyshortly-screenshot-refs]");
  assert.equal(layer.textContent, `2.${ref}`);
  assert.equal(layer.style.pointerEvents, "none");
  A.clearScreenshotRefs();
  assert.equal(doc.querySelector("[data-applyshortly-screenshot-refs]"), null);
});
