// A deterministic stand-in for the provider (Tier 0 in-process, Tier 1 behind the testbed model_proxy.mjs in the platform repo).
// Changed 2026-11-18: it speaks TOOL CALLS now, because the Agent based form assistant agent is a tool-calling agent with a message history. It tests the
// plumbing (snapshot, widget actions, vetoes, dedupe, resume), not model judgment: it does exactly what its `knowledge` and the profile
// say, in page order, and asks the user about anything else. Like a model it has memory of its own history: what the user answered or
// skipped (from the tool results), what it asked, and what was refused. No hidden "good behavior": a fixture that wants a careless
// model lists a `rogue` answer, and the agent's hard limits must stop it.
import { isChoiceOption, choiceGroup, choiceState, matchChoice } from "../../src/page-control/commands.js";
import { AGENT_RULES } from "../../src/shared/agent-rules.js";
import { factMatches, profileFact } from "../../src/shared/profile-facts.js";

const TEXT_ROLES = ["textbox", "textarea"];
const PICK_ROLES = ["select", "combobox"];
const norm = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const YES = /^(?:yes|true|y|checked?|on)$/i;
const ACKNOWLEDGEMENT = new RegExp(AGENT_RULES.consent.allow, "i");
const NOT_ACKNOWLEDGEMENT = new RegExp(AGENT_RULES.consent.deny, "i");

/** Elements, saved answers and skipped labels as the agent's snapshot text lays them out. */
export function readSnapshot(text) {
  const lines = String(text).split("\n");
  const elements = lines.filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const after = (prefix) => { const line = lines.find((l) => l.startsWith(prefix)); try { return line ? JSON.parse(line.slice(prefix.length)) : null; } catch { return null; } };
  elements.push(...(after("Other unchanged controls (current refs): ") ?? []));
  const groups = after("Groups (g): ") ?? {};
  const sections = after("Sections (s): ") ?? {};
  for (const el of elements) {
    if (el.g !== undefined) el.group = groups[el.g];
    if (el.s !== undefined) el.section = sections[el.s];
    if (el.popup && TEXT_ROLES.includes(el.role)) el.role = "combobox";
  }
  return { elements, saved: after("Saved answers (from the user's earlier applications): ") ?? {}, skipped: after("The user will fill these on the page themselves: ") ?? [], url: (lines[0] ?? "").replace(/^Page: /, "") };
}

/**
 * @param {{knowledge?: Array<{match: string, value?: string, checked?: boolean, rogue?: boolean, click?: string}>, reask?: boolean, stubborn?: boolean, clickNext?: boolean, wrongJson?: number, max_actions?: number, delay_ms?: number, fail?: Array<{at_call: number, status: number}>, failStatusOnError?: boolean}} options
 *   knowledge: [{match: "regex on the field's group or name", value}]; reask: ask again even what was asked before (a careless model);
 *   stubborn: propose a refused action again; fail: provider errors injected at call numbers (1-based); wrongJson: how many first replies have no tool call.
 * @param {{profile?: any, job?: any}} [context] the person and the job, which a model reads from its system message
 */
export function fakeModel(options = {}, context = {}) {
  const knowledge = (options.knowledge ?? []).map((k) => ({ ...k, re: new RegExp(k.match, "i") }));
  const state = { calls: 0, inputChars: 0, replies: [], answers: new Map(), skipped: new Set(), refused: new Set(), asked: [], answeredQuestions: [], context };
  const model = async (_config, messages, _maxTokens, look) => {
    state.calls += 1;
    if (options.delay_ms) await new Promise((resolve) => setTimeout(resolve, options.delay_ms));
    state.inputChars += messages.reduce((n, m) => n + String(m.content).length, 0) + JSON.stringify(look?.history ?? []).length;
    const failure = options.fail?.find((f) => f.at_call === state.calls);
    if (failure) throw Object.assign(new Error(`AI provider returned HTTP ${failure.status}. Check your endpoint, key and model.`), { status: options.failStatusOnError === false ? undefined : failure.status });
    if (state.calls <= (options.wrongJson ?? 0)) return { text: "I think you should fill the form.", tool_calls: [] };
    remember(state, look);
    // `gone`: a regex on the page text; a model that reads such a page ends the run with posting_gone.
    if (options.gone && new RegExp(options.gone, "i").test(String(messages.at(-1).content).split("Page text:")[1] ?? "")) {
      const gone = { text: JSON.stringify({ message: "The posting is closed.", actions: [] }), tool_calls: [{ name: "posting_gone", arguments: { reason: "The job posting is closed or has been removed." } }] };
      state.replies.push(gone);
      return gone;
    }
    const reply = decide(readSnapshot(messages.at(-1).content), state, knowledge, options);
    state.replies.push(reply);
    return reply;
  };
  model.state = state;
  return model;
}

