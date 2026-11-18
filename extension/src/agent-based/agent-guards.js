import { AGENT_RULES } from "../shared/agent-rules.js";
import { candidateContext } from "../shared/candidate-context.js";
import { factMatches, profileFact } from "../shared/profile-facts.js";
import { choiceState, isChoiceOption, namesOption, optionsOf, scanFields } from "../page-control/commands.js";
const FORM_ROLES = ["textbox", "textarea", "select", "combobox", "radio", "checkbox", "file"];
const SAFE_KEYS = /^(?:Tab|Escape|Space|Backspace|Enter|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/;
const FORBIDDEN_CLICK = /\b(?:submit|send|finish|complete application|sign.?in|log.?in|register|accept|agree|authorize|confirm|pay|purchase)\b/i;
const COOKIE_DECLINE = /^(?:reject|decline|deny|refuse|opt[- ]?out)\b.*|\b(?:necessary|essential) (?:cookies )?only\b|\bonly (?:necessary|essential)\b/i;
const FORWARD_BUTTON = /^\s*(?:next|continue|save (?:and|&) continue|proceed|go on|done|apply)\b/i;
const PLACEHOLDER = /^(?:select|choose|pick|please select|--|none selected)[…\s.-]*$/i;
const BOT_CHECK = /\b(?:not a (?:robot|bot)|i(?:'| a)?m human|i am human|verify (?:that )?you(?:'re| are) (?:a )?human|human verification)\b/i;
const LEGAL_FACT = /visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|criminal|convict|felon|previously (?:employed|worked)|former(?:ly)? (?:employee|employed)|ever (?:been )?employed (?:by|at|with)/i;
const CONSENT = /\b(?:consent|certify|declare|swear|truthful|agree|accept|confirm|authori[sz](?:e|ed|ation)|permission to (?:call|contact)|terms (?:of|and)|privacy policy|acknowledge)\b/i;
const CITIZENSHIP = /\bcitizen(?:ship)?\b|permanent residen(?:t|ce|cy)/i;
const LONG_ANSWER = /\b(?:describe|explain|tell us|why|motivation|cover letter)\b/i;
const ACKNOWLEDGEMENT = new RegExp(AGENT_RULES.consent.allow, "i");
const NOT_ACKNOWLEDGEMENT = new RegExp(AGENT_RULES.consent.deny, "i");
const MAX_WAITS = 6;
const MAX_NAVIGATIONS = 2;
const ASK_CONSENT = "This is a consent, eligibility or legal choice only the user may make, and the profile and their earlier answers do not settle it. Call ask_user with the question.";
const onLastStep = (text) => {
  const body = String(text ?? "");
  const counted = /\bstep\s+(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(body);
  if (counted) return Number(counted[1]) >= Number(counted[2]);
  return /\b(?:final|last) step\b|\breview (?:and|&) submit\b/i.test(body);
};
const plainText = (value) => String(value).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)").replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1").replace(/(^|\n)\s*[-*+]\s+/g, "$1\u2022 ").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/`([^`\n]+)`/g, "$1").trim();
const questionKey = (text) => `q:${(AGENT_RULES.skip.case_sensitive ? String(text) : String(text).toLowerCase()).replace(/\s+/g, " ").trim()}`;
const controlHint = (el) => isChoiceOption(el) ? "It is one option of a question: choose it with check." : el.role === "button" || el.role === "link" ? "It is a button: click it only to move through the form." : ["select", "combobox"].includes(el.role) ? "Use select with the option's text." : ["radio", "checkbox"].includes(el.role) ? "Use check with checked true or false." : "Pick the matching control from the snapshot.";
const newGuardState = () => ({ skipped: [], labels: [], answers: {}, groupAnswers: {}, wrote: [], navigations: 0, waits: 0, instruction: "", draftFor: null });
function createGuards({ profile, job, allowDrafts, fillOptional }) {
  const candidate = candidateContext(profile);
  const identity = (obs, el) => JSON.stringify([obs.url, el?.frame, el?.section, el?.identity ?? "", el?.name, el?.group, el?.role]);
  const groupKey = (obs, el) => el?.group ? JSON.stringify([obs.url, el.frame, el.section, el.group, "choice"]) : null;
  const isSkipped = (state, obs, el) => Boolean(el) && (state.skipped.includes(identity(obs, el)) || state.skipped.includes(questionKey(el.name)) || groupKey(obs, el) !== null && state.skipped.includes(groupKey(obs, el)));
  const profileBacked = (question, option) => factMatches(profileFact(question, profile, job), option);
  const grouped = (el) => isChoiceOption(el) || el.role === "checkbox" && Boolean(el.group);
  const chosenIn = (obs, el) => obs.elements.some((m) => grouped(m) && (el.group ? m.group === el.group && m.frame === el.frame && m.section === el.section : m.ref === el.ref) && choiceState(m) === true);
  const empty = (el) => !el.disabled && !el.user_edited && (["checkbox", "radio"].includes(el.role) ? !el.checked : !String(el.value ?? "").trim() || PLACEHOLDER.test(String(el.value).trim()));
  const uploadFile = (obs, el) => {
    if (el.role !== "file") return null;
    if (/cover.?letter/i.test(el.name ?? "")) return job?.cover_letter ? "cover_letter" : null;
    const resume = /resume|résumé|\bcv\b|curriculum/i.test(el.name ?? "");
    const sole = obs.elements.filter((e) => e.role === "file" && !e.disabled).length === 1 && !/cover|letter|photo|picture|portfolio|certificate|id\b|passport|transcript/i.test(el.name ?? "");
    return candidate.has_resume_file && (resume || sole) ? "resume" : null;
  };
  const skip = (state, obs, ref, question = "") => {
    const el = obs.elements.find((e) => e.ref === ref) ?? (question ? { name: question } : null);
    if (!el) return;
    for (const key of [el.ref ? identity(obs, el) : null, el.ref ? groupKey(obs, el) : null, questionKey(el.group || el.name)]) if (key && !state.skipped.includes(key)) state.skipped.push(key);
    const label = String(el.group || el.name || "").slice(0, 200);
    if (label && !state.labels.includes(label)) state.labels.push(label);
  };
  const recordAnswer = (state, obs, ref, answer) => {
    const el = obs.elements.find((e) => e.ref === ref);
    if (!el) return;
    state.answers[identity(obs, el)] = String(answer).trim();
    if (groupKey(obs, el)) state.groupAnswers[groupKey(obs, el)] = String(answer).trim();
  };
  const noteWrite = (state, obs, ref) => {
    const el = obs.elements.find((e) => e.ref === ref);
    if (el && !state.wrote.includes(identity(obs, el))) state.wrote.push(identity(obs, el));
  };
  const missingRequired = (obs, state) => scanFields(obs).missing.filter((field) => {
    const el = obs.elements.find((e) => e.ref === field.ref);
    if (!el) return true;
    return !(isSkipped(state, obs, el) || BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`) || el.role === "file" && !uploadFile(obs, el));
  });
  const emptyOptional = (obs, state) => scanFields(obs).fields.filter((field) => {
    if (field.required || !["textbox", "textarea", "select", "combobox", "radio", "file"].includes(field.role)) return false;
    const el = obs.elements.find((e) => e.ref === field.ref);
    return Boolean(el) && (el.role !== "file" || Boolean(uploadFile(obs, el))) && open(obs, el) && !isSkipped(state, obs, el) && !BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`);
  });
  const vet = (input, obs, state, { inspectOnly = false } = {}) => {
    const action = { ...input };
    const refuse = (error) => ({ error });
    const KNOWN = ["type", "select", "check", "upload", "click", "scroll", "options", "review", "switch_tab", "wait", "wait_for", "press", "hover", "drag", "run_js"];
    if (!KNOWN.includes(action.type)) return refuse(`Unknown action "${String(action.type).slice(0, 40)}".`);
    if (inspectOnly && !["options", "review"].includes(action.type)) return refuse("A question cannot change the form: the user has not asked for a change. Answer in text, or ask them to confirm a change.");
    if (action.type === "wait" || action.type === "wait_for") {
      if (state.waits >= MAX_WAITS) {
        state.waits = 0;
        return { ask: { kind: "blocker", text: "The page still hasn't finished loading. Check it, then tap Continue." } };
      }
      state.waits += 1;
    } else state.waits = 0;
    if (action.type === "run_js") {
      const code = String(action.code ?? "");
      if (!code.trim()) return refuse("run_js needs the code to run.");
      if (code.length > 4e3) return refuse("run_js code is limited to 4000 characters.");
      return { ok: true, action: { type: "run_js", code, label: "Running a page script" } };
    }
    if (action.type === "switch_tab" && !obs.tabs?.some((tab) => tab.id === action.tab_id)) return refuse("That tab was not opened by this application.");
    const el = obs.elements.find((e) => e.ref === action.ref);
    if (fillOptional() === false && el?.required === false && ["check", "type", "select", "upload"].includes(action.type)) return refuse("The user turned off filling optional fields. Leave every optional field alone and continue with the required ones.");
    if (el && ["check", "click", "type", "select"].includes(action.type) && BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`)) return refuse("That is a human check. The user completes it; leave it alone and continue with the rest of the form.");
    if (!["review", "options", "scroll", "switch_tab", "wait", "wait_for"].includes(action.type) && !el) return refuse("That ref is not on the page any more. Use a ref from the latest snapshot.");
    if (el && isSkipped(state, obs, el) && ["type", "select", "check", "upload", "click", "press", "hover"].includes(action.type)) return refuse("The user said they will fill this themselves on the page: leave it alone.");
    if (el?.disabled || el?.input_type === "password") return refuse("The selected field cannot be changed.");
    const mine = el ? state.wrote.includes(identity(obs, el)) : false;
    const answered = el ? state.answers[identity(obs, el)] : void 0;
    if (["type", "select"].includes(action.type)) {
      if (action.type === "type" && !["textbox", "textarea"].includes(el.role)) return refuse(`The selected control is a ${el.role}, not a text field. ${controlHint(el)}`);
      if (action.type === "select" && !["select", "combobox"].includes(el.role) && !el.popup) return refuse(`The selected control is a ${el.role}, not a dropdown. ${controlHint(el)}`);
      if (typeof action.text !== "string" || !action.text.trim() || action.text.length > 2e3) return refuse("The answer text is missing or too long.");
      if (action.type === "type") action.text = plainText(action.text);
      const name = `${el.group ?? ""} ${el.name ?? ""}`;
      const userSaidIt = answered !== void 0 && answered.trim().toLowerCase() === action.text.trim().toLowerCase();
      if ((CONSENT.test(String(el.name ?? "")) || CITIZENSHIP.test(String(el.name ?? "")) || LEGAL_FACT.test(name)) && !userSaidIt && !profileBacked(el.name, action.text)) return refuse(ASK_CONSENT);
      if (action.type === "type" && empty(el) && (el.role === "textarea" || LONG_ANSWER.test(el.name ?? "")) && !userSaidIt) {
        const asked = /\b(?:draft|write|compose|explain|describe|summari[sz]e)\b/i.test(state.instruction) && !/\b(?:don't|do not|never)\b/i.test(state.instruction);
        const tapped = state.draftFor === "*" || state.draftFor === identity(obs, el);
        if (!allowDrafts() && !tapped && !asked) return refuse(`This is an open-ended answer and the user's "Let AI answer" switch is off: do not write it. Call ask_user with the draft action so they can type it or choose Draft it for me.`);
      }
      const explicitEdit = /\b(?:change|replace|correct|update|clear)\b/i.test(state.instruction) && String(el.name ?? "").length >= 3 && state.instruction.toLowerCase().includes(String(el.name).toLowerCase());
      const holds = String(el.value ?? "").trim() && !PLACEHOLDER.test(String(el.value).trim());
      if (!explicitEdit && !mine && (el.user_edited || holds)) return refuse("The agent will not overwrite an existing answer.");
    }
    if (action.type === "check") {
      const option = isChoiceOption(el);
      if (!(["radio", "checkbox"].includes(el.role) || option) || typeof action.checked !== "boolean" || (el.role === "radio" || option && el.group) && !action.checked) return refuse(`check works on a checkbox, radio or yes/no option with checked true or false. ${controlHint(el)}`);
      const text = `${el.group ?? ""} ${el.name ?? ""}`;
      const standing = profile.preferences?.auto_consent === true && el.role === "checkbox" && action.checked === true && ACKNOWLEDGEMENT.test(text) && !NOT_ACKNOWLEDGEMENT.test(text);
      const said = (option || el.role === "checkbox" && el.group) && groupKey(obs, el) ? state.groupAnswers[groupKey(obs, el)] : void 0;
      const userChose = said !== void 0 && namesOption(optionsOf(obs.elements, el), said, el);
      if ((CONSENT.test(text) || NOT_ACKNOWLEDGEMENT.test(text) || LEGAL_FACT.test(text)) && !standing && !userChose && !profileBacked(el.group || el.name, el.name)) return refuse(ASK_CONSENT);
      const otherChosen = option && el.group && obs.elements.some((m) => isChoiceOption(m) && m.group === el.group && m.ref !== el.ref && choiceState(m) === true);
      if (!mine && (el.user_edited || el.checked && !action.checked || otherChosen)) return refuse("The agent will not overwrite an existing answer.");
      if (mine && el.checked && action.checked) return refuse("That is already chosen.");
    }
    if (action.type === "click") {
      const fields = obs.elements.filter((e) => ["textbox", "textarea", "select", "combobox"].includes(e.role) && !e.disabled && !["password", "hidden", "search"].includes(e.input_type));
      const noForm = fields.length < 3 && !obs.elements.some((e) => e.role === "file" && !e.disabled) && state.wrote.length === 0;
      const linkToForm = noForm && el.role === "link" && /^https?:/i.test(el.href ?? "");
      let sameOrigin = true;
      let scheme = true;
      try {
        if (el.href) {
          const target = new URL(el.href, obs.url);
          sameOrigin = target.origin === new URL(obs.url).origin;
          scheme = /^https?:$/.test(target.protocol);
        }
      } catch {
        scheme = false;
      }
      const lastStep = el.role === "button" && FORWARD_BUTTON.test(String(el.name ?? "")) && onLastStep(obs.text);
      const forbidden = FORBIDDEN_CLICK.test(linkToForm ? String(el.name ?? "").replace(/\bsubmit\b/gi, "") : String(el.name ?? ""));
      if (el.submit_like || lastStep || forbidden || el.role === "link" && !el.href || !sameOrigin && !noForm || !scheme) {
        return refuse(`That action needs your direct approval on the page.${el.submit_like || lastStep ? " (looks like a final submit)" : el.role === "link" && !el.href ? " (link has no address)" : !sameOrigin && !noForm ? " (the page already has a form)" : ""}`);
      }
      if (["checkbox", "radio"].includes(el.role) || isChoiceOption(el)) return refuse(`Use check for this control, not click. ${controlHint(el)}`);
      const said = `${el.group ?? ""} ${el.name ?? ""}`;
      if (el.role === "switch" && (CONSENT.test(said) || LEGAL_FACT.test(said)) && !(answered !== void 0 && /^(?:yes|on|true)$/i.test(answered.trim()))) return refuse(ASK_CONSENT);
      if (el.role === "file") return refuse("Use upload for a file field, not click.");
      if (noForm && !COOKIE_DECLINE.test(String(el.name ?? "").trim())) {
        if (state.navigations >= MAX_NAVIGATIONS) return { ask: { kind: "blocker", text: "I couldn't find the application form after two page changes. Open the form yourself, then tell me to continue." } };
        state.navigations += 1;
      }
    }
    const coverLetter = action.type === "upload" && uploadFile(obs, el) === "cover_letter";
    if (action.type === "upload") {
      if (el.role !== "file") return refuse("upload works on a file field only.");
      if (!uploadFile(obs, el)) return { ask: { kind: "click", ref: el.ref, text: `Attach ${el.name || "the file"} on the page, then Continue.`, optional: el.required === false } };
    }
    if (action.type === "drag") {
      const to = obs.elements.find((e) => e.ref === action.to_ref);
      if (!to || to.disabled || el.disabled || to.submit_like || el.submit_like || el.user_edited) return refuse("Drag needs two current, enabled controls that are not a final submit.");
    }
    if (action.type === "wait_for" && (typeof action.text !== "string" || !action.text.trim())) return refuse("wait_for needs the text to wait for.");
    if (action.type === "press") {
      action.key = action.key ?? action.text;
      if (!SAFE_KEYS.test(String(action.key ?? ""))) return refuse("That key is not allowed. Use Tab, Escape, Space, Backspace or an Arrow key; Enter only works inside an open dropdown.");
    }
    if (action.type === "scroll" && !["up", "down"].includes(action.direction)) return refuse("scroll needs a direction, up or down.");
    const verb = { type: "Filled", select: "Selected", check: "Chose" }[action.type];
    const label = verb && el ? `${verb} ${String(el.group || el.name || "the field").slice(0, 80)}` : { review: "Reviewing the form", options: "Looking at the options" }[action.type] ?? String(action.type);
    const ms = ["wait", "wait_for"].includes(action.type) && Number.isFinite(Number(action.ms)) ? Math.min(Math.max(0, Number(action.ms)), action.type === "wait" ? 5e3 : 1e4) : void 0;
    return { ok: true, action: {
      type: action.type,
      ref: action.ref,
      text: action.type === "press" ? void 0 : action.text,
      checked: action.checked,
      direction: action.direction,
      key: action.type === "press" ? String(action.key) : void 0,
      tab_id: action.type === "switch_tab" ? action.tab_id : void 0,
      to_ref: action.type === "drag" ? action.to_ref : void 0,
      ms,
      file: action.type === "upload" ? coverLetter ? "cover_letter" : "resume" : void 0,
      label
    } };
  };
  const open = (obs, el) => grouped(el) ? !el.disabled && !el.submit_like && !chosenIn(obs, el) : empty(el);
  return { vet, open, skip, recordAnswer, noteWrite, missingRequired, emptyOptional, identity, isSkipped, uploadFile: (obs, el) => uploadFile(obs, el), formRoles: FORM_ROLES, botCheck: (el) => BOT_CHECK.test(`${el?.group ?? ""} ${el?.name ?? ""}`) };
}
export {
  createGuards,
  newGuardState,
  questionKey
};
