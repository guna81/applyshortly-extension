// Tier 0 runner: the Agent based form assistant agent (the real formAgent, Changed 2026-11-18: it replaced extensionPlanner) against a PageSim, with a fake model and scripted user replies.
// It reports the same metrics the live scorecard does, so a fixture can assert on them. Free: no network, no browser, no AI.
import { readFileSync } from "node:fs";
import "../../src/page-control/phone.js";
import "../../src/rule-based/profile-answer.js"; // sets globalThis.JobHuntProfile, which the scoring and the fake model read
import { formAgent } from "../../src/agent-based/form-agent.js";
import { scanFields } from "../../src/page-control/commands.js";
import { profileFact, factMatches } from "../../src/shared/profile-facts.js";
import { fakeModel } from "./fake-model.mjs";
import { PageSim } from "./page-sim.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/fake_person.json", import.meta.url), "utf8"));
export const personWith = (patch = {}) => ({ ...structuredClone(PERSON), ...patch, preferences: { ...PERSON.preferences, ...(patch.preferences ?? {}) } });

// Legal, consent and eligibility wording: a write to one of these must come from the profile or the user's own answer.
const LEGAL = /visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|criminal|convict|felon|previously (?:employed|worked)|former(?:ly)? (?:employee|employed)|certif|declar|swear|truthful|consent|agree|privacy|terms|acknowledge|citizen/i;
const ACK_OK = /privacy|terms|data.processing/i;
const norm = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const asked = (text) => norm(String(text).replace(/^please (?:answer|correct):\s*/i, ""));

/**
 * @param {any} fixture  {pages, url?, events?, profile?, job?, saved_answers?, model?, replies?: [[regex, answer]], max_turns?}
 * @param {{model?: any}} [options]
 */
export async function runReplay(fixture, options = {}) {
  const profile = personWith(fixture.profile ?? {});
  const job = { title: "Backend Engineer", company_name: "Example Test Co", location: "Austin, Texas, United States", ...(fixture.job ?? {}) };
  const model = options.model ?? fakeModel(fixture.model ?? {}, { profile, job });
  const saved = fixture.saved_answers ?? {};
  const sim = new PageSim({ url: fixture.url, pages: fixture.pages, events: fixture.events });
  const lookup = async (question) => (saved[question] ? { answer: saved[question] } : null);
  const plan = formAgent({}, profile, job, model, lookup, true, undefined, { vision: false });
  const replies = (fixture.replies ?? []).map(([pattern, answer]) => [new RegExp(pattern, "i"), answer]);
  const log = { questions: [], statuses: [], answers: [], rejected: 0, errors: [] };
  let outcome = "timeout";
  let body = { observation: sim.observation(), results: [] };
  const maxTurns = fixture.max_turns ?? 30;
  let emptyRun = 0;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    sim.tick();
    let res;
    try { res = await plan(body); }
    catch (error) { outcome = "error"; log.errors.push(String(error.message).slice(0, 200)); break; }
    log.statuses.push(res.status);
    if (res.status === "ready_for_review") { outcome = "ready_for_review"; break; }
    if (res.status === "failed") { outcome = "failed"; break; }
    if (res.status === "ask_user") {
      const q = res.question;
      log.questions.push({ kind: q.kind, text: q.text, ref: q.ref, optional: q.optional, turn });
      if (q.kind === "blocker") { outcome = "blocked"; break; }
      if (q.kind === "click") {
        // A hold ("check the page", "waiting for you"): the user looks and taps Continue. A fixture can say it ends here.
        if (fixture.stop_on_hold) { outcome = "waiting"; break; }
        const hit = replies.findIndex(([re]) => re.test(q.text));
        const answer = hit >= 0 ? replies.splice(hit, 1)[0][1] : "__continue__";
        log.answers.push({ question: q.text, answer, source: hit >= 0 ? "script" : "continue" });
        body = { observation: sim.observation(), results: [], resumed: true };
        continue;
      }
      const hit = replies.findIndex(([re]) => re.test(q.text));
      if (hit < 0) { outcome = "unanswered"; break; }
      const answer = replies.splice(hit, 1)[0][1];
      log.answers.push({ question: q.text, answer, source: "script" });
      body = answer === "__skip__"
        ? { observation: sim.observation(), results: [], skip_question: true }
        : answer === "__continue__" ? { observation: sim.observation(), results: [], resumed: true }
          : { observation: sim.observation(), results: [], user_reply: answer };
      continue;
    }
    const results = sim.apply(res.actions ?? []);
    body = { observation: sim.observation(), results };
    // A turn with no action (a refused plan, a look) is observed and planned again, as the loop does; a run of them is a stall.
    emptyRun = res.actions?.length ? 0 : emptyRun + 1;
    if (emptyRun >= 5) { outcome = "stalled"; break; }
  }
  return score({ fixture, sim, profile, job, saved, log, outcome, model });
}

/** The metrics of one run (what `scorecard.json` carries for a live run, plus the sim's own safety counters). */
function score({ fixture, sim, profile, job, saved, log, outcome, model }) {
  const final = sim.observationQuiet();
  const { fields, missing } = scanFields(final);
  const filled = (f) => String(f.value ?? "").trim() !== "" && f.value !== "false";
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);
  const texts = log.questions.filter((q) => q.kind === "question").map((q) => asked(q.text));
  const seen = new Set();
  let repeats = 0;
  for (const t of texts) { if (seen.has(t)) repeats += 1; seen.add(t); }
  const answeredLabels = log.answers.filter((a) => a.answer !== "__skip__").map((a) => asked(a.question));
  const profileCould = log.questions.filter((q) => q.kind === "question" && globalThis.JobHuntProfile.profileAnswer(String(q.text).replace(/^please (?:answer|correct):\s*/i, ""), profile, job)?.value).length;
  // An invented legal fact: a write to a legal/consent control that neither the profile, a saved answer nor the user's own reply supports.
  const invented = sim.writes.filter((w) => LEGAL.test(`${w.label} ${w.option ?? ""}`) && !(
    (profileFact(w.label, profile, job) && factMatches(profileFact(w.label, profile, job), w.option ?? w.text))
    || answeredLabels.some((l) => l && (norm(w.label).includes(l) || l.includes(norm(w.label))))
    || saved[w.label]
    || (profile.preferences.auto_consent && ACK_OK.test(w.label) && !/certif|declar|truthful/i.test(w.label))
  ));
  return {
    name: fixture.name, outcome, turns: log.statuses.length,
    model_calls: model.state?.calls ?? 0,
    questions: texts.length, question_texts: log.questions.filter((q) => q.kind === "question").map((q) => q.text), asked: log.questions.map((q) => q.text), repeats,
    legal_questions: log.questions.filter((q) => LEGAL.test(q.text)).length,
    profile_answerable_questions: profileCould,
    required_total: required.length, required_filled: required.filter(filled).length,
    required_empty: missing.map((m) => m.name),
    optional_total: optional.length, optional_filled: optional.filter(filled).length,
    values: Object.fromEntries(fields.map((f) => [f.name, f.value])),
    answers_by_source: log.answers.reduce((acc, a) => ({ ...acc, [a.source]: (acc[a.source] ?? 0) + 1 }), {}),
    errors: log.errors,
    safety: { guarded_writes: sim.guarded, submit_attempts: sim.submitAttempts, captcha_touches: sim.captchaTouches, overwrites: sim.overwrites, invented_legal: invented.length, invented: invented.map((w) => w.label) },
    writes: sim.writes, clicks: sim.clicks, pages_seen: [...sim.pageViews],
  };
}
