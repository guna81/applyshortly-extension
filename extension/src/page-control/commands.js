import { observeTab, execute, questionChoices, comboView } from "./loop.js";
const MUTATING = ["type", "select", "check", "click", "scroll", "upload"];
const FIELD_KINDS = ["type", "select", "check"];
const FILL_LIMIT = 25;
const CHOICE_ROLES = ["button", "switch", "menuitemcheckbox", "menuitemradio"];
const choiceState = (el) => el?.checked ?? el?.pressed ?? el?.selected ?? null;
const isChoiceOption = (el) => Boolean(el) && (el.role === "radio" || CHOICE_ROLES.includes(el.role) && Boolean(el.group) && choiceState(el) != null);
const choiceGroup = (elements, el) => elements.filter((m) => !m.disabled && isChoiceOption(m) && (el.group ? m.group === el.group : m.ref === el.ref));
const matchChoice = (group, said) => {
  const want = String(said ?? "").trim().toLowerCase();
  if (!want) return void 0;
  const name = (m) => String(m.name ?? "").trim().toLowerCase();
  const plain = (text) => text.replace(/[^\p{L}\p{N}+]+/gu, " ").trim();
  const wantPlain = plain(want);
  return group.find((m) => name(m) === want) ?? group.find((m) => name(m).startsWith(want)) ?? (wantPlain ? group.find((m) => plain(name(m)) === wantPlain) ?? group.find((m) => `${plain(name(m))} `.startsWith(`${wantPlain} `)) : void 0);
};
const optionsOf = (elements, el) => el.group ? elements.filter((m) => !m.disabled && m.group === el.group && (isChoiceOption(m) || m.role === "checkbox")) : choiceGroup(elements, el);
const namesOption = (options, said, el) => String(said ?? "").split(/,|;|\band\b|\bor\b/i).some((part) => matchChoice(options, part)?.ref === el.ref) || matchChoice(options, said)?.ref === el.ref;
const squash = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}+]+/gu, " ").trim();
const alike = (a, b) => {
  const x = squash(a), y = squash(b);
  return Boolean(x) && Boolean(y) && (x === y || x.includes(y) || y.includes(x));
};
function driftOf(result, field, el, elements) {
  if (result.type === "check") {
    const want = field.checked === true || field.checked === "true";
    return Boolean(el.checked) !== want ? `it is now ${el.checked ? "checked" : "unchecked"}` : "";
  }
  const shown = String(el.value ?? "");
  const plain = !el.popup && el.role !== "combobox" && el.role !== "select";
  const was = result.committed != null && result.committed !== "" ? result.committed : result.requested;
  if (shown && was && !alike(shown, was)) return `it now shows "${shown.slice(0, 60)}"`;
  if (!shown && plain && was) return "it is now empty";
  const wanted = String(field.text ?? "").trim();
  if (el.input_type === "tel" && /^\+\d/.test(wanted) && el.section) {
    const country = elements.find((e) => e !== el && e.section === el.section && /country/i.test(e.name ?? ""));
    const code = /\+(\d{1,4})/.exec(String(country?.value ?? ""))?.[1];
    if (code && !wanted.replace(/\D/g, "").startsWith(code)) return `the country shows +${code}, not the number's code`;
  }
  return "";
}
const FORM_ROLES = /* @__PURE__ */ new Set(["textbox", "textarea", "combobox", "select", "checkbox", "radio", "file", "switch", "slider", "spinbutton"]);
const groupKind = (e) => e.role === "radio" || e.role === "checkbox" ? e.role : isChoiceOption(e) ? "choice" : null;
function scanFields(observation) {
  const all = observation.elements.filter((e) => (FORM_ROLES.has(e.role) || isChoiceOption(e)) && !e.disabled);
  const groups = /* @__PURE__ */ new Map();
  for (const e of all) if (groupKind(e) && e.group) {
    groups.set(`${groupKind(e)}:${e.group}`, [...groups.get(`${groupKind(e)}:${e.group}`) ?? [], e]);
  }
  const chosen = (m) => choiceState(m) === true;
  const answered = (e) => {
    if (groupKind(e)) {
      const group = e.group ? groups.get(`${groupKind(e)}:${e.group}`) : [e];
      return group.some(chosen);
    }
    if (e.role === "switch") return chosen(e);
    return String(e.value ?? "").trim() !== "";
  };
  const seenGroups = /* @__PURE__ */ new Set();
  const fields = [];
  const missing = [];
  for (const e of all) {
    const kind = groupKind(e);
    if (e.group && kind) {
      const key = `${kind}:${e.group}`;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      const picked = groups.get(key).filter(chosen).map((m) => m.name);
      fields.push({ ref: e.ref, name: e.group, role: kind === "choice" ? "radio" : e.role, value: picked.join(", "), required: Boolean(e.required) });
    } else {
      const shown = e.role === "checkbox" || e.role === "switch" ? String(chosen(e)) : String(e.value ?? "").slice(0, 120);
      fields.push({
        ref: e.ref,
        name: e.name,
        role: e.role,
        value: e.input_type === "password" ? "" : shown,
        required: Boolean(e.required),
        ...e.invalid || e.error ? { error: String(e.error ?? "invalid").slice(0, 120) } : {}
      });
    }
    if (e.required && !answered(e)) missing.push({ ref: e.ref, name: e.group || e.name, role: kind === "choice" ? "radio" : e.role });
  }
  return { fields, missing };
}
const READINESS_NAMES = 30;
function readinessOf(observation, refs) {
  const { fields, missing } = scanFields(observation);
  const inFrame = (ref) => refs.get(ref)?.frame?.isTop === false;
  return {
    total: fields.length,
    framed: fields.filter((f) => inFrame(f.ref)).length,
    missing: missing.slice(0, READINESS_NAMES).map((m) => ({ name: String(m.name ?? "").slice(0, 80), role: m.role, framed: inFrame(m.ref) }))
  };
}
class CommandRunner {
  driver;
  policy;
  observed;
  lastReturned;
  lastObservationId;
  /** @param {{ driver?: any, policy?: CommandPolicy }} [options] */
  constructor({ driver = null, policy = {} } = {}) {
    this.driver = driver;
    this.policy = policy;
    this.observed = null;
    this.lastReturned = null;
    this.lastObservationId = null;
  }
  /** Forget the page (the tab changed or was let go). Held refs are no longer valid. */
  reset() {
    this.observed = null;
  }
  /** Read the page again and keep it as the one commands act on. */
  async observe() {
    this.observed = await observeTab(this.driver, { extended: true });
    return this.observed;
  }
  /** The caller's observation counts if it is the latest one, or the one this page was last read as. */
  current(id) {
    const o = this.observed;
    return Boolean(o) && (id === o.observation.observation_id || o.alias != null && id === o.alias);
  }
  /** Search-style comboboxes (react-select) are reported as textboxes with popup: true; options can still be read. */
  comboView() {
    return comboView(this.observed.observation);
  }
  /** The blockers that stop a write on this page. A CAPTCHA only counts when the controller did not allow filling around it. */
  blocking(observation) {
    if (this.policy.blockers === false) return [];
    return observation.blockers.filter((b) => !(b === "captcha" && this.policy.captchaFillable));
  }
  /**
   * Everything that must still hold before a command touches the page: this observation is current,
   * no blocker, same document, the control was not edited by the user or replaced, not a password,
   * and a link does not leave the trusted origins unasked.
   */
  async guard(action) {
    const o = this.observed;
    if (!this.current(action.observation_id)) throw new Error("Observe again before changing the page.");
    if (this.blocking(o.observation).length) throw new Error("Resolve the page blocker first.");
    const target = o.refs.get(action.ref);
    const top = o.frames.find((frame) => frame.isTop);
    const currentDocument = await this.driver.call(top, "freshState", "");
    if (currentDocument.document_id !== o.observation.document_id) throw new Error("Document changed. Observe again.");
    if (target) {
      let current = await this.driver.call(target.frame, "freshState", target.local);
      if (current.present === false && target.name && await this.driver.call(target.frame, "rebind", target.local, target.name, target.role)) {
        current = await this.driver.call(target.frame, "freshState", target.local);
      }
      let changed = current.value !== target.value;
      if (target.role === "checkbox") {
        const state = await this.driver.call(target.frame, "state", target.local);
        const previous = o.observation.elements.find((element) => element.ref === action.ref);
        changed = state?.checked !== previous?.checked;
      }
      if (current.document_id !== target.documentId || current.user_edited && changed) throw new Error("The page or field changed. Observe again.");
    }
    if (target?.inputType === "password") throw new Error("Password fields require user input.");
    if (target?.href && this.policy.allowHref) {
      const origin = new URL(target.href, o.observation.url).origin;
      if (!this.policy.allowHref(target.href, origin)) throw new Error("Approve the new application domain in the extension.");
    }
    return target;
  }
  /** What a write reports: the request, what was matched, and what the widget shows afterwards. */
  static shape(action, outcome) {
    return outcome && typeof outcome === "object" ? { ref: action.ref, type: action.type, requested: action.text, ...outcome } : null;
  }
  /** Run one guarded page action. `keep` leaves the observation in place for the next field of a batch. */
  async mutate(action, commandId, keep = false) {
    const target = await this.guard(action);
    if (!MUTATING.includes(action.type)) throw new Error("Unsupported action.");
    const frames = this.observed.frames;
    const outcome = await (this.policy.around ?? ((_frames, run) => run()))(frames, () => execute(
      this.driver,
      this.observed.refs,
      frames,
      {
        type: action.type,
        ref: action.ref,
        text: action.text,
        checked: action.checked === true || action.checked === "true",
        direction: action.direction,
        file: "resume",
        command_id: commandId
      },
      async (kind) => this.policy.files ? this.policy.files(kind) : null
    ));
    if (FIELD_KINDS.includes(action.type)) {
      this.policy.onCommitted?.(`${target?.name || action.ref}`, outcome?.committed || (action.text ?? String(action.checked)));
    }
    if (!keep) this.observed = null;
    return CommandRunner.shape(action, outcome);
  }
  /**
   * Several type/select/check writes in one call. Stops at the first one that fails or does not
   * stick, and reports each with what the page shows. `fields` is a list of `{ref, text}` or
   * `{ref, checked}` (an explicit `type` overrides the kind inferred from the control).
   */
  async fillForm(fields, { observationId, commandId }) {
    if (!Array.isArray(fields) || !fields.length || fields.length > FILL_LIMIT) throw new Error(`Give 1 to ${FILL_LIMIT} fields.`);
    if (!this.current(observationId)) throw new Error("Observe again before changing the page.");
    const note = this.policy.note ?? (() => ({}));
    const results = [];
    const identity = new Map(this.observed.observation.elements.map((e) => [e.ref, { name: e.name, role: e.role, section: e.section ?? "" }]));
    const resolve = (ref) => {
      const want = identity.get(ref);
      const elements = this.observed.observation.elements;
      const here = elements.find((e) => e.ref === ref);
      if (!want || here && here.name === want.name && here.role === want.role && (here.section ?? "") === want.section) return ref;
      const same = elements.filter((e) => e.name === want.name && e.role === want.role && (e.section ?? "") === want.section);
      return same.length === 1 ? same[0].ref : ref;
    };
    for (const [index, entry] of fields.entries()) {
      let field = entry;
      if (this.policy.isPaused?.()) {
        results.push({ ref: field.ref, ok: false, detail: "Paused by the user, who is editing the form." });
        break;
      }
      if (typeof field.ref !== "string") throw new Error("Each field needs a ref.");
      if (!this.observed) await this.observe();
      let resolved = resolve(field.ref);
      let element = this.observed.observation.elements.find((e) => e.ref === resolved);
      if (isChoiceOption(element) && field.checked == null && field.text != null) {
        const match = matchChoice(choiceGroup(this.observed.observation.elements, element), field.text);
        if (match) {
          resolved = match.ref;
          element = match;
          field = { ...field, ref: match.ref, checked: true, type: "check", text: void 0 };
        }
      }
      const type = field.type ?? (typeof field.checked === "boolean" || field.checked === "true" || field.checked === "false" || element?.role === "checkbox" ? "check" : element && (element.popup || element.role === "combobox" || element.role === "select") ? "select" : "type");
      if (!FIELD_KINDS.includes(type)) throw new Error("Each field needs a type of type, select or check.");
      const verb = type === "select" ? "Choosing an option in" : type === "check" ? "Setting checkbox" : "Typing into";
      const step = note(`${verb} ${element?.name ? `\u201C${String(element.name).slice(0, 50)}\u201D` : "a field"} (${index + 1} of ${fields.length})`, "running") ?? {};
      const attempt = () => this.mutate({
        type,
        ref: resolved,
        text: field.text == null ? void 0 : String(field.text),
        checked: String(field.checked ?? ""),
        observation_id: this.observed.observation.observation_id
      }, `${commandId}:${index}`, true);
      try {
        let done;
        try {
          done = await attempt();
        } catch (error) {
          if (!/Observe again|changed/.test(String(error?.message))) throw error;
          await this.observe();
          resolved = resolve(field.ref);
          element = this.observed.observation.elements.find((e) => e.ref === resolved);
          if (element?.user_edited) throw new Error("The user edited this field, so it was left as they wrote it.");
          done = await attempt();
        }
        const clearing = type === "type" && !String(field.text ?? "").trim();
        const stuck = done?.verified === true || done?.verified === void 0 && clearing;
        step.state = stuck ? "done" : "error";
        if (!stuck && step.text) step.text = `${step.text}: didn't stick`;
        const { committed, ...rest } = done ?? {};
        const unread = done?.verified === void 0;
        results.push({
          ...rest,
          ref: field.ref,
          ok: stuck,
          ...committed != null ? { committed: String(committed).slice(0, 80) } : {},
          ...!stuck && unread ? { detail: type === "select" ? "The page did not show the choice. Read the options and choose one verbatim." : "The page did not report what this field shows, so the write is not confirmed. Observe again and check it." } : {}
        });
        if (!stuck) break;
      } catch (error) {
        step.state = "error";
        if (step.text) step.text = `${step.text}: ${String(error?.message).slice(0, 60)}`;
        results.push({ ref: field.ref, ok: false, detail: String(error?.message).slice(0, 200) });
        break;
      }
    }
    if (results.length > 1 && results.some((r) => r.ok)) await this.recheck(results, fields, resolve, commandId).catch(() => {
    });
    this.observed = null;
    return { type: "fill_form", fields: results, done: results.filter((r) => r.ok).length, requested_count: fields.length };
  }
  /**
   * A later field can undo an earlier one: a phone box's country list moved to its first entry by the
   * next dropdown, say. Each write was verified when it was made, so read the page once more at the end.
   * A field that no longer shows what it did is written once more; one that still differs is reported
   * as not stuck, with what it shows, so no controller treats it as done.
   */
  async recheck(results, fields, resolve, commandId) {
    const drift = () => {
      const found = [];
      for (const [i, r] of results.entries()) {
        if (!r.ok) continue;
        const ref = resolve(r.ref);
        const el = this.observed.observation.elements.find((e) => e.ref === ref);
        if (!el) continue;
        const why = driftOf(r, fields[i], el, this.observed.observation.elements);
        if (why) found.push({ i, why });
      }
      return found;
    };
    await this.observe();
    let moved = drift();
    if (!moved.length) return;
    for (const { i } of moved) {
      if (this.policy.isPaused?.()) break;
      const r = results[i];
      const field = fields[i];
      try {
        await this.mutate({
          type: r.type,
          ref: resolve(r.ref),
          text: field.text == null ? void 0 : String(field.text),
          checked: String(field.checked ?? ""),
          observation_id: this.observed.observation.observation_id
        }, `${commandId}:fix${i}`, true);
      } catch {
      }
      await this.observe();
    }
    moved = drift();
    for (const { i, why } of moved) {
      results[i] = { ...results[i], ok: false, verified: false, detail: `A later field changed this one: ${why}. Write it again on its own.` };
    }
  }
  /** The choices a dropdown offers, read by opening it (retried once: the first open often races). */
  async options(action) {
    if (!this.observed) await this.observe();
    if (this.blocking(this.observed.observation).length) throw new Error("Resolve the page blocker first.");
    const o = this.observed;
    const element = this.comboView().elements.find((e) => e.ref === action.ref);
    if (!element) throw new Error("That element is no longer on the page.");
    let choices = await questionChoices(this.driver, o.refs, o.frames, this.comboView(), { ref: action.ref });
    if (!choices.length && element.role === "combobox") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      choices = await questionChoices(this.driver, o.refs, o.frames, this.comboView(), { ref: action.ref });
    }
    return { type: "options", ref: action.ref, name: element.name, count: choices.length, options: choices.slice(0, 100) };
  }
  /**
   * The form as a person would check it: every field with what it shows now, the required ones
   * still empty, and required dropdowns whose only option is a statement the person must make
   * (an acknowledgement, a "PDF submitted" claim). Those are never picked here.
   */
  async review() {
    if (!this.observed) await this.observe();
    if (this.blocking(this.observed.observation).length) throw new Error("Resolve the page blocker first.");
    const o = this.observed;
    const { fields, missing } = scanFields(o.observation);
    const needsConfirmation = [];
    const popupRefs = new Set(o.observation.elements.filter((e) => e.popup).map((e) => e.ref));
    for (const item of missing.filter((m) => m.role === "combobox" || m.role === "select" || popupRefs.has(m.ref)).slice(0, 8)) {
      const choices = await questionChoices(this.driver, o.refs, o.frames, this.comboView(), { ref: item.ref }).catch(() => []);
      if (choices.length === 1) needsConfirmation.push({ ref: item.ref, name: item.name, only_option: choices[0] });
    }
    const hasRemove = o.observation.elements.some((e) => e.role === "button" && /^(remove|delete|clear)\b.*\b(file|attachment|resume|cv|document)/i.test(e.name ?? ""));
    const attached = hasRemove ? [...new Set(String(o.observation.text ?? "").split(" | ").map((s) => s.trim()).filter((s) => s.length < 120 && /\.(pdf|docx?|txt|rtf|odt)$/i.test(s)))].slice(0, 5) : [];
    return {
      type: "review",
      field_count: fields.length,
      fields: fields.slice(0, 120),
      missing_required: missing,
      ...attached.length ? { attached_files: attached } : {},
      needs_confirmation: needsConfirmation,
      errors: o.observation.errors.slice(0, 10),
      note: needsConfirmation.length ? "needs_confirmation: the only option states something the user must confirm. Ask them; do not select it yourself." : void 0
    };
  }
  /** A read-only command (options, review) or a batch (fill_form) from a controller's decision. */
  async compound(type, args, { observationId = void 0, commandId = "" } = {}) {
    if (type === "fill_form") {
      let fields;
      try {
        fields = typeof args.fields === "string" ? JSON.parse(args.fields || "[]") : args.fields;
      } catch {
        throw new Error("fields must be a JSON list.");
      }
      return this.fillForm(fields, { observationId, commandId });
    }
    if (type === "options") return this.options(args);
    if (type === "review") return this.review();
    throw new Error("Unsupported command.");
  }
  /**
   * Read the page and answer with it. With `delta` only what changed since the last reply returns
   * (the full element set stays usable for refs). Passwords never leave the page.
   */
  async reply({ delta = false, lastAction = null } = {}) {
    const observed = await this.observe();
    for (const element of observed.observation.elements) {
      if (element.input_type === "password") delete element.value;
    }
    const full = observed.observation;
    const seenNow = new Map(full.elements.map((e) => [e.ref, JSON.stringify([e.name, e.value, e.checked, e.invalid, e.error, e.options?.length, e.required, e.disabled])]));
    let result = full;
    if (delta && this.lastReturned && this.lastReturned.url === full.url) {
      const elements = full.elements.filter((e) => this.lastReturned.map.get(e.ref) !== seenNow.get(e.ref));
      const removed = [...this.lastReturned.map.keys()].filter((ref) => !seenNow.has(ref));
      result = { ...full, text: "", elements, delta: true, unchanged_count: full.elements.length - elements.length, removed };
    }
    this.lastReturned = { url: full.url, map: seenNow };
    this.lastObservationId = full.observation_id;
    return lastAction ? { ...result, last_action: lastAction } : result;
  }
}
export {
  CommandRunner,
  FIELD_KINDS,
  FILL_LIMIT,
  MUTATING,
  choiceGroup,
  choiceState,
  driftOf,
  isChoiceOption,
  matchChoice,
  namesOption,
  optionsOf,
  readinessOf,
  scanFields
};
