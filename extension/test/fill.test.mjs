// Tests for src/fill.js in jsdom. Run: node --test extension/test (run npm ci first).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { test } from "node:test";

// Values built inside the jsdom window have its prototypes; compare plain copies.
const plain = (x) => JSON.parse(JSON.stringify(x));
const FILL_SRC = readFileSync(new URL("../src/fill.js", import.meta.url), "utf8");

function page(html, url = "https://example.com/apply") {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: "outside-only" });
  // jsdom has no CSS.escape; Chrome does.
  dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  dom.window.eval(FILL_SRC);
  return { doc: dom.window.document, F: dom.window.JobHuntFill, win: dom.window };
}

const PROFILE = {
  full_name: "Ada Lovelace King",
  email: "ada@example.com",
  phone: "+44 20 7946 0000",
  location: "London, UK",
  links: [{ label: "LinkedIn", url: "https://linkedin.com/in/ada" }, { label: "GitHub", url: "https://github.com/ada" }],
  summary: "Engineer.",
  total_experience_years: 5.6,
  skills: [],
  experience: [
    { title: "Engineer", company: "Babbage & Co", start_date: "2020-01", end_date: "2023-01", is_current: false },
    { title: "Lead Engineer", company: "Analytical Engines", start_date: "2023-02", end_date: null, is_current: true },
  ],
  education: [
    { degree: "B.Sc.", field_of_study: "Mathematics", institution: "University of London", end_year: 2015 },
    { degree: "M.Sc.", field_of_study: "Computing", institution: "Imperial College", end_year: 2017 },
  ],
};

// Reduced from Rippling's live application markup; no applicant data.
const ripplingQuestion = (caption, control, required = true) => `<div class="marginY--36">
  <div><div><p>${caption}${required ? '<span>*</span>' : ''}</p></div></div>
  <div data-testid="field"><div><div data-testid="customQuestions.fixture">${control}</div></div></div>
</div>`;

test("Rippling custom text and radio questions retain captions, required markers and readable options", () => {
  const { doc, F } = page(ripplingQuestion("What is your current/lasy salary package?", '<input name="randomValue" maxlength="50">') +
    ripplingQuestion("Any prior experience working in startups?", '<div><div role="radiogroup">' +
      ["Strong No", "No", "Yes", "Strong Yes"].map((text, i) => `<div role="radio" data-value="${i + 1}" aria-label="${text}" aria-checked="false">${text}</div>`).join('') + '</div></div>'));
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(plain(fields.map(({ label, required }) => ({ label, required }))), [
    { label: "What is your current/lasy salary package?", required: true },
    { label: "Any prior experience working in startups?", required: true },
  ]);
  assert.deepEqual(plain(fields[1].options.map((o) => o.text)), ["Strong No", "No", "Yes", "Strong Yes"]);
  assert.equal(F.apply(fields[0], "A".repeat(51)), null);
  assert.equal(fields[0].el.value, "");
  // React creates invalid-in-HTML p > div nesting directly through DOM APIs.
  for (const caption of doc.querySelectorAll("p")) {
    caption.querySelector("span").remove();
    caption.append(doc.createElement("div"));
  }
  assert.ok(F.collectFields(doc, { checkLayout: false }).every((f) => f.required));
});