/** What the model learns from the results of its last calls: the user's answers and skips, and refusals. */
function remember(state, look) {
  const history = look?.history ?? [];
  const calls = history.at(-1)?.role === "assistant" ? history.at(-1).calls : [];
  for (const result of look?.results ?? []) {
    const made = calls.find((c) => c.id === result.id);
    if (!made) continue;
    const ref = made.arguments?.ref;
    if (made.name === "ask_user") {
      const answered = /^The user answered: (".*")\. This answer is final/s.exec(result.content);
      if (answered) { state.answers.set(ref, JSON.parse(answered[1])); state.answeredQuestions.push(norm(made.arguments?.question)); }
      else if (/will fill this themselves/.test(result.content)) state.skipped.add(ref);
    } else if (result.is_error && /refused|direct approval|not a text field|will not overwrite|human check|consent|use check|let ai answer|themselves|did not show the value/i.test(result.content)) {
      for (const r of [ref, ...(made.arguments?.fields ?? []).map((f) => f.ref)]) if (r) state.refused.add(r);
    }
  }
}

// A field shares its label with another under a different heading ("Name" under "Current employer" and under "Most recent school"):
// a model reading the snapshot names the heading, as a person would.
let twinsOf = [];
const label = (el) => {
  const name = String(el.group || el.name || "");
  return el.section && !el.group && twinsOf.some((m) => m !== el && m.name === el.name && (m.section ?? "") !== el.section) ? `${el.section}: ${name}` : name;
};
const isOpen = (el, elements) => {
  if (el.disabled || el.user_edited) return false;
  if (isChoiceOption(el)) return !elements.some((m) => isChoiceOption(m) && m.group === el.group && choiceState(m) === true);
  if (el.role === "checkbox") return !el.checked;
  if (el.role === "radio") return !elements.some((m) => m.role === "radio" && m.group === el.group && m.checked);
  return !String(el.value ?? "").trim();
};

/** What a model would write into this field from the profile, saved answers, the user's answers and its own rules. */
function answerFor(el, snap, state, knowledge) {
  const { profile, job } = state.context;
  const user = state.answers.get(el.ref);
  if (user) return { value: user, source: "user_reply" };
  const saved = snap.saved[el.name] ?? snap.saved[el.group];
  if (saved) return { value: saved, source: "saved_answers" };
  if (profile) {
    const fact = profileFact(label(el), profile, job);
    if (el.role === "file") return /resume|cv/i.test(el.name ?? "") || snap.elements.filter((e) => e.role === "file").length === 1 ? (profile.resume_url || profile.has_resume_file ? { upload: true, source: "candidate.resume" } : null) : null;
    if (TEXT_ROLES.includes(el.role) && fact && !["yes", "no"].includes(fact)) return { value: fact, source: "candidate" };
    if (el.role === "checkbox" && !el.group && profile.preferences?.auto_consent === true && ACKNOWLEDGEMENT.test(`${el.name}`) && !NOT_ACKNOWLEDGEMENT.test(`${el.name}`)) return { checked: true, source: "candidate.preferences" };
    if (isChoiceOption(el) && fact && factMatches(fact, el.name)) return { value: el.name, source: "candidate" };
    if (PICK_ROLES.includes(el.role) && fact) return { value: fact === "yes" ? "Yes" : fact === "no" ? "No" : fact, source: "candidate" };
    const resolved = globalThis.JobHuntProfile?.profileAnswer?.(label(el), profile, job);
    if (resolved && !resolved.needsReview && resolved.value && !isChoiceOption(el) && el.role !== "checkbox") return { value: String(resolved.value), source: "candidate" };
  }
  const rule = knowledge.find((k) => k.re.test(label(el)) || k.re.test(String(el.name ?? "")));
  if (rule) return { value: rule.value, checked: rule.checked, source: rule.rogue ? "rogue" : "model" };
  return null;
}

