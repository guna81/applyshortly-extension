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
