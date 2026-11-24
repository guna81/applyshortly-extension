// The hard safety limits of the Agent based form assistant agent, enforced in code whatever the model decides. The model chooses every step;
// this file only enforces core safety rails: never submit, never sign in or pay, never touch a human check or password, consent and legal
// declarations only from the profile or the user, never overwrite user-edited answers or skipped fields, and verify required fields before `done`.
// Optional-field preference, file slot matching, and open-ended drafting ("Auto-draft open-ended answers") are decided by the model from the
// prompt and current switches. Generic by design: it knows roles, labels and states, never a company or a form.
import { AGENT_RULES } from "../shared/agent-rules.js";
import { candidateContext } from "../shared/candidate-context.js";
import { factMatches, profileFact } from "../shared/profile-facts.js";
import { choiceState, isChoiceOption, namesOption, optionsOf, scanFields } from "../page-control/commands.js";

const FORM_ROLES = ["textbox", "textarea", "select", "combobox", "radio", "checkbox", "file"];
const SAFE_KEYS = /^(?:Tab|Escape|Space|Backspace|Enter|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/;
const FORBIDDEN_CLICK = /\b(?:submit|send|finish|complete application|sign.?in|log.?in|register|pay|purchase)\b/i;
const COOKIE_DECLINE = /^(?:reject|decline|deny|refuse|opt[- ]?out)\b.*|\b(?:necessary|essential) (?:cookies )?only\b|\bonly (?:necessary|essential)\b/i;
const FORWARD_BUTTON = /^\s*(?:next|continue|save (?:and|&) continue|proceed|go on|done|apply)\b/i;
const PLACEHOLDER = /^(?:select|choose|pick|please select|--|none selected)[…\s.-]*$/i;
const BOT_CHECK = /\b(?:not a (?:robot|bot)|i(?:'| a)?m human|i am human|verify (?:that )?you(?:'re| are) (?:a )?human|human verification)\b/i;
const LEGAL_FACT = /visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|criminal|convict|felon|previously (?:employed|worked)|former(?:ly)? (?:employee|employed)|ever (?:been )?employed (?:by|at|with)/i;
const CONSENT = /\b(?:consent|certify|declare|swear|truthful|agree|accept|confirm|authori[sz](?:e|ed|ation)|permission to (?:call|contact)|terms (?:of|and)|privacy policy|acknowledge)\b/i;
const CITIZENSHIP = /\bcitizen(?:ship)?\b|permanent residen(?:t|ce|cy)/i;
const ACKNOWLEDGEMENT = new RegExp(AGENT_RULES.consent.allow, "i");
const NOT_ACKNOWLEDGEMENT = new RegExp(AGENT_RULES.consent.deny, "i");
const MAX_WAITS = 6;
const MAX_NAVIGATIONS = 2;
const ASK_CONSENT = "This is a consent, eligibility or legal choice only the user may make, and the profile and their earlier answers do not settle it. Call ask_user with the question.";

const onLastStep = (text: any) => {
  const body = String(text ?? "");
  const counted = /\bstep\s+(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(body);
  if (counted) return Number(counted[1]) >= Number(counted[2]);
  return /\b(?:final|last) step\b|\breview (?:and|&) submit\b/i.test(body);
};
export const questionKey = (text: any) => `q:${(AGENT_RULES.skip.case_sensitive ? String(text) : String(text).toLowerCase()).replace(/\s+/g, " ").trim()}`;
const controlHint = (el: any) => isChoiceOption(el) ? "It is one option of a question: choose it with check."
  : el.role === "button" || el.role === "link" ? "It is a button: click it only to move through the form."
  : ["select", "combobox"].includes(el.role) ? "Use select with the option's text."
  : ["radio", "checkbox"].includes(el.role) ? "Use check with checked true or false."
  : "Pick the matching control from the snapshot.";

/** The part of the guards' state that survives a restart: plain JSON. */
export const newGuardState = (): any => ({ skipped: [], labels: [], answers: {}, groupAnswers: {}, wrote: [], writeValues: {}, navigations: 0, waits: 0 });

/**
 * @param {{profile: any, job: any, allowDrafts?: () => boolean, fillOptional?: () => boolean}} config
 */
export function createGuards({ profile, job }: { profile: any; job?: any; allowDrafts?: () => boolean; fillOptional?: () => boolean }) {
  const candidate = candidateContext(profile);
  const identity = (obs: any, el: any) => JSON.stringify([obs.url, el?.frame, el?.section, el?.identity ?? "", el?.name, el?.group, el?.role]);
  const groupKey = (obs: any, el: any) => (el?.group ? JSON.stringify([obs.url, el.frame, el.section, el.group, "choice"]) : null);
  const isSkipped = (state: any, obs: any, el: any) => Boolean(el) && (state.skipped.includes(identity(obs, el)) || state.skipped.includes(questionKey(el.name)) || (groupKey(obs, el) !== null && state.skipped.includes(groupKey(obs, el))));
  const profileBacked = (question: any, option: any) => factMatches(profileFact(question, profile, job), option);
  const grouped = (el: any) => isChoiceOption(el) || (el.role === "checkbox" && Boolean(el.group));
  const chosenIn = (obs: any, el: any) => obs.elements.some((m: any) => grouped(m) && (el.group ? m.group === el.group && m.frame === el.frame && m.section === el.section : m.ref === el.ref) && choiceState(m) === true);
  const empty = (el: any) => !el.disabled && !el.user_edited && (["checkbox", "radio"].includes(el.role) ? !el.checked : !String(el.value ?? "").trim() || PLACEHOLDER.test(String(el.value).trim()));
  const hasFile = (file: any) => (file === "resume" ? Boolean(candidate.has_resume_file) : file === "cover_letter" ? Boolean(job?.cover_letter) : false);
  const anyFileAvailable = () => Boolean(candidate.has_resume_file || job?.cover_letter);

  // `question` is the text that was asked: when the page re-rendered and the ref is gone, the skip still holds by that text.
  const skip = (state: any, obs: any, ref: string, question = "") => {
    const el = obs.elements.find((e: any) => e.ref === ref) ?? (question ? { name: question } : null);
    if (!el) return;
    for (const key of [el.ref ? identity(obs, el) : null, el.ref ? groupKey(obs, el) : null, questionKey(el.group || el.name)]) if (key && !state.skipped.includes(key)) state.skipped.push(key);
    const label = String(el.group || el.name || "").slice(0, 200);
    if (label && !state.labels.includes(label)) state.labels.push(label);
  };
  const recordAnswer = (state: any, obs: any, ref: string, answer: any) => {
    const el = obs.elements.find((e: any) => e.ref === ref);
    if (!el) return;
    state.answers[identity(obs, el)] = String(answer).trim();
    if (groupKey(obs, el)) state.groupAnswers[groupKey(obs, el)] = String(answer).trim();
  };
  const noteWrite = (state: any, obs: any, ref: string) => {
    const el = obs.elements.find((e: any) => e.ref === ref);
    if (!el) return;
    const key = identity(obs, el);
    if (!state.wrote.includes(key)) state.wrote.push(key);
    (state.writeValues ??= {})[key] = choiceState(el) ?? el.value ?? "";
  };

  /** Required fields still empty, leaving out what the user took on, human checks and attachments when no file is available. */
  const missingRequired = (obs: any, state: any) => scanFields(obs).missing.filter((field: any) => {
    const el = obs.elements.find((e: any) => e.ref === field.ref);
    if (!el) return true;
    return !(isSkipped(state, obs, el) || BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`) || (el.role === "file" && !anyFileAvailable()));
  });

  /** Optional fields still empty (leaving out unavailable files, checkboxes, human checks and what the user took on): what "fill optional fields" still has to cover. */
  const emptyOptional = (obs: any, state: any) => scanFields(obs).fields.filter((field: any) => {
    if (field.required || !["textbox", "textarea", "select", "combobox", "radio", "file"].includes(field.role)) return false;
    const el = obs.elements.find((e: any) => e.ref === field.ref);
    return Boolean(el) && (el.role !== "file" || anyFileAvailable()) && open(obs, el) && !isSkipped(state, obs, el) && !BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`);
  });

  /**
   * One action through every hard limit. Returns {ok, action} (a loop action), {error} (told
   * to the model as a failed tool call) or {ask} (a question or hold the code puts to the user instead).
   */
  const vet = (input: any, obs: any, state: any): any => {
    const action = { ...input };
    const refuse = (error: string) => ({ error });
    const KNOWN = ["type", "select", "check", "upload", "click", "scroll", "options", "review", "switch_tab", "wait", "wait_for", "press", "hover", "drag", "run_js"];
    if (!KNOWN.includes(action.type)) return refuse(`Unknown action "${String(action.type).slice(0, 40)}".`);
    if (action.type === "wait" || action.type === "wait_for") {
      if (state.waits >= MAX_WAITS) { state.waits = 0; return { ask: { kind: "blocker", text: "The page still hasn't finished loading. Check it, then tap Continue." } }; }
      state.waits += 1;
    } else state.waits = 0;
    if (action.type === "run_js") {
      const code = String(action.code ?? "");
      if (!code.trim()) return refuse("run_js needs the code to run.");
      if (code.length > 4000) return refuse("run_js code is limited to 4000 characters.");
      return { ok: true, action: { type: "run_js", code, label: "Running a page script" } };
    }
    if (action.type === "switch_tab" && !obs.tabs?.some((tab: any) => tab.id === action.tab_id)) return refuse("That tab was not opened by this application.");
    const el = obs.elements.find((e: any) => e.ref === action.ref);
    if (el && ["check", "click", "type", "select"].includes(action.type) && BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`)) return refuse("That is a human check. The user completes it; leave it alone and continue with the rest of the form.");
    if (!["review", "options", "scroll", "switch_tab", "wait", "wait_for"].includes(action.type) && !el) return refuse("That ref is not on the page any more. Use a ref from the latest snapshot.");
    if (el && isSkipped(state, obs, el) && ["type", "select", "check", "upload", "click", "press", "hover"].includes(action.type)) return refuse("The user said they will fill this themselves on the page: leave it alone.");
    if (el?.disabled || el?.input_type === "password") return refuse("The selected field cannot be changed.");
    const mine = el && state.writeValues?.[identity(obs, el)] === (choiceState(el) ?? el.value ?? "");
    const answered = el ? state.answers[identity(obs, el)] : undefined;
    if (["type", "select"].includes(action.type)) {
      if (action.type === "type" && !["textbox", "textarea"].includes(el.role)) return refuse(`The selected control is a ${el.role}, not a text field. ${controlHint(el)}`);
      if (action.type === "select" && !["select", "combobox"].includes(el.role) && !el.popup) return refuse(`The selected control is a ${el.role}, not a dropdown. ${controlHint(el)}`);
      if (typeof action.text !== "string" || !action.text.trim() || action.text.length > 2000) return refuse("The answer text is missing or too long.");

      if (action.type === "type" && Number.isInteger(el.text_limit) && action.text.length > el.text_limit) return refuse(`The control accepts at most ${el.text_limit} characters.`);
      if (action.type === "select" && el.options?.length && !el.options.includes(action.text)) return refuse("Choose an option exactly as shown by the control.");

      const name = `${el.group ?? ""} ${el.name ?? ""}`;
      const userSaidIt = answered !== undefined && answered.trim().toLowerCase() === action.text.trim().toLowerCase();
      if ((CONSENT.test(String(el.name ?? "")) || CITIZENSHIP.test(String(el.name ?? "")) || LEGAL_FACT.test(name)) && !userSaidIt && !profileBacked(el.name, action.text)) return refuse(ASK_CONSENT);
      const holds = String(el.value ?? "").trim() && !PLACEHOLDER.test(String(el.value).trim());
      if (el.user_edited || (!mine && holds && !(action.type === "select" && (el.expanded === true || ["select", "combobox"].includes(el.role))))) return refuse("The agent will not overwrite an existing answer.");
    }
    if (action.type === "check") {
      const option = isChoiceOption(el);
      if (!(["radio", "checkbox"].includes(el.role) || option) || typeof action.checked !== "boolean" || ((el.role === "radio" || (option && el.group)) && !action.checked)) return refuse(`check works on a checkbox, radio or yes/no option with checked true or false. ${controlHint(el)}`);
      const text = `${el.group ?? ""} ${el.name ?? ""}`;
      const standing = profile.preferences?.auto_consent === true && el.role === "checkbox" && action.checked === true && ACKNOWLEDGEMENT.test(text) && !NOT_ACKNOWLEDGEMENT.test(text);
      const said = (option || (el.role === "checkbox" && el.group)) && groupKey(obs, el) ? state.groupAnswers[groupKey(obs, el)] : undefined;
      const userChose = said !== undefined && namesOption(optionsOf(obs.elements, el), said, el);
      const userConfirmed =
        el.role === "checkbox" &&
        !el.group &&
        answered !== undefined &&
        (action.checked
          ? /^(?:yes|y|true|agree|i agree|accept|ok|okay|sure|confirm|check|checked|tick)\b/i.test(answered.trim())
          : /^(?:no|n|false|disagree|decline|uncheck|unchecked)\b/i.test(answered.trim()));
      if ((CONSENT.test(text) || NOT_ACKNOWLEDGEMENT.test(text) || LEGAL_FACT.test(text)) && !standing && !userChose && !userConfirmed && !profileBacked(el.group || el.name, el.name)) return refuse(ASK_CONSENT);
      const otherChosen = option && el.group && obs.elements.some((m: any) => isChoiceOption(m) && m.group === el.group && m.ref !== el.ref && choiceState(m) === true);
      if (el.user_edited || otherChosen || (!mine && el.checked && !action.checked)) return refuse("The agent will not overwrite an existing answer.");
      if (mine && el.checked && action.checked) return refuse("That is already chosen.");
    }
    if (action.type === "click") {
      const fields = obs.elements.filter((e: any) => ["textbox", "textarea", "select", "combobox"].includes(e.role) && !e.disabled && !["password", "hidden", "search"].includes(e.input_type));
      const noForm = fields.length < 3 && !obs.elements.some((e: any) => e.role === "file" && !e.disabled) && state.wrote.length === 0;
      const linkToForm = noForm && el.role === "link" && /^https?:/i.test(el.href ?? "");
      let sameOrigin = true; let scheme = true;
      try { if (el.href) { const target = new URL(el.href, obs.url); sameOrigin = target.origin === new URL(obs.url).origin; scheme = /^https?:$/.test(target.protocol); } } catch { scheme = false; }
      const lastStep = el.role === "button" && FORWARD_BUTTON.test(String(el.name ?? "")) && onLastStep(obs.text);
      const forbidden = FORBIDDEN_CLICK.test(linkToForm ? String(el.name ?? "").replace(/\bsubmit\b/gi, "") : String(el.name ?? ""));
      if (el.submit_like || lastStep || forbidden || (el.role === "link" && !el.href) || (!sameOrigin && !noForm) || !scheme) {
        return refuse(`That action needs your direct approval on the page.${el.submit_like || lastStep ? " (looks like a final submit)" : el.role === "link" && !el.href ? " (link has no address)" : !sameOrigin && !noForm ? " (the page already has a form)" : ""}`);
      }
      // A choice is made with check (so its overwrite limits apply) and a file with upload; a click would bypass them.
      if (["checkbox", "radio"].includes(el.role) || isChoiceOption(el)) return refuse(`Use check for this control, not click. ${controlHint(el)}`);
      if (el.role === "option") {
        const parents = obs.elements.filter((parent: any) => el.group?.trim() && parent.name === el.group && parent.frame === el.frame && parent.section === el.section && (["select", "combobox", "listbox"].includes(parent.role) || parent.popup) && parent.expanded !== false);
        const parent = parents.length === 1 ? parents[0] : null;
        if (!parent || parent.disabled || parent.user_edited || isSkipped(state, obs, parent) || el.selected || el.checked) return refuse("Choose an unselected option from the current, editable picker.");
        if (parent.value && !PLACEHOLDER.test(String(parent.value).trim()) && parent.expanded !== true) return refuse("The picker already has an answer.");
        const question = String(parent.name ?? "");
        if (CONSENT.test(question) || LEGAL_FACT.test(question) || NOT_ACKNOWLEDGEMENT.test(question)) return refuse(ASK_CONSENT);
      }
      const said = `${el.group ?? ""} ${el.name ?? ""}`;
      if (el.role === "switch" && (CONSENT.test(said) || LEGAL_FACT.test(said)) && !(answered !== undefined && /^(?:yes|on|true)$/i.test(answered.trim()))) return refuse(ASK_CONSENT);
      if (el.role === "file") return refuse("Use upload for a file field, not click.");
      if (noForm && !COOKIE_DECLINE.test(String(el.name ?? "").trim())) {
        if (state.navigations >= MAX_NAVIGATIONS) return { ask: { kind: "blocker", text: "I couldn't find the application form after two page changes. Open the form yourself, then tell me to continue." } };
        state.navigations += 1;
      }
    }

    if (action.type === "upload") {
      if (el.role !== "file") return refuse("upload works on a file field only.");
      if (!hasFile(action.file)) return { ask: { kind: "click", ref: el.ref, text: `Attach ${el.name || "the file"} on the page, then Continue.`, optional: el.required === false } };
    }
    if (action.type === "drag") {
      const to = obs.elements.find((e: any) => e.ref === action.to_ref);
      if (!to || to.disabled || el.disabled || to.submit_like || el.submit_like || el.user_edited) return refuse("Drag needs two current, enabled controls that are not a final submit.");
    }
    if (action.type === "wait_for" && (typeof action.text !== "string" || !action.text.trim())) return refuse("wait_for needs the text to wait for.");
    if (action.type === "press") {
      action.key = action.key ?? action.text;
      if (!SAFE_KEYS.test(String(action.key ?? ""))) return refuse("That key is not allowed. Use Tab, Escape, Space, Backspace or an Arrow key; Enter only works inside an open dropdown.");
    }
    if (action.type === "scroll" && !["up", "down"].includes(action.direction)) return refuse("scroll needs a direction, up or down.");
    const verb = ({ type: "Filled", select: "Selected", check: "Chose" } as Record<string, string>)[action.type];
    const label = verb && el ? `${verb} ${String(el.group || el.name || "the field").slice(0, 80)}` : (({ review: "Reviewing the form", options: "Looking at the options" } as Record<string, string>)[action.type] ?? String(action.type));
    const ms = ["wait", "wait_for"].includes(action.type) && Number.isFinite(Number(action.ms)) ? Math.min(Math.max(0, Number(action.ms)), action.type === "wait" ? 5000 : 10000) : undefined;
    return { ok: true, action: { type: action.type, ref: action.ref, text: action.type === "press" ? undefined : action.text, checked: action.checked, direction: action.direction,
      key: action.type === "press" ? String(action.key) : undefined, tab_id: action.type === "switch_tab" ? action.tab_id : undefined, to_ref: action.type === "drag" ? action.to_ref : undefined,
      ms, file: action.type === "upload" ? action.file : undefined, label } };
  };

  /** Whether a field (or a pick-one question) still waits for an answer. */
  const open = (obs: any, el: any) => (grouped(el) ? !el.disabled && !el.submit_like && !chosenIn(obs, el) : empty(el));
  return { vet, open, skip, recordAnswer, noteWrite, missingRequired, emptyOptional, identity, isSkipped, formRoles: FORM_ROLES, botCheck: (el: any) => BOT_CHECK.test(`${el?.group ?? ""} ${el?.name ?? ""}`) };
}
