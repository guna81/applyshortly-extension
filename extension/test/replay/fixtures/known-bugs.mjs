// Bugs seen live (scorecard on applications 205-207). Each fixture states the WANTED behavior and carries `todo`
// until the fix lands (Phase C): it runs and reports, but does not fail `npm test`. Remove `todo` with the fix.
import { area, box, button, contact, pills, radios, text } from "../builders.mjs";

const ESSAY = "Why do you want to work at this company?";

export default [
  {
    name: "[207] a required essay is drafted from the profile instead of leaving the form half-empty",
    pages: [{ elements: [text("fn", "Full name"), area("es", ESSAY)] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "why do you want", value: "I build reliable Python APIs and would like to bring six years of backend experience to your team." }] },
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 0 },
  },
  {
    name: "[1053] an answer that names none of a choice question's options is left for review, not asked again",
    // Live: the person said "Online search", the options were News / LinkedIn Jobs / Credo AI Website; the agent asked the same question 7 times and spent half the budget.
    pages: [{ elements: [text("fn", "Full name"), ...pills("h", "How did you hear about this opportunity? (select all that apply)", ["News", "LinkedIn Jobs", "Credo AI Website"], { required: false })] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }] },
    replies: [["how did you hear", "Online search"]],
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 1, repeats: 0 },
  },
  {
    name: "[207] a required essay the profile cannot support is asked exactly once",
    pages: [{ elements: [text("fn", "Full name"), area("es", ESSAY)] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }] },
    replies: [["why do you want", "Because the product is interesting and I like the mission. (test answer)"]],
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 1, repeats: 0 },
  },
  {
    name: "[207] two required radio groups left empty are asked, answered and filled",
    pages: [{ elements: [text("fn", "Full name"), ...radios("a", "Do you have the right to work in your country of residence?", ["Yes", "No"]), ...radios("b", "Are you comfortable working remotely?", ["Yes", "No"])] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }] },
    replies: [["right to work", "Yes"], ["remotely", "Yes"]],
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 2, repeats: 0 },
  },
  {
    name: "[207] the truthfulness declaration is not asked again after the user taps Continue",
    // Not reproduced at planner level (passes): the live repeat came from the loop layer or the harness's reply list. Kept as a guard.
    pages: [{ elements: [text("fn", "Full name"), box("tr", "I confirm that everything in this application is true and my own work")] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "confirm that everything", checked: true, rogue: true }] },
    replies: [["confirm that everything", "__continue__"]],
    expect: { outcome: "waiting_or_ready", repeats: 0, asked_once: ["confirm that everything"] },
  },
  {
    name: "a model that keeps proposing a refused action hands the question to the user instead of ending the run",
    pages: [{ elements: [text("fn", "Full name"), box("cert", "I certify that everything in this application is true and accurate")] }],
    model: { stubborn: true, knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "certify", checked: true, rogue: true }] },
    replies: [["certify", "__skip__"]],
    stop_on_hold: true,
    expect: { outcome: "waiting_or_ready", invented_legal: 0, writes_exclude: ["certify"] },
  },
];

export { contact, pills };

// Generic widget bugs found by the synthetic pages (Tier 1).
export const widgetBugs = [
  // Changed 2026-11-18: the agent no longer extracts the number itself (no form-fixing rules). The page's read-back reports the dropped
  // text as not verified; the model sees that and asks (or retries with a plain number), and the field is filled only when it sticks.
  {
    name: "a number box that drops the model's text is reported as not verified, and the user's number then sticks",
    pages: [{ elements: [text("fn", "Full name"), text("sl", "Expected salary (USD)", { input_type: "number" })] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "expected salary", value: "$90,000 per year" }] },
    replies: [["expected salary", "90000"]],
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 1, repeats: 0, values: { "Expected salary (USD)": "90000" } },
  },
  {
    name: "a number box whose answer holds no single number is asked after the write does not stick",
    pages: [{ elements: [text("fn", "Full name"), text("dr", "Number of direct reports managed", { input_type: "number" })] }],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "direct reports", value: "between two and three" }] },
    replies: [["direct reports", "3"]],
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 1, repeats: 0, values: { "Number of direct reports managed": "3" } },
  },
  {
    name: "two fields labelled Name under different headings are told apart by the heading, never both given the person's own name",
    pages: [{ elements: [text("fn", "Full name"), text("cn", "Name", { section: "Current employer" }), text("sn", "Name", { section: "Most recent school" })] }],
    model: { knowledge: [{ match: "^full name", value: "Alex Testperson" }] },
    replies: [["most recent school", "State University (test answer)"]],
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 1, repeats: 0, asked_includes: ["Most recent school"], no_write_text: ["Alex Testperson@Name"] },
  },
  {
    name: "an I'm-not-a-robot checkbox is the user's to tick: never asked about, never ticked, and the form is still handed over",
    pages: [{ elements: [text("fn", "Full name"), box("rb", "I'm not a robot")] }],
    model: { knowledge: [{ match: "^full name", value: "Alex Testperson" }, { match: "not a robot", checked: true, rogue: true }] },
    expect: { outcome: "waiting_or_ready", questions_max: 0, writes_exclude: ["robot"], required_empty: ["I'm not a robot"] },
  },
  {
    name: "a four-step wizard with two fields per step is walked to the end: its Next buttons are form steps, not job-page links",
    pages: [
      { elements: [text("fn", "Full name"), text("em", "Email"), button("n0", "Next", { goto: 1 })] },
      { elements: [text("c1", "Preferred pronouns"), text("c2", "Favourite colour"), button("n1", "Next", { goto: 2 })] },
      { elements: [text("c3", "Favourite animal"), text("c4", "Favourite food"), button("n2", "Next", { goto: 3 })] },
      { elements: [text("c5", "Favourite city"), text("c6", "Favourite book")] },
    ],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "email", value: "alex.testperson@example.test" }, { match: "pronouns", value: "they/them" }, { match: "colour", value: "green" }, { match: "animal", value: "otter" }, { match: "food", value: "soup" }, { match: "city", value: "Lisbon" }, { match: "book", value: "Dune" }] },
    expect: { outcome: "ready_for_review", required_empty: [], questions_max: 0, pages_seen: [0, 1, 2, 3] },
  },
  {
    name: "a Next button on the last step of a Step N of N form is the final submit: never clicked, the form is handed over",
    pages: [
      { text: "Step 1 of 2: About you", elements: [text("fn", "Full name"), text("em", "Email"), button("n0", "Next", { goto: 1 })] },
      { text: "Step 2 of 2: Review your answers", elements: [text("c1", "Favourite colour"), text("c2", "Favourite animal"), button("n1", "Next", { submit: true })] },
    ],
    model: { knowledge: [{ match: "full name", value: "Alex Testperson" }, { match: "email", value: "alex.testperson@example.test" }, { match: "colour", value: "green" }, { match: "animal", value: "otter" }] },
    stop_on_hold: true,
    expect: { outcome: "waiting_or_ready", submit_attempts: 0, required_empty: [], pages_seen: [0, 1] },
  },
];
