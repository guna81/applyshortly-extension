// Phone numbers beside a country selector (src/page-control/dom.js in jsdom, src/shared/ui/panel-model.js).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const FILL_SRC = readFileSync(new URL("../src/page-control/phone.js", import.meta.url), "utf8") + readFileSync(new URL("../src/rule-based/profile-answer.js", import.meta.url), "utf8") + readFileSync(new URL("../src/page-control/dom.js", import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: "https://example.com/apply", runScripts: "outside-only" });
  dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  dom.window.eval(FILL_SRC);
  return { doc: dom.window.document, F: dom.window.JobHuntFill };
}

// The reported widget: the chosen country is shown twice (visible name and a screen-reader copy),
// and the selector's popup holds a search box that hides the phone label from the usual lookups.
const WIDGET = (tel = "+44") => `
  <label for="tel">Phone number *</label>
  <div id="row">
    <div id="country" role="combobox" tabindex="0" aria-haspopup="listbox" aria-controls="list"><span class="flag"></span><span>United Kingdom</span><span>United Kingdom</span></div>
    <div><input type="search" aria-label="Search countries"><ul id="list" role="listbox"><li role="option" aria-selected="true">United Kingdom (+44)</li><li role="option">India (+91)</li></ul></div>
    <input id="tel" type="tel" required value="${tel}">
  </div>`;

test("a selected country is a value: the selector asks for the phone country code", () => {
  const { doc, F } = page(WIDGET());
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(plain(fields.map((f) => f.label)), ["Phone country code", "Phone number"]);
  assert.equal(fields[0].required, true);
  assert.equal(F.dropdownValue(fields[0]), "United Kingdom");
});

test("flag-only phone country selector reads its selected option from its sibling listbox or title", () => {
  const { doc, F } = page(`
    <label for="phoneid">Phone *</label>
    <div class="react-international-phone-input-container">
      <div class="react-international-phone-country-selector">
        <button title="India" role="combobox" aria-label="Country selector" aria-haspopup="listbox" aria-expanded="false" type="button" data-country="in">
          <div><img data-country="in" alt=""><div></div></div>
        </button>
        <ul role="listbox" aria-activedescendant="opt-in" style="display: none;">
          <li role="option" aria-selected="false" aria-label="Afghanistan +93" id="opt-af">Afghanistan +93</li>
          <li role="option" aria-selected="true" aria-label="India +91" id="opt-in">India +91</li>
        </ul>
      </div>
      <input id="phoneid" type="tel" required value="+91 ">
    </div>`);
  const [country, number] = F.collectFields(doc, { checkLayout: false });
  assert.equal(country.label, "Phone country code");
  assert.equal(F.dropdownValue(country), "India +91");
  assert.equal(F.countryText(country), "India +91");
  assert.equal(F.isEmpty(country), true); // dial code only, phone number not yet filled
  doc.getElementById("phoneid").value = "+91 98765 43210";
  assert.equal(F.isEmpty(number), false);
  assert.equal(F.isEmpty(country), false);

  // When the listbox is unmounted (portal-style widget), fall back to the button's title.
  doc.querySelector('[role="listbox"]').remove();
  assert.equal(F.dropdownValue(country), "India");
  assert.equal(F.countryText(country), "India");
  assert.equal(F.isEmpty(country), false);
});

test("a dial code alone is an unanswered phone, and so is its country selector", () => {
  const { doc, F } = page(WIDGET("+44"));
  const [country, number] = F.collectFields(doc, { checkLayout: false });
  assert.equal(F.isEmpty(number), true);
  assert.equal(F.isEmpty(country), true);
  doc.getElementById("tel").value = "+44 7700 900123";
  assert.equal(F.isEmpty(number), false);
  assert.equal(F.isEmpty(country), false);
  doc.getElementById("tel").value = "+91 98765 43210";
  assert.equal(F.isEmpty(country), true); // the number is India's, the selector says UK
});

test("phone progress and splitting keep every digit", () => {
  const { F } = page("");
  assert.deepEqual(plain(F.splitInternational("+91 98765 43210")), { code: "+91", national: "9876543210" });
  assert.deepEqual(plain(F.splitInternational("+447700900123")), { code: "+44", national: "7700900123" });
  assert.equal(F.splitInternational("9876543210"), null);
  assert.equal(F.phoneProgress("+44").state, "prefix");
  assert.equal(F.phoneProgress("+44 77").state, "partial");
  assert.equal(F.phoneProgress("+44 7700 900123").state, "complete");
  assert.equal(F.dialOf("India (+91)"), "+91");
  assert.equal(F.dialOf("United Kingdom"), "+44");
});

test("a standalone country question is still a question", () => {
  const { doc, F } = page(`<label id="l">Country of residence *</label>
    <div id="res" role="combobox" tabindex="0" aria-haspopup="listbox" aria-labelledby="l">Select</div>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(plain(fields.map((f) => f.label)), ["Country of residence"]);
  assert.equal(fields[0].phoneFor, undefined);
  assert.equal(F.isEmpty(fields[0]), true);
});

test("a country-code option is chosen by whole dial code, not by substring", () => {
  const { F } = page("");
  const options = [{ text: "Bolivia (+591)" }, { text: "India (+91)" }, { text: "Ireland (+353)" }];
  assert.equal(F.chooseOption(options, "+91").text, "India (+91)");
  assert.equal(F.chooseOption([{ text: "India" }, { text: "Bolivia" }], "+91").text, "India");
});

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/shared/ui/panel-model.js", import.meta.url), "utf8"), ctx);
const P = ctx.JobHuntPanel;

test("an open phone is asked as the number, never as the selector's text", () => {
  const number = { kind: "text", label: "Phone number", required: true, el: { type: "tel" } };
  const country = { kind: "dropdown", label: "Phone country code", required: true, phoneFor: number };
  const prompt = P.nextPrompt([
    { field: country, status: "unresolved" },
    { field: number, status: "unresolved" },
  ]);
  assert.equal(prompt.question.label, "What phone number should we use?");
  assert.equal(prompt.target.field, number);
  const alone = P.nextPrompt([{ field: country, status: "unresolved" }]);
  assert.equal(alone.question.label, "Which country code does your phone number use?");
});