test("Rippling upload reads its field caption and required flag, and nested radios aren't duplicated", () => {
  const { doc, F } = page(`<div data-testid="field"><div><span id="resume-label">Résumé</span><span>*</span></div>
    <div><label aria-labelledby="file-input resume-label"><input type="File"><button>Drop or select (.pdf)</button></label></div></div>
    <div role="radiogroup" aria-label="SMS consent"><div role="radio" aria-label="Yes" data-value="true"><input type="radio" name="sms"></div>
    <div role="radio" aria-label="No" data-value="false"><input type="radio" name="sms"></div></div>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.equal(fields[0].label, "Résumé");
  assert.equal(fields[0].required, true);
  assert.equal(fields.filter((f) => f.kind === "radio").length, 1);
});

test("Rippling split phone control fills a country code before the national number", () => {
  const { doc, F } = page(`<div data-testid="field"><div data-testid="phone_number-code"><input role="combobox" aria-label="Search" value="+44 GB"></div></div>
    <label>Phone number<input data-input="phone_number"></label>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  const code = fields[0];
  assert.equal(code.kind, "dropdown");
  assert.equal(code.label, "Phone country code");
  assert.equal(F.isEmpty(code), true);
  assert.equal(F.profileAnswer(code.label, { phone: "919876543210" }).value, "+91");
  code.el.value = "+91 IN";
  assert.equal(F.apply(fields[1], "919876543210"), "9876543210");
  assert.equal(F.isEmpty(code), false);
});

test("Contact Form 7: required questions, option groups and hidden anti-spam field", () => {
  const fixture = `<!doctype html>
<!-- Contact Form 7 structure from AkraTech's AI Developer form. No external scripts. -->
<form class="wpcf7-form" novalidate>
  <p><label>Name*<br><span class="wpcf7-form-control-wrap"><input name="your-name" aria-required="true"></span></label></p>
  <p><label>Email*<br><span class="wpcf7-form-control-wrap"><input name="your-email" type="email" aria-required="true"></span></label></p>
  <p><label>Qualification*<br><span class="wpcf7-form-control-wrap"><input name="your-qualification" aria-required="true"></span></label></p>
  <p><label>Exp. in IT Industry*<br><span class="wpcf7-form-control-wrap"><input name="ExpInItIndustry" type="number" min="1" max="50"></span></label></p>
  <p><label>Willing to Relocate*</label><br>
    <span class="wpcf7-form-control-wrap"><span class="wpcf7-radio">
      <span class="wpcf7-list-item"><label><input type="radio" name="radio-743" value="Yes" checked><span>Yes</span></label></span>
      <span class="wpcf7-list-item"><label><input type="radio" name="radio-743" value="No"><span>No</span></label></span>
    </span></span>
  </p>
  <p><label>Programming Languages*</label><br>
    <span class="wpcf7-form-control-wrap"><span class="wpcf7-checkbox wpcf7-validates-as-required">
      <span class="wpcf7-list-item"><input type="checkbox" name="programming-languages[]" value="Python"><span class="wpcf7-list-item-label">Python</span></span>
      <span class="wpcf7-list-item"><input type="checkbox" name="programming-languages[]" value="SQL"><span class="wpcf7-list-item-label">SQL</span></span>
    </span></span>
  </p>
  <p><label>Post Resume [.pdf/.doc/.docx]*<br><span class="wpcf7-form-control-wrap"><input type="file" name="resume" aria-required="true"></span></label></p>
  <p style="display:none !important"><label>Δ<textarea name="_wpcf7_ak_hp_textarea"></textarea></label></p>
  <input type="submit" value="Send">
</form>`;
  const { doc, F } = page(fixture);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.equal(fields.length, 7);
  assert.ok(fields.every((f) => f.required));
  assert.ok(fields.every((f) => f.el.name !== "_wpcf7_ak_hp_textarea"));
  const radio = fields.find((f) => f.kind === "radio");
  assert.equal(radio.label, "Willing to Relocate");
  assert.deepEqual(plain(radio.options.map((o) => o.text)), ["Yes", "No"]);
  const group = fields.find((f) => f.kind === "checkbox");
  assert.equal(group.label, "Programming Languages");
  assert.deepEqual(plain(group.options.map((o) => o.text)), ["Python", "SQL"]);
  assert.ok(group.options.every((o) => !o.el.checked), "leaves skill choices to the user");
  assert.equal(F.apply(group, "SQL"), null, "does not auto-tick checkbox groups");
  assert.equal(F.findSubmitButton(doc, fields, { checkLayout: false })?.value, "Send");
  assert.equal(F.profileAnswer("Qualification", PROFILE, null).value, "M.Sc. Computing");
  assert.equal(F.profileAnswer("Exp. in IT Industry", PROFILE, null).value, "5.6 years");
});

test("Send is accepted only as a native submit in the identified application form", () => {
  const { doc, F } = page(`<form><input name="name"><button type="button">Send</button></form>
    <form><input type="submit" value="Send"></form>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.equal(F.findSubmitButton(doc, fields, { checkLayout: false }), null);
  doc.querySelector('button').type = "submit";
  assert.equal(F.findSubmitButton(doc, fields, { checkLayout: false }), doc.querySelector('button'));
  assert.equal(F.findSubmitButton(doc, [], { checkLayout: false }), null);
});

// Mirrors the markup of a live Google Form (attributes trimmed): the heading carries the question,
// the input points at it with aria-labelledby, and "Required question" marks required items.
const gformItem = (n, question, input = '<input type="text" required>') => `
  <div role="listitem">
    <div id="h${n}" role="heading" aria-level="3"><span>${question}</span><span aria-label="Required question"> *</span></div>
    ${input.replace("<input", `<input aria-labelledby="h${n} x${n}"`).replace("<textarea", `<textarea aria-labelledby="h${n}"`)}
  </div>`;

test("Google Forms: questions come from the heading, without the required marker", () => {
  const { doc, F } = page(
    gformItem(1, "Full Name ?") +
      gformItem(2, "Contact Number ?") +
      gformItem(3, "Which cloud platform did you use?", "<textarea required></textarea>") +
      `<div role="listitem"><div role="heading"><span>Attach your updated CV.</span><span aria-label="Required question"> *</span></div>
         <div role="button">Add file</div></div>`,
    "https://docs.google.com/forms/d/e/x/viewform",
  );
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(
    plain(fields.map((f) => [f.kind, f.label, f.required])),
    [
      ["text", "Full Name ?", true],
      ["text", "Contact Number ?", true],
      ["text", "Which cloud platform did you use?", true],
      ["picker", "Attach your updated CV.", true],
    ],
  );
});

test("profile answers for the questions on a typical Indian tech-hiring form", () => {
  const { F } = page("");
  const answer = (q) => F.profileAnswer(q, PROFILE, null)?.value ?? null;
  assert.equal(answer("Full Name ?"), "Ada Lovelace King");
  assert.equal(answer("First name"), "Ada");
  assert.equal(answer("Last name"), "Lovelace King");
  assert.equal(answer("Contact Number ?"), "+44 20 7946 0000");
  assert.equal(answer("E-Mail ID?"), "ada@example.com");
  assert.equal(answer("Current Location?"), "London, UK");
  assert.equal(answer("Current company Name ?"), "Analytical Engines");
  assert.equal(answer("Total Years of full-time experience?"), "5.6 years");
  assert.equal(answer("What is your highest educational qualification?"), "M.Sc. Computing");
  assert.equal(answer("Please mention your B.Tech/B.E. college (IIT/NIT) and branch."), "Imperial College – Computing");
  assert.equal(answer("LinkedIn profile"), "https://linkedin.com/in/ada");
  // Left to the platform (preferences + answer bank), or to the user.
  assert.equal(answer("How many years of hands-on Python development experience do you have?"), null);
  assert.equal(answer("What is your official notice period?"), null);
  assert.equal(answer("Current CTC? Mention fixed and variable components separately."), null);
  assert.equal(answer("Which RAG/vector database have you used hands-on?"), null);
});

test("current company is flagged for review when no job is marked current", () => {
  const { F } = page("");
  const past = { ...PROFILE, experience: [{ ...PROFILE.experience[1], is_current: false, end_date: "2026-08" }] };
  assert.deepEqual(plain(F.profileAnswer("Current company name", past, null)), { value: "Analytical Engines", needsReview: true });
});

test("generic form: labels, selects, radios, consent checkbox and file input", () => {
  const { doc, F } = page(`
    <form>
      <label for="fn">First name *</label><input id="fn" name="first_name" required>
      <label>Email <input type="email" name="email"></label>
      <label for="country">Country</label>
      <select id="country"><option value="">Select…</option><option value="in">India</option><option value="uk">United Kingdom</option></select>
      <fieldset><legend>Will you require visa sponsorship?</legend>
        <label><input type="radio" name="visa" value="1"> Yes</label>
        <label><input type="radio" name="visa" value="0"> No</label>
      </fieldset>
      <label><input type="checkbox" required> I agree to the privacy policy</label>
      <label for="cv">Resume/CV</label><input id="cv" type="file" required>
      <input type="hidden" name="csrf" value="x">
      <input type="text" name="ghost" style="display:none">
    </form>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(
    plain(fields.map((f) => [f.kind, f.label])),
    [
      ["text", "First name"],
      ["text", "Email"],
      ["select", "Country"],
      ["radio", "Will you require visa sponsorship?"],
      ["checkbox", "I agree to the privacy policy"],
      ["file", "Resume/CV"],
    ],
  );

  const [first, email, country, visa] = fields;
  let inputs = 0;
  first.el.addEventListener("input", () => inputs++);
  assert.equal(F.apply(first, "Ada"), "Ada");
  assert.equal(first.el.value, "Ada");
  assert.equal(inputs, 1, "fires input so framework state updates");
  assert.equal(F.isEmpty(first), false);
  assert.equal(F.isEmpty(email), true);

  assert.equal(F.apply(country, "United Kingdom"), "United Kingdom");
  assert.equal(country.el.value, "uk");
  assert.equal(F.apply(visa, "No, I don't need sponsorship"), "No");
  assert.equal(doc.querySelector('input[name=visa][value="0"]').checked, true);
  assert.equal(F.isEmpty(visa), false);
});

test("Google Forms ARIA radio groups are clicked by option text", () => {
  const { doc, F } = page(`
    <div role="listitem"><div id="q" role="heading">Are you open to relocation?</div>
      <div role="radiogroup" aria-labelledby="q">
        <div role="radio" data-value="Yes" aria-checked="false"></div>
        <div role="radio" data-value="No" aria-checked="false"></div>
      </div></div>`);
  const [field] = F.collectFields(doc, { checkLayout: false });
  assert.equal(field.label, "Are you open to relocation?");
  let clicked = null;
  for (const o of field.options) o.el.addEventListener("click", () => (clicked = o.text));
  assert.equal(F.apply(field, "yes"), "Yes");
  assert.equal(clicked, "Yes");
});

test("chooseOption refuses ambiguous matches", () => {
  const { F } = page("");
  const opts = ["0-2 years", "2-5 years", "5+ years"].map((text) => ({ text }));
  assert.equal(F.chooseOption(opts, "5+ years")?.text, "5+ years");
  assert.equal(F.chooseOption(opts, "years"), null);
});

test("number inputs get just the number", () => {
  const { doc, F } = page('<label for="y">Years of experience</label><input id="y" type="number">');
  const [field] = F.collectFields(doc, { checkLayout: false });
  assert.equal(F.apply(field, "5.6 years"), "5.6");
  assert.equal(F.apply(field, "plenty"), null);
});

test("Google Forms confirmation page counts as submitted; a next section does not", () => {
  const done = page('<div>Your response has been recorded.</div><a href="#">Submit another response</a>', "https://docs.google.com/forms/d/e/x/formResponse");
  assert.equal(done.F.looksSubmitted(done.doc, "https://docs.google.com/forms/d/e/x/formResponse"), true);
  const next = page(gformItem(1, "Section 2 question"), "https://docs.google.com/forms/d/e/x/formResponse");
  assert.equal(next.F.looksSubmitted(next.doc, "https://docs.google.com/forms/d/e/x/formResponse"), false);
  const other = page("", "https://boards.greenhouse.io/x/jobs/1");
  assert.equal(other.F.looksSubmitted(other.doc, "https://boards.greenhouse.io/x/jobs/1"), false);
});

test("firstSentence trims follow-up instructions but keeps short questions whole", () => {
  const { F } = page("");
  assert.equal(F.firstSentence("Current CTC? Mention fixed and variable components separately."), "Current CTC?");
  assert.equal(
    F.firstSentence("What is your official notice period? If serving the notice, please mention your last working day ."),
    "What is your official notice period?",
  );
  assert.equal(F.firstSentence("Full Name ?"), "Full Name ?");
  assert.equal(F.firstSentence("B.Tech college"), "B.Tech college");
});

test("an unlinked label next to the field beats a sample-value placeholder", () => {
  const { doc, F } = page(`
    <div class="field"><label>First Name *</label><input type="text" placeholder="Arjun" required></div>
    <div class="field"><label>Email *</label><div class="wrap"><input type="email" placeholder="arjun@example.com"></div></div>`);
  const labels = F.collectFields(doc, { checkLayout: false }).map((f) => f.label);
  assert.deepEqual(plain(labels), ["First Name", "Email"]);
});

test("Zoho Recruit: row labels, the * marker, side controls, -None- and the CAPTCHA box", () => {
  const row = (id, label, mandatory, field) => `
    <div class="crc-form-row crc-rec-form_${id}">
      <label id="crc-label-rec-form_${id}" class="crm-from-label"><span class="crc-label-text"><span>${label}</span>${mandatory ? '<span class="crc-form-mandatory">*</span>' : ""}</span></label>
      <div class="crc-form-field">${field}</div>
    </div>`;
  const text = (id) => `<crux-text-component id="rec-form_${id}"><div class="cxElementValue"><lyte-input id="rec-form_${id}_input"><div><input type="text" name="rec-form_${id}"></div></lyte-input></div></crux-text-component>`;
  const pick = (id, controls) => `<crux-picklist-component id="rec-form_${id}"><div class="cxElementValue"><lyte-dropdown><div class="lyteDummyEventContainer" role="combobox" aria-haspopup="listbox" aria-controls="${controls}"><lyte-drop-button><span>-None-</span></lyte-drop-button></div></lyte-dropdown></div></crux-picklist-component>`;
  const { doc, F } = page(`<div class="wbf-doublewrapper">
    ${row("1", "First Name", true, pick("9", "Salutation") + text("1"))}
    ${row("2", "Mobile", true, `<crux-phone-component id="rec-form_2"><div><lyte-dropdown><div role="combobox" aria-haspopup="listbox" aria-controls="Lyte_Drop_Body_0"><lyte-drop-button>(+91)</lyte-drop-button></div></lyte-dropdown><lyte-input id="rec-form_2_input"><div><input type="text" name="rec-form_2"></div></lyte-input></div></crux-phone-component>`)}
    ${row("3", "Gender", true, pick("3", "Gender1"))}
    ${row("4", "Notice Period ( in days )", true, text("4"))}
    ${row("5", "Alternate Number", false, text("5"))}
    <div class="crc-form-row"><label class="crm-from-label">CAPTCHA <span class="crc-form-mandatory">*</span></label><div><input type="text" placeholder="Type below image text"><img alt="CAPTCHA"></div></div>
  </div>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(plain(fields.map((f) => [f.label, f.required])), [
    ["First Name (salutation)", false],
    ["First Name", true],
    ["Mobile (country code)", false],
    ["Mobile", true],
    ["Gender", true],
    ["Notice Period ( in days )", true],
    ["Alternate Number", false],
  ]);
  assert.equal(F.isEmpty(fields.find((f) => f.label === "Gender")), true);
});

test("Zoho Recruit tabular sections: entry, column and From/To month/year parts in the label", () => {
  const dropdown = (id) => `<rec-dropdown id="${id}"><lyte-dropdown id="cxd-${id}"><div role="combobox" aria-haspopup="listbox" aria-controls="cxdby-${id}"><span>-None-</span></div></lyte-dropdown></rec-dropdown>`;
  const { doc, F } = page(`
    <div class="crc-form-row Experience_Details"><h2>Experience Details</h2>
      <div role="region" aria-label="Experience Details : Entry 1 of 10">
        <div class="crc-form-tabularrow"><label id="crc-form-tabular-label-7">Company</label>
          <crux-text-component id="7_1"><div><input type="text" name="7_1"></div></crux-text-component></div>
        <div class="crc-form-tabularrow"><label id="crc-form-tabular-label-8">Work Duration</label>
          <rec-month-range-component id="8_1"><div class="crc-form-durationfield"><label class="cxLabel">Month</label>${dropdown("8_1_from_month")}<label class="cxLabel">Year</label>${dropdown("8_1_from_year")}</div>
          <div class="crc-form-durationfield"><label class="cxLabel">Month</label>${dropdown("8_1_to_month")}</div></rec-month-range-component></div>
        <div class="crc-form-tabularrow"><label>I currently work here</label><input type="checkbox" name="9_1" aria-labelledby="lyte-checkbox-label-0"><label id="lyte-checkbox-label-0"></label></div>
      </div>
    </div>`);
  assert.deepEqual(plain(F.collectFields(doc, { checkLayout: false }).map((f) => f.label)), [
    "Experience Details 1: Company",
    "Experience Details 1: Work Duration from (month)",
    "Experience Details 1: Work Duration from (year)",
    "Experience Details 1: Work Duration to (month)",
    "Experience Details 1: I currently work here",
  ]);
});

test("isPlaceholderOption: -None- and Select… are not answers; None alone is", () => {
  const { doc, F } = page(`<select><option value="-None-">-None-</option><option>Mr.</option></select>`);
  assert.equal(F.isPlaceholderOption("-None-"), true);
  assert.equal(F.isPlaceholderOption("--Select--"), true);
  assert.equal(F.isPlaceholderOption("None"), false);
  assert.equal(F.isEmpty(F.collectFields(doc, { checkLayout: false })[0]), true);
});

test("findSubmitButton: the one submit button of the form being filled", () => {
  const { doc, F } = page(`
    <button type="button">Apply with LinkedIn</button>
    <form id="app">
      <input id="name" type="text">
      <button type="button">Upload resume</button>
      <button type="button">Back</button>
      <button type="submit">Submit application</button>
    </form>
    <form><input type="text"><button>Apply</button></form>`);
  const fields = F.collectFields(doc, { checkLayout: false }).filter((f) => f.el.closest("#app"));
  assert.equal(F.findSubmitButton(doc, fields, { checkLayout: false })?.textContent, "Submit application");
});

test("findSubmitButton: Google Forms' role=button Submit; ambiguous or missing gives null", () => {
  const gform = page(
    gformItem(1, "Full Name ?") + `<div role="button"><span>Submit</span></div><div role="button">Clear form</div>`,
    "https://docs.google.com/forms/d/e/x/viewform",
  );
  const gfields = gform.F.collectFields(gform.doc, { checkLayout: false });
  assert.equal(gform.F.findSubmitButton(gform.doc, gfields, { checkLayout: false })?.textContent, "Submit");

  const two = page(`<input type="text"><button>Submit</button><button>Apply now</button>`);
  assert.equal(two.F.findSubmitButton(two.doc, two.F.collectFields(two.doc, { checkLayout: false }), { checkLayout: false }), null);

  const next = page(`<form><input type="text"><button type="submit">Next</button><button disabled>Submit</button></form>`);
  assert.equal(next.F.findSubmitButton(next.doc, next.F.collectFields(next.doc, { checkLayout: false }), { checkLayout: false }), null);
});

// A Material-style dropdown: a combobox host whose options only exist, in an overlay, while open.
const MATERIAL = `
  <label id="gl">Gender*</label>
  <mat-select id="gender" role="combobox" aria-required="true" aria-labelledby="gl"><span class="mat-mdc-select-placeholder">Gender*</span></mat-select>
  <input id="auto" role="combobox" type="text">`;

function openOnClick(win, select, names) {
  select.addEventListener("click", () => {
    const panel = win.document.createElement("div");
    panel.setAttribute("role", "listbox");
    for (const name of names) {
      const option = win.document.createElement("mat-option");
      option.setAttribute("role", "option");
      option.textContent = name;
      option.addEventListener("click", () => {
        select.textContent = name;
        panel.remove();
      });
      panel.append(option);
    }
    win.document.body.append(panel);
  });
}

test("custom dropdowns are found with their question and empty until an option is chosen", async () => {
  const { doc, F, win } = page(MATERIAL);
  openOnClick(win, doc.querySelector("#gender"), ["Male", "Female", "Prefer not to say"]);
  const fields = F.collectFields(doc, { checkLayout: false });
  const dropdown = fields.find((f) => f.kind === "dropdown");
  assert.deepEqual(plain({ label: dropdown.label, required: dropdown.required, custom: dropdown.custom }), { label: "Gender", required: true, custom: true });
  // A text input with role=combobox stays a plain text field.
  assert.equal(fields.filter((f) => f.kind === "dropdown").length, 1);
  assert.equal(fields.find((f) => f.el.id === "auto").kind, "text");
  assert.equal(F.isEmpty(dropdown), true);

  assert.equal(await F.pickDropdown(dropdown, "female", { pollMs: 1 }), "Female");
  assert.equal(F.isEmpty(dropdown), false);
  assert.equal(F.dropdownValue(dropdown), "Female");
  assert.equal(doc.querySelector('[role="listbox"]'), null);
});

test("pickDropdown leaves the dropdown alone when no option matches", async () => {
  const { doc, F, win } = page(MATERIAL);
  openOnClick(win, doc.querySelector("#gender"), ["Male", "Female"]);
  const dropdown = F.collectFields(doc, { checkLayout: false }).find((f) => f.kind === "dropdown");
  assert.equal(await F.pickDropdown(dropdown, "30 days", { pollMs: 1 }), null);
  assert.equal(F.isEmpty(dropdown), true);
});

test("isInvalid reads what the page itself rejects; an empty field is only unanswered", () => {
  const { doc, F } = page(`<input id="a" aria-invalid="true" value="INR 1,900,000"><input id="b" value="5"><input id="c" aria-invalid="true">
    <input id="d" type="number" value="1" max="0"><div class="err">Enter numbers only</div>`);
  const [a, b, , d] = F.collectFields(doc, { checkLayout: false });
  assert.equal(F.isInvalid(a), true);
  assert.equal(F.isInvalid(b), false);
  assert.equal(F.isInvalid(d), true); // native validation
});

test("invalidReason returns the site's own message", () => {
  const { doc, F } = page(`<div class="form-field"><input id="a" aria-invalid="true" aria-describedby="m" value="x"><span id="m">Please enter a valid Current CTC.</span></div>`);
  assert.equal(F.invalidReason(F.collectFields(doc, { checkLayout: false })[0]), "Please enter a valid Current CTC.");
});

test("numericVariants spells a rejected value as just the number", () => {
  const { F } = page("");
  assert.deepEqual(plain(F.numericVariants("5.6 years")), ["5.6"]);
  assert.deepEqual(plain(F.numericVariants("INR 1,900,000")), ["1,900,000", "1900000"]);
  assert.deepEqual(plain(F.numericVariants("London")), []);
  assert.deepEqual(plain(F.numericVariants("1900000")), []);
});

test("findSubmitButton can report a Submit button that is still disabled", () => {
  const { doc, F } = page(`<form><input type="text"><button type="submit" disabled>Submit</button></form>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.equal(F.findSubmitButton(doc, fields, { checkLayout: false }), null);
  assert.equal(F.findSubmitButton(doc, fields, { checkLayout: false, includeDisabled: true })?.textContent, "Submit");
});

// Like openOnClick, but the overlay closes on Escape the way Material and most libraries do.
function openOnClickCloseOnEscape(win, select, names) {
  openOnClick(win, select, names);
  win.document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") win.document.querySelectorAll('[role="listbox"]').forEach((p) => p.remove());
  });
}

test("readDropdownOptions reads a closed custom dropdown's options without choosing one", async () => {
  const { doc, F, win } = page(MATERIAL);
  const select = doc.querySelector("#gender");
  openOnClickCloseOnEscape(win, select, ["Select", "Male", "Female", "Female", "Prefer not to say"]);
  const dropdown = F.collectFields(doc, { checkLayout: false }).find((f) => f.kind === "dropdown");
  assert.equal(doc.querySelector('[role="option"]'), null, "options only exist while open");

  const options = await F.readDropdownOptions(dropdown, { pollMs: 1 });
  assert.deepEqual(plain(options), [{ text: "Male" }, { text: "Female" }, { text: "Prefer not to say" }]);
  assert.equal(doc.querySelector('[role="listbox"]'), null, "left closed");
  assert.equal(F.isEmpty(dropdown), true, "nothing selected");
  assert.equal(F.dropdownValue(dropdown), "");
});

test("readDropdownOptions opens on mousedown too, and returns [] when no options appear", async () => {
  const { doc, F, win } = page(MATERIAL);
  const select = doc.querySelector("#gender");
  // An async-search dropdown: opening it shows nothing until the user types.
  let opened = 0;
  select.addEventListener("click", () => opened++);
  select.addEventListener("mousedown", () => opened++);
  const dropdown = F.collectFields(doc, { checkLayout: false }).find((f) => f.kind === "dropdown");
  assert.deepEqual(plain(await F.readDropdownOptions(dropdown, { polls: 2, pollMs: 1 })), []);
  assert.equal(opened, 2, "tried click, then mousedown");
  assert.equal(F.isEmpty(dropdown), true);

  const other = page(MATERIAL);
  const host = other.doc.querySelector("#gender");
  host.addEventListener("mousedown", () => {
    const panel = other.doc.createElement("div");
    panel.setAttribute("role", "listbox");
    panel.innerHTML = '<div role="option">Yes</div><div role="option">No</div>';
    other.doc.body.append(panel);
    other.win.document.addEventListener("keydown", () => panel.remove(), { once: true });
  });
  const field = other.F.collectFields(other.doc, { checkLayout: false }).find((f) => f.kind === "dropdown");
  assert.deepEqual(plain(await other.F.readDropdownOptions(field, { polls: 2, pollMs: 1 })), [{ text: "Yes" }, { text: "No" }]);
  assert.equal(other.doc.querySelector('[role="listbox"]'), null);
});

// A searchable "Select" box whose list is plain <li>s with no ARIA roles. Escape doesn't close it;
// a click elsewhere does.
const ROLELESS = `
  <h2>Contact Information</h2>
  <label for="sal">Salutation *</label>
  <input id="sal" role="combobox" placeholder="Select" required>
  <ul class="menu" hidden><li>Miss</li><li>Mr.</li><li>Mrs.</li><li>Ms.</li><li>Mx.</li></ul>
  <label for="em">Email *</label><input id="em" type="email">`;

function roleless() {
  const p = page(ROLELESS);
  const input = p.doc.querySelector("#sal");
  const menu = p.doc.querySelector(".menu");
  input.addEventListener("click", () => { menu.hidden = false; });
  p.doc.addEventListener("mousedown", (e) => { if (e.target !== input && !menu.contains(e.target)) menu.hidden = true; });
  for (const li of menu.children) li.addEventListener("click", () => { input.value = li.textContent; menu.hidden = true; });
  return { ...p, input, menu };
}

test("a dropdown whose options have no ARIA roles still offers them, and is closed again", async () => {
  const { doc, F, menu } = roleless();
  const field = F.collectFields(doc, { checkLayout: false }).find((f) => f.label.startsWith("Salutation"));
  assert.equal(field.kind, "dropdown");
  const options = await F.readDropdownOptions(field, { pollMs: 1 });
  assert.deepEqual(plain(options).map((o) => o.text), ["Miss", "Mr.", "Mrs.", "Ms.", "Mx."]);
  assert.equal(menu.hidden, true, "closed by a click elsewhere when Escape didn't");
  assert.equal(F.isEmpty(field), true, "nothing chosen");
});

test("a role-less dropdown option is picked by clicking it", async () => {
  const { doc, F, input, menu } = roleless();
  const field = F.collectFields(doc, { checkLayout: false }).find((f) => f.label.startsWith("Salutation"));
  assert.equal(await F.pickDropdown(field, "Mr", { pollMs: 1 }), "Mr.");
  assert.equal(input.value, "Mr.");
  assert.equal(menu.hidden, true);
  assert.equal(F.dropdownValue(field), "Mr.");
  assert.equal(F.isEmpty(field), false);
});

test("a combobox input is a dropdown only when it says Select or can't be typed in; typeaheads stay text", () => {
  const { doc, F } = page(`
    <label for="a">City</label><input id="a" role="combobox" placeholder="Start typing">
    <label for="b">Country</label><input id="b" role="combobox" readonly>
    <label for="c">Notice period</label><input id="c" role="combobox" placeholder="-- Select --">`);
  const kinds = F.collectFields(doc, { checkLayout: false }).map((f) => [f.label, f.kind]);
  assert.deepEqual(plain(kinds), [["City", "text"], ["Country", "dropdown"], ["Notice period", "dropdown"]]);
});

test("react-select style: the input stays empty and the choice shows beside it", () => {
  const { doc, F } = page(`
    <label for="s">Salutation</label>
    <div class="control"><div class="value"><div class="single">Ms.</div><div><input id="s" role="combobox" aria-haspopup="listbox" placeholder="Select"></div></div></div>
    <label for="t">Title</label>
    <div class="control"><div class="value"><div class="placeholder">Select...</div><div><input id="t" role="combobox" aria-haspopup="listbox"></div></div></div>`);
  const [sal] = F.collectFields(doc, { checkLayout: false });
  assert.equal(sal.kind, "dropdown");
  assert.equal(F.dropdownValue(sal), "Ms.");
  const title = { kind: "dropdown", custom: true, el: doc.querySelector("#t") };
  assert.equal(F.dropdownValue(title), "", "a placeholder is not a value");
});

test("strict chooseOption (AI drafts) never ticks an option a sentence merely contains", () => {
  const { F } = page("");
  const auth = ["I am legally authorized", "I am not legally authorized"].map((text) => ({ text }));
  const drafted = "I am not sure if I am legally authorized";
  assert.equal(F.chooseOption(auth, drafted, { strict: true }), null);
  // Non-strict (profile / answer bank) keeps the containment match.
  assert.equal(F.chooseOption(auth, drafted)?.text, "I am legally authorized");
  assert.equal(F.chooseOption(auth, drafted, { strict: false })?.text, "I am legally authorized");
  // Exact and leading yes/no still count when strict.
  assert.equal(F.chooseOption(auth, "i am NOT legally authorized.", { strict: true })?.text, "I am not legally authorized");
  const yesNo = ["Yes", "No"].map((text) => ({ text }));
  assert.equal(F.chooseOption(yesNo, "Yes, I can relocate within a month.", { strict: true })?.text, "Yes");
  assert.equal(F.chooseOption(yesNo, "No - I would not need sponsorship", { strict: true })?.text, "No");
  const degrees = ["Bachelor's degree", "Master's degree"].map((text) => ({ text }));
  assert.equal(F.chooseOption(degrees, "Master's degree in Computing", { strict: true }), null);
  assert.equal(F.chooseOption(degrees, "Master's degree in Computing")?.text, "Master's degree");
});

test("strict apply leaves selects and radios empty for a drafted sentence", () => {
  const { doc, F } = page(`
    <label for="auth">Work authorization</label>
    <select id="auth"><option value="">Choose</option><option value="y">I am legally authorized</option><option value="n">I am not legally authorized</option></select>
    <fieldset><legend>Highest degree</legend>
      <label><input type="radio" name="deg" value="b"> Bachelor's degree</label>
      <label><input type="radio" name="deg" value="m"> Master's degree</label>
    </fieldset>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  const select = fields.find((f) => f.kind === "select");
  const radio = fields.find((f) => f.kind === "radio");
  assert.equal(F.apply(select, "I am not sure if I am legally authorized", { strict: true }), null);
  assert.equal(F.isEmpty(select), true);
  assert.equal(F.apply(radio, "Master's degree in Computing", { strict: true }), null);
  assert.equal(F.isEmpty(radio), true);
  assert.equal(F.apply(radio, "Master's degree in Computing"), "Master's degree");
  assert.equal(doc.querySelector('input[value="m"]').checked, true);
});

test("strict pickDropdown leaves a custom dropdown alone on a contained match", async () => {
  const { doc, F, win } = page(MATERIAL);
  openOnClick(win, doc.querySelector("#gender"), ["Engineering", "Design"]);
  const dropdown = F.collectFields(doc, { checkLayout: false }).find((f) => f.kind === "dropdown");
  assert.equal(await F.pickDropdown(dropdown, "Software engineering", { pollMs: 1, strict: true }), null);
  assert.equal(F.isEmpty(dropdown), true);

  const loose = page(MATERIAL);
  openOnClick(loose.win, loose.doc.querySelector("#gender"), ["Engineering", "Design"]);
  const other = loose.F.collectFields(loose.doc, { checkLayout: false }).find((f) => f.kind === "dropdown");
  assert.equal(await loose.F.pickDropdown(other, "Software engineering", { pollMs: 1 }), "Engineering");
});

test("field names read as words, and a country-code question gets the profile phone's code", () => {
  const { doc, F } = page(`<select name="mobilePhone.countryCode"><option>+93</option><option>+91</option></select>
    <input name="first_name"><input name="email"><input placeholder="e.g. 5 years">`);
  assert.deepEqual([...F.collectFields(doc, { checkLayout: false }).map((f) => f.label)], ["Mobile phone country code", "First name", "email", "e.g. 5 years"]);
  const code = (phone) => F.profileAnswer("Mobile phone country code", { phone }, null)?.value ?? null;
  assert.equal(code("+91 98765 43210"), "+91");
  assert.equal(code("+919876543210"), "+91");
  assert.equal(code("+1 (415) 555-0100"), "+1");
  assert.equal(code("9876543210"), null);
  assert.equal(F.profileAnswer("Mobile phone number", { phone: "+91 98765 43210" }, null).value, "+91 98765 43210");
});

test("custom dropdown whose caption is a plain <div> above it: the question, not the 'Select' prompt", () => {
  const { doc, F } = page(`<form>
    <div class="q"><div class="caption">Availability <span>*</span></div>
      <div class="control"><div role="combobox" aria-haspopup="listbox" aria-required="true"><span>Select</span></div></div></div>
    <div class="q"><div class="control"><div role="combobox" aria-haspopup="listbox"><span>Select</span></div></div></div>
  </form>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.equal(fields[0].label, "Availability");
  assert.equal(fields[0].required, true);
  // Nothing above it to read: the second control must not borrow the first one's caption.
  assert.equal(fields[1].label, "Select");
});

test("Rippling custom question: aria-label 'Select' is a prompt, the caption sits beside the field wrapper", () => {
  const { doc, F } = page(`<form><div>
    <div><div><p>Availability<div></div></p></div>
      <div data-testid="field"><div><div data-testid="customQuestions.6aa"><div><div data-testid="select-controller"><div><div role="combobox" aria-haspopup="listbox" aria-required="true" aria-label="Select" aria-expanded="false" id="field-55" tabindex="0"><p>Select</p></div></div></div></div></div></div></div></div>
    <div><div><p>Notice period</p></div>
      <div data-testid="field"><div><div><div data-testid="select-controller"><div><div role="combobox" aria-haspopup="listbox" aria-label="Select" id="field-60"><p>Select</p></div></div></div></div></div></div></div>
  </div></form>`);
  const fields = F.collectFields(doc, { checkLayout: false });
  assert.deepEqual(plain(fields.map((f) => f.label)), ["Availability", "Notice period"]);
  assert.equal(fields[0].required, true);
});

test("Rippling dropdowns: each list is found by '<id>-list', and an Escape-proof list closes before the next is read", async () => {
  const { doc, F, win } = page(`<form>
    <div><p>Availability</p><div role="combobox" aria-haspopup="listbox" aria-label="Select" id="field-55"><p>Select</p></div></div>
    <div><p>Years of work experience</p><div role="combobox" aria-haspopup="listbox" aria-label="Select" id="field-61"><p>Select</p></div></div>
  </form>`);
  const choices = { "field-55": ["Immediate", "30 days"], "field-61": ["0-1", "1-3", "3-7", "7+"] };
  // Opens on click, ignores Escape, closes (a tick late, like React) on a click elsewhere; no aria-controls.
  for (const id of Object.keys(choices)) {
    doc.getElementById(id).addEventListener("click", () => {
      const ul = doc.createElement("ul");
      ul.id = `${id}-list`;
      ul.setAttribute("role", "listbox");
      ul.innerHTML = choices[id].map((t) => `<li role="option">${t}</li>`).join("");
      doc.body.append(ul);
    });
  }
  doc.body.addEventListener("click", (e) => {
    if (e.target.closest('[role="combobox"]')) return;
    setTimeout(() => doc.querySelectorAll('[role="listbox"]').forEach((p) => p.remove()), 5);
  });
  const [first, second] = F.collectFields(doc, { checkLayout: false }).filter((f) => f.kind === "dropdown");
  assert.deepEqual(plain(await F.readDropdownOptions(first, { pollMs: 10 })), [{ text: "Immediate" }, { text: "30 days" }]);
  assert.deepEqual(plain(await F.readDropdownOptions(second, { pollMs: 10 })), [{ text: "0-1" }, { text: "1-3" }, { text: "3-7" }, { text: "7+" }]);
});