function callFor(el, answer, snap) {
  const text = String(answer.value ?? "");
  if (el.role === "file") return answer.upload ? { name: "upload", arguments: { ref: el.ref, file: "resume" } } : null;
  if (TEXT_ROLES.includes(el.role)) return { name: "type_text", arguments: { ref: el.ref, text } };
  if (PICK_ROLES.includes(el.role)) return { name: "select_option", arguments: { ref: el.ref, text } };
  if (isChoiceOption(el)) {
    const match = matchChoice(choiceGroup(snap.elements, el), text);
    return match ? { name: "check", arguments: { ref: match.ref, checked: true } } : null;
  }
  if (el.role === "checkbox") return { name: "check", arguments: { ref: el.ref, checked: answer.checked ?? YES.test(text) } };
  return null;
}

function decide(snap, state, knowledge, options) {
  const els = snap.elements;
  twinsOf = els;
  const skippedByLabel = (el) => state.skipped.has(el.ref) || snap.skipped.some((s) => norm(s) === norm(label(el)) || norm(s) === norm(el.name));
  const seenGroups = new Set();
  const fields = els.filter((el) => {
    if (!(TEXT_ROLES.includes(el.role) || PICK_ROLES.includes(el.role) || el.role === "checkbox" || el.role === "radio" || el.role === "file" || isChoiceOption(el))) return false;
    if (el.group && (isChoiceOption(el) || el.role === "radio")) { if (seenGroups.has(el.group)) return false; seenGroups.add(el.group); }
    return isOpen(el, els) && !skippedByLabel(el);
  });
  const calls = [];
  const unanswered = [];
  for (const el of fields) {
    const refusedBefore = !options.stubborn && state.refused.has(el.ref) && !state.answers.has(el.ref); // what the user said since overrides a refusal
    const answer = refusedBefore ? null : answerFor(el, snap, state, knowledge);
    const call = answer ? callFor(el, answer, snap) : null;
    if (call) calls.push(call); else unanswered.push(el);
  }
  // Changed 2026-11-18: replies carry the agent's {"message","actions"} envelope. A fill turn is silent (""), as the prompt asks of the
  // first pass; a question, the hand-over and posting_gone say something.
  const reply = (list, message = "") => ({ text: JSON.stringify({ message, actions: [] }), tool_calls: list.slice(0, options.max_actions ?? 8) });
  if (calls.length) return reply(calls);
  // Nothing to fill: ask about the first open field in page order (required and optional alike), unless it was asked before.
  const askedBefore = (el) => state.asked.includes(norm(label(el))) || state.answeredQuestions.some((q) => q.includes(norm(label(el))) && norm(label(el)).length > 2);
  const next = unanswered.find((el) => options.reask || !askedBefore(el));
  if (next) { const question = `Please answer: ${label(next)}`; state.asked.push(norm(label(next))); return reply([{ name: "ask_user", arguments: { question, ref: next.ref } }], question); }
  const nav = els.find((el) => el.role === "button" && !el.disabled && /^(?:next|continue|save and continue)\b/i.test(el.name ?? ""));
  if (nav && options.clickNext !== false && !state.refused.has(nav.ref)) return reply([{ name: "click", arguments: { ref: nav.ref } }]);
  // A rogue model may try the submit-looking control; the agent must refuse it.
  const rogueClick = knowledge.find((k) => k.rogue && k.click);
  if (rogueClick) {
    const target = els.find((el) => new RegExp(rogueClick.click, "i").test(el.name ?? "") && el.role === "button");
    if (target && !state.refused.has(target.ref)) return reply([{ name: "click", arguments: { ref: target.ref } }]);
  }
  return reply([{ name: "done", arguments: { summary: "Everything I could fill is done." } }], "Everything I could fill is done.");
}
