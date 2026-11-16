// A deterministic stand-in for the provider (Tier 0 in-process, Tier 1 behind the testbed model_proxy.mjs in the platform repo).
// It tests the plumbing (observation, widget actions, vetoes, dedupe, resume), not model judgment: it does exactly
// what its `knowledge` says, in page order, and asks the user about anything else. No hidden "good behavior":
// a fixture that wants a careless model lists a `rogue` answer, and the planner's vetoes must stop it.
import { isChoiceOption, choiceGroup, choiceState, matchChoice } from "../../src/agent/commands.js";

const TEXT_ROLES = ["textbox", "textarea"];
const PICK_ROLES = ["select", "combobox"];
const norm = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const YES = /^(?:yes|true|y|checked?|on)$/i;

/**
 * @param {{knowledge?: Array<{match: string, value?: string, checked?: boolean, rogue?: boolean}>, reask?: boolean, batch?: boolean, clickNext?: boolean, wrongJson?: number, fail?: Array<{at_call: number, status: number}>}} [options]
 *   knowledge: [{match: "regex on the field's group or name", value}]; reask: ask again even what was asked before (a careless model);
 *   fail: provider errors injected at call numbers (1-based); wrongJson: how many first replies are not JSON.
 */
export function fakeModel(options = {}) {
  const knowledge = (options.knowledge ?? []).map((k) => ({ ...k, re: new RegExp(k.match, "i") }));
  const state = { calls: 0, audits: 0, prompts: [], inputChars: 0, replies: [] };
  const model = async (_config, messages, _maxTokens, look) => {
    state.calls += 1;
    if (options.delay_ms) await new Promise((resolve) => setTimeout(resolve, options.delay_ms));
    const raw = messages.at(-1).content;
    const content = Array.isArray(raw) ? raw.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : raw;
    state.inputChars += messages.reduce((n, m) => n + String(m.content).length, 0);
    const failure = options.fail?.find((f) => f.at_call === state.calls);
    if (failure) throw Object.assign(new Error(`AI provider returned HTTP ${failure.status}. Check your endpoint, key and model.`), { status: options.failStatusOnError === false ? undefined : failure.status });
    if (state.calls <= (options.wrongJson ?? 0)) return "I think you should fill the form.";
    const data = JSON.parse(content);
    state.prompts.push(data);
    if (data.audit) { state.audits += 1; return JSON.stringify({ status: "ready_for_review", message: "Everything I could fill is done." }); }
    const batch = options.batch ?? /"actions":\[/.test(String(messages[0].content));
    const reply = decide(data, knowledge, options, batch);
    state.replies.push(reply);
    return JSON.stringify(reply);
  };
  model.state = state;
  return model;
}

const label = (el) => String(el.group || el.name || "");
const isOpen = (el, data) => {
  if (el.disabled || el.user_edited) return false;
  if (isChoiceOption(el)) return !(data.observation.elements.some((m) => isChoiceOption(m) && m.group === el.group && choiceState(m) === true));
  if (el.role === "checkbox") return !el.checked;
  if (el.role === "radio") return !data.observation.elements.some((m) => m.role === "radio" && m.group === el.group && m.checked);
  if (el.role === "file") return !String(el.value ?? "").trim();
  return !String(el.value ?? "").trim();
};
const skippedField = (el, data) => (data.skipped_fields ?? []).some((s) => norm(s) === norm(label(el)) || norm(s) === norm(el.name));
const alreadyAsked = (el, data) => (data.asked_questions ?? []).some((q) => norm(q).includes(norm(label(el))) && norm(label(el)).length > 2)
  || (data.user_answered ?? []).some((a) => norm(a.question).includes(norm(label(el))) && norm(label(el)).length > 2);

function answerFor(el, data, knowledge) {
  const byRef = data.user_answers_by_ref?.[el.ref];
  if (byRef) return { value: byRef, source: "user_reply" };
  const saved = data.saved_answers?.[el.name] ?? data.saved_answers?.[el.group];
  if (saved) return { value: saved, source: "saved_answers" };
  const hint = (data.suggested_actions ?? []).find((s) => s.ref === el.ref);
  if (hint) return { value: hint.text ?? (hint.checked ? "yes" : undefined), source: "candidate", hint };
  const rule = knowledge.find((k) => k.re.test(label(el)) || k.re.test(String(el.name ?? "")));
  if (rule) return { value: rule.value, checked: rule.checked, source: rule.rogue ? "rogue" : "model", rule };
  return null;
}

function actionFor(el, answer, data) {
  const text = String(answer.value ?? "");
  if (TEXT_ROLES.includes(el.role)) return { type: "type", ref: el.ref, text, source: answer.source };
  if (PICK_ROLES.includes(el.role)) return { type: "select", ref: el.ref, text, source: answer.source };
  if (isChoiceOption(el)) {
    const match = matchChoice(choiceGroup(data.observation.elements, el), text);
    return match ? { type: "check", ref: match.ref, checked: true, source: answer.source } : null;
  }
  if (el.role === "checkbox") return { type: "check", ref: el.ref, checked: answer.checked ?? YES.test(text), source: answer.source };
  if (el.role === "file" && data.candidate?.has_resume_file) return { type: "upload", ref: el.ref, source: "candidate.resume" };
  return null;
}

function decide(data, knowledge, options, batch) {
  const els = data.observation.elements;
  const seenGroups = new Set();
  const fields = els.filter((el) => {
    if (!(TEXT_ROLES.includes(el.role) || PICK_ROLES.includes(el.role) || el.role === "checkbox" || el.role === "radio" || el.role === "file" || isChoiceOption(el))) return false;
    if (el.group && (isChoiceOption(el) || el.role === "radio")) { if (seenGroups.has(el.group)) return false; seenGroups.add(el.group); }
    return isOpen(el, data) && !skippedField(el, data);
  });
  const actions = [];
  const unanswered = [];
  // Like a real model, follow a refusal: what the planner sent back as rejected is not proposed again (unless `stubborn`).
  const refused = new Set((data.rejected_last_turn ?? []).map((r) => r.ref));
  const wasRefused = (el) => refused.has(el.ref) || (el.group && els.some((m) => m.group === el.group && refused.has(m.ref)));
  for (const el of fields) {
    const answer = !options.stubborn && wasRefused(el) ? null : answerFor(el, data, knowledge);
    const action = answer ? actionFor(el, answer, data) : null;
    if (action) actions.push(action); else unanswered.push(el);
  }
  const send = (list) => (batch ? { status: "continue", message: "Filling the form.", actions: list.slice(0, options.max_actions ?? 8) } : { status: "continue", message: "Filling the next field.", action: list[0] });
  if (actions.length) return send(actions);
  // Nothing to fill: ask about the first open field (required first), unless it was asked before.
  const required = [...unanswered].sort((a, b) => Number(b.required !== false) - Number(a.required !== false));
  const next = required.find((el) => options.reask || !alreadyAsked(el, data));
  if (next) return { status: "ask_user", message: "I need your answer.", question: { kind: "question", text: `Please answer: ${label(next)}`, ref: next.ref, optional: next.required === false } };
  const nav = els.find((el) => el.role === "button" && !el.disabled && /^(?:next|continue|save and continue)\b/i.test(el.name ?? ""));
  if (nav && options.clickNext !== false && !data.rejected_last_turn?.some((r) => r.ref === nav.ref)) return send([{ type: "click", ref: nav.ref }]);
  // A rogue model may try the submit-looking control; the planner must refuse it.
  const rogueClick = knowledge.find((k) => k.rogue && k.click);
  if (rogueClick) {
    const target = els.find((el) => new RegExp(rogueClick.click, "i").test(el.name ?? "") && el.role === "button");
    if (target && !data.rejected_last_turn?.some((r) => r.ref === target.ref)) return send([{ type: "click", ref: target.ref }]);
  }
  return { status: "ready_for_review", message: "Everything I could fill is done." };
}
