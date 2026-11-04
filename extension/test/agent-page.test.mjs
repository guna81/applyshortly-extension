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
    // In page order, not grouped by kind: questions are asked in the order the form shows them.
    obs.elements.map((e) => [e.role, e.name]),
    [
      ["textbox", "First name"],
      ["textbox", "Email"],
      ["radio", "Yes"],
      ["radio", "No"],
      ["select", "Country"],
      ["textbox", "Start date"],
      ["textarea", "Cover note"],
      ["file", "Resume"],
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
  assert.deepEqual(plain(await A.attach(ref("Resume"), b64, "Ada_Resume.pdf", "application/pdf")), { ok: true, value: "Ada_Resume.pdf" });
  assert.deepEqual(plain(A.state(ref("Resume"))), { value: "Ada_Resume.pdf" });
  // A drop zone with no file input gets the file as a drop.
  const drop = doc.getElementById("drop");
  drop.setAttribute("data-applyshortly-ref", "drop");
  // A zone that ignores the drop shows nothing: reported, never claimed as attached.
  const ignored = await A.attach("drop", b64, "Ada_Resume.pdf", "application/pdf");
  assert.equal(ignored.ok, false);
  assert.match(ignored.detail, /didn't take the file/);
  let dropped = null;
  drop.addEventListener("drop", (e) => { dropped = e.dataTransfer.files[0].name; drop.append(` ${dropped}`); });
  assert.equal((await A.attach("drop", b64, "Ada_Resume.pdf", "application/pdf")).ok, true);
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

test("matchOption finds an option past the first hundred of a long list (Greenhouse's country picker)", () => {
  // 244 react-select options in the owned listbox, India at 101, plus the intl-tel-input copy
  // of the list (also role=option) that the combobox does not own.
  const options = Array.from({ length: 244 }, (_, i) => (i === 31 ? "British Indian Ocean Territory +246" : i === 101 ? "India +91" : `Country ${i} +${i + 300}`));
  const { A, observe } = page(`
    <label id="l">Country</label>
    <input id="country" role="combobox" aria-labelledby="l" aria-controls="lb" aria-haspopup="true">
    <div id="lb" role="listbox">${options.map((t, i) => `<div role="option" id="o${i}">${t}</div>`).join("")}</div>
    <ul role="listbox">${options.map((t) => `<li role="option">${t.replace(" +", "+")}</li>`).join("")}</ul>`);
  const combo = observe().elements.find((e) => e.role === "textbox" || e.role === "combobox");
  for (const answer of ["India +91", "India (+91)", "India"]) {
    const match = plain(A.matchOption(combo.ref, answer, false));
    assert.equal(match.ok, true, answer);
    assert.equal(match.text, "India +91", answer);
  }
});

test("observe: a box reports the input mode and pattern it declares, so a value can be shaped to fit", () => {
  const { observe } = page(`
    <form>
      <label for="ph">WhatsApp number *</label><input id="ph" type="text" pattern="[0-9 ]*" inputmode="numeric" required>
      <label for="nm">Full name</label><input id="nm">
    </form>`);
  const phone = byName(observe(), "WhatsApp number");
  assert.equal(phone.input_mode, "numeric");
  assert.equal(phone.pattern, "[0-9 ]*");
  const name = byName(observe(), "Full name");
  assert.equal(name.input_mode, undefined);
  assert.equal(name.pattern, undefined);
});

test("observe: a bare Attach button takes its name from the group around it (Greenhouse's upload fields)", () => {
  const { observe } = page(`
    <div role="group" aria-labelledby="upload-label-resume"><div id="upload-label-resume">Resume/CV <span>*</span></div>
      <div><button type="button">Attach</button><label for="resume">Attach</label><input id="resume" type="file"></div></div>
    <div role="group" aria-labelledby="upload-label-cover_letter"><div id="upload-label-cover_letter">Cover Letter</div>
      <div><button type="button">Attach</button><label for="cover_letter">Attach</label><input id="cover_letter" type="file"></div></div>
    <label for="cv2">Upload your résumé</label><input id="cv2" type="file">`);
  const files = observe().elements.filter((e) => e.role === "file");
  assert.deepEqual(files.map((f) => f.name), ["Resume/CV", "Cover Letter", "Upload your résumé"]);
  assert.deepEqual(files.map((f) => f.required), [true, false, false]);
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

test("observe lists disabled dependent fields as disabled, so the planner waits for them", () => {
  const { observe } = page(`
    <label for="co">Country</label><input id="co">
    <label for="st">State / Region</label><input id="st" disabled>
    <label for="ct">City / Town</label><input id="ct" aria-disabled="true">`);
  const obs = observe();
  const country = byName(obs, "Country");
  const state = byName(obs, "State / Region");
  const city = byName(obs, "City / Town");
  assert.equal(country.disabled, false);
  assert.equal(state.disabled, true);
  assert.equal(state.role, "textbox");
  assert.equal(city.disabled, true);
  // Disabled entries follow the fillable ones, and never duplicate them.
  assert.ok(obs.elements.indexOf(state) > obs.elements.indexOf(country));
  assert.equal(obs.elements.filter((e) => e.name === "Country").length, 1);
  // Once enabled, the field is a normal fillable element again.
  const { observe: observeEnabled } = page(`<label for="st">State / Region</label><input id="st">`);
  assert.equal(byName(observeEnabled(), "State / Region").disabled, false);
});

test("typedSuggestion commits a typeahead pick after typing; a plain answer stays", () => {
  const { doc, A, observe } = page(`
    <label for="co">Country</label><input id="co" role="combobox" aria-expanded="true" aria-controls="co-list">
    <ul id="co-list" role="listbox" hidden><li role="option">India</li><li role="option">Indonesia</li></ul>
    <label for="nm">Nickname</label><input id="nm">
    <ul class="suggestions" hidden><li>Indie</li><li>Indigo</li></ul>`);
  const obs = observe();
  const country = byName(obs, "Country");
  assert.equal(country.role, "textbox"); // an editable combobox reads as a text box
  doc.querySelector("#co-list").hidden = false; // what typing opened
  const pick = plain(A.typedSuggestion(country.ref, "India", false));
  assert.equal(pick.ok, true);
  assert.equal(doc.querySelector(`[data-applyshortly-ref="${pick.ref}"]`).textContent, "India");

  // A plain box with no ARIA: only a list that appeared after noteShown counts.
  const nickname = byName(obs, "Nickname");
  assert.equal(plain(A.typedSuggestion(nickname.ref, "Indie", false)).ok, false); // no noteShown yet
  A.noteShown(false);
  assert.equal(plain(A.typedSuggestion(nickname.ref, "Indie", false)).ok, false); // nothing appeared
  doc.querySelector(".suggestions").hidden = false; // the widget answered the typing
  const again = plain(A.typedSuggestion(nickname.ref, "Indie", false));
  assert.equal(again.ok, true);
  assert.equal(doc.querySelector(`[data-applyshortly-ref="${again.ref}"]`).textContent, "Indie");
});

test("typedSuggestion commits a list that typing narrowed to one match", () => {
  const { doc, A, observe } = page(`
    <label for="co">Country</label><input id="co" placeholder="Search...">
    <ul class="list" hidden><li>India</li></ul>`);
  const country = byName(observe(), "Country");
  A.noteShown(false);
  doc.querySelector(".list").hidden = false; // typing "India" filtered the list to one
  const pick = plain(A.typedSuggestion(country.ref, "India", false));
  assert.equal(pick.ok, true);
  assert.equal(doc.querySelector(`[data-applyshortly-ref="${pick.ref}"]`).textContent, "India");
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
  assert.deepEqual([...layer.querySelectorAll("span")].map((s) => s.textContent), [`2.${ref}`]);
  assert.equal(layer.style.pointerEvents, "none");
  // A manual popover, so the labels also show over a site modal in the browser's top layer.
  assert.equal(layer.getAttribute("popover"), "manual");
  A.clearScreenshotRefs();
  assert.equal(doc.querySelector("[data-applyshortly-screenshot-refs]"), null);
});

test("observation includes location instructions and excludes hidden/panel text", () => {
  const { observe } = page(`<p>Choose country before city.</p><label>City / Town</label><input placeholder="Search..."><p hidden>Secret instructions</p><jobhunt-autofill-panel><p>Assistant conversation</p></jobhunt-autofill-panel>`);
  const obs = observe();
  assert.match(obs.text, /City \/ Town/);
  assert.match(obs.text, /Choose country before city/);
  assert.doesNotMatch(obs.text, /Secret instructions|Assistant conversation/);
});

test("snapshot hiding restores the panel's original visibility", () => {
  const { doc, A } = page('<jobhunt-autofill-panel style="visibility:visible!important"></jobhunt-autofill-panel>');
  const panel = doc.querySelector("jobhunt-autofill-panel");
  A.snapshotState(true);
  assert.equal(panel.style.visibility, "hidden");
  A.snapshotState(false);
  assert.equal(panel.style.visibility, "visible");
  assert.equal(panel.style.getPropertyPriority("visibility"), "important");
});

test("focused discovery can inspect a city control beyond the normal observation limit", () => {
  const { observe } = page(Array.from({ length: 310 }, (_, i) => `<label>Name ${i}<input></label>`).join("") + '<label>City / Town<input></label>');
  const normal = observe();
  assert.equal(byName(normal, "City / Town"), undefined);
  const focused = observe({ extended: true, query: "City" });
  assert.ok(byName(focused, "City / Town"));
  assert.ok(focused.coverage.some((t) => /Focused view/.test(t)));
});

test("Escape is pressed only into an open list, never into the application dialog", () => {
  const { A, doc, observe } = page(`
    <div role="dialog" aria-label="Apply to Acme">
      <label for="c">Country</label><input id="c" role="combobox" aria-expanded="false" aria-controls="list">
      <ul id="list" role="listbox" hidden><li role="option">India</li></ul>
      <label for="n">Name</label><input id="n">
    </div>`);
  const obs = observe();
  const country = byName(obs, "Country").ref;
  assert.equal(A.pickerOpen(country, false), false);
  assert.equal(A.prepareKey(country, "Escape"), false);
  doc.getElementById("c").setAttribute("aria-expanded", "true");
  assert.equal(A.pickerOpen(country, false), true);
  assert.equal(A.prepareKey(country, "Escape"), true);
});

test("Enter goes only into an open list: on a closed picker it would submit the form (Greenhouse)", () => {
  const { A, doc, observe } = page(`<form>
      <label for="c">Country</label><input id="c" role="combobox" aria-expanded="false" aria-controls="list">
      <div id="list" role="listbox" hidden><div role="option">India +91</div></div>
      <label for="s">State</label><select id="s"><option>TN</option></select>
    </form>`);
  const obs = observe();
  const country = byName(obs, "Country").ref;
  assert.equal(A.prepareKey(country, "Enter"), false);
  assert.equal(A.prepareKey(country, "ArrowDown"), true); // opening it is fine
  doc.getElementById("c").setAttribute("aria-expanded", "true");
  assert.equal(A.prepareKey(country, "Enter"), true);
  assert.equal(A.prepareKey(byName(obs, "State").ref, "Enter"), true); // a native select doesn't submit
});

test("hasText finds visible text for wait_for, never the panel's own text", () => {
  const { A, doc } = page(`<p>Uploading…</p><jobhunt-autofill-panel>Upload complete</jobhunt-autofill-panel>`);
  assert.equal(A.hasText("upload complete", false), false);
  doc.querySelector("p").textContent = "Upload complete";
  assert.equal(A.hasText("Upload complete", false), true);
});

test("rebind: a re-rendered control gets its old ref back; ambiguous names do not", () => {
  const { doc, A, observe } = page(`<label for="e">Email</label><input id="e" type="email"><label for="n">Name</label><input id="n"><label for="m">Name</label><input id="m">`);
  const email = byName(observe(), "Email");
  assert.equal(A.freshState(email.ref).present, true);
  // The site replaces the node (React key change): the ref attribute is gone with it.
  doc.getElementById("e").replaceWith(Object.assign(doc.createElement("input"), { id: "e", type: "email" }));
  assert.equal(A.freshState(email.ref).present, false);
  assert.equal(A.rebind(email.ref, "Email", "textbox"), true);
  assert.equal(A.freshState(email.ref).present, true);
  assert.equal(A.rebind("999", "Name", "textbox"), false); // two controls share the name
});

test("committedValue: reads a plain input and a native select", () => {
  const { doc, A, observe } = page(`<label for="t">City</label><input id="t" value="Trichy"><label for="s">Country</label><select id="s"><option value="">Choose</option><option selected>India</option></select>`);
  const obs = observe();
  assert.equal(A.committedValue(byName(obs, "City").ref), "Trichy");
  assert.equal(A.committedValue(byName(obs, "Country").ref), "India");
  assert.equal(doc.getElementById("t").value, "Trichy");
});

test("committedValue: a rich-text box (contenteditable) reads back its text, not an empty value", () => {
  const { doc, A, observe } = page(`<div id="q" role="textbox" contenteditable="true" aria-label="Describe an integration you built"></div>`);
  const obs = observe();
  const box = byName(obs, "Describe an integration you built");
  assert.equal(A.committedValue(box.ref), "", "empty before anything is typed");
  doc.getElementById("q").textContent = "Built a RAG pipeline  with Redis caching";
  assert.equal(A.committedValue(box.ref), "Built a RAG pipeline with Redis caching");
});

test("an Airtable-style plaintext-only box is observed with the text it holds", () => {
  const { doc, observe } = page(`<div id="q" role="textbox" contenteditable="plaintext-only" aria-label="Describe an integration you built"></div>`);
  assert.equal(byName(observe(), "Describe an integration you built").value, "");
  doc.getElementById("q").textContent = "Built a RAG pipeline with Redis caching";
  const box = byName(observe(), "Describe an integration you built");
  assert.equal(box.value, "Built a RAG pipeline with Redis caching", "the next observation shows the filled text, not an empty box");
  assert.equal(box.input_type, "richtext");
});

test("a search-style react-select reports its pick as the value and reads it back", () => {
  const { A, observe } = page(`
    <label for="city">Location (City)</label>
    <div class="select__control"><div class="select__value-container select__value-container--has-value">
      <div class="select__single-value">Trichy, Tamil Nadu, India</div>
      <div class="select__input-container"><input id="city" class="select__input" type="text" role="combobox" aria-haspopup="true" aria-autocomplete="list"></div>
    </div></div>
    <label for="q">Reference calls</label>
    <div class="select__control"><div class="select__value-container">
      <div class="select__input-container"><input id="q" class="select__input" type="text" role="combobox" aria-haspopup="true" aria-autocomplete="list" value="Yes"></div>
    </div></div>`);
  const obs = observe();
  const city = byName(obs, "Location (City)");
  assert.equal(city.value, "Trichy, Tamil Nadu, India");
  assert.equal(city.popup, true);
  assert.equal(A.committedValue(city.ref, true), "Trichy, Tamil Nadu, India");
  const typed = byName(obs, "Reference calls");
  assert.equal(A.committedValue(typed.ref), "Yes", "search text is the plain value");
  assert.equal(A.committedValue(typed.ref, true), "", "but nothing was picked");
});

test("an Airtable-style dropdown (a div named by itself) reads back the choice it shows", () => {
  const { A, observe, doc } = page(`
    <div id="lab">Authorized to Call</div>
    <div role="combobox" aria-labelledby="lab self" aria-required="true" aria-expanded="false" tabindex="0" data-testid="autocomplete-button"><div><span><span><span><div><div id="self"></div></div></span></span></span></div></div>`);
  const before = byName(observe(), "Authorized to Call");
  assert.ok(before, "found by its question: " + JSON.stringify(observe().elements.map((e) => [e.role, e.name])));
  doc.getElementById("self").textContent = "Yes";
  const after = observe().elements.find((e) => e.role === "combobox");
  assert.equal(after.value, "Yes");
  assert.equal(A.committedValue(after.ref), "Yes");
});

test("a drop that opens the site's own upload dialog counts once the dialog lists the file", async () => {
  const { A, doc } = page(`<div id="zone"><span>Drop files here or click to browse</span></div><div id="portal"></div>`);
  const zone = doc.getElementById("zone");
  zone.setAttribute("data-applyshortly-ref", "zone");
  const b64 = Buffer.from("%PDF-1.4").toString("base64");
  // Airtable shows the dropped file in a dialog elsewhere on the page, never inside the zone.
  zone.addEventListener("drop", () => {
    doc.getElementById("portal").innerHTML = `<div role="dialog"><button aria-label="View attachment ”Ada_Resume.pdf”"></button><button>Attach file</button></div>`;
  });
  assert.equal((await A.attach("zone", b64, "Ada_Resume.pdf", "application/pdf")).ok, true);
});

test("a div-style dropdown the form mapper skips still reads back the choice it shows", () => {
  const { A, doc } = page(`<div id="d" role="combobox" aria-disabled="true"><div><span>Yes</span></div></div>
    <div id="e" role="combobox" aria-disabled="true"><div><span>Select…</span></div></div>`);
  doc.getElementById("d").setAttribute("data-applyshortly-ref", "d");
  doc.getElementById("e").setAttribute("data-applyshortly-ref", "e");
  assert.equal(A.committedValue("d"), "Yes");
  assert.equal(A.committedValue("d", true), "Yes");
  assert.equal(A.committedValue("e") ?? "", "", "a prompt is no choice");
});

test("a dropdown whose chosen text sits in an aria-hidden wrapper reads back the choice (Airtable)", () => {
  const { A, observe } = page(`
    <div id="lab">Authorized to Call</div>
    <div role="combobox" aria-labelledby="lab id_x" aria-required="true" aria-expanded="false" tabindex="0" data-testid="autocomplete-button"><div><span aria-hidden="true"><span><div><div id="id_x" title="Yes">Yes</div></div></span></span></div></div>
    <div id="lab2">Source</div>
    <div role="combobox" aria-labelledby="lab2" aria-required="false" aria-expanded="false" tabindex="0"><div><span aria-hidden="true"></span></div></div>`);
  const combos = observe().elements.filter((e) => e.role === "combobox");
  const yes = combos.find((e) => /Authorized/.test(e.name));
  assert.equal(yes.value, "Yes");
  assert.equal(A.committedValue(yes.ref), "Yes");
  assert.equal(A.committedValue(yes.ref, true), "Yes");
  const source = combos.find((e) => /Source/.test(e.name));
  assert.equal(source.value, "", "nothing chosen yet");
});

test("a drop counts when the site's upload dialog from an earlier drop already lists the file", async () => {
  const { A, doc } = page(`<div id="zone"><span>Drop files here or click to browse</span></div>
    <div role="dialog"><button aria-label="View attachment ”Ada_Resume.pdf”"></button><button>Attach file</button></div>`);
  doc.getElementById("zone").setAttribute("data-applyshortly-ref", "zone");
  const b64 = Buffer.from("%PDF-1.4").toString("base64");
  assert.equal((await A.attach("zone", b64, "Ada_Resume.pdf", "application/pdf")).ok, true);
  // Without a dialog, a name elsewhere on the page proves nothing.
  const other = page(`<div id="zone"><span>Drop files here</span></div><p>Ada_Resume.pdf was uploaded last year</p>`);
  other.doc.getElementById("zone").setAttribute("data-applyshortly-ref", "zone");
  assert.equal((await other.A.attach("zone", b64, "Ada_Resume.pdf", "application/pdf")).ok, false);
});
