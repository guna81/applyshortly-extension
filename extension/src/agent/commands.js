// The verified command layer shared by every controller: the platform's AI driver (loop.js) and a
// host assistant over the relay (external-browser.js). A controller decides what to do; this runs it
// against the page, checks the page is still what was observed, and reports what the page shows after.
import { observeTab, execute, questionChoices } from "./loop.js";

export const MUTATING = ["type", "select", "check", "click", "scroll", "upload"];
export const FIELD_KINDS = ["type", "select", "check"];
export const FILL_LIMIT = 25;

/**
 * @typedef {object} CommandPolicy
 * @property {boolean} [blockers] refuse to change a page that shows a blocker (CAPTCHA, sign-in)
 * @property {(href: string, origin: string) => boolean} [allowHref] called for a link to an origin this run has not
 *   trusted; true lets the click through, false refuses it (the controller asks the user)
 * @property {(name: string, committed: string) => void} [onCommitted] what a field shows after a write
 * @property {(text: string, state?: string) => any} [note] progress line; may return an entry whose
 *   `state` / `text` are updated as the step finishes
 * @property {() => boolean} [isPaused] the user is editing the form by hand
 * @property {(kind: string) => Promise<any>} [files] resolves the file for an upload
 * @property {(frames: any[], run: () => Promise<any>) => Promise<any>} [around] wraps a page action
 */

export class CommandRunner {
  /** @param {{ driver?: any, policy?: CommandPolicy }} [options] */
  constructor({ driver = null, policy = {} } = {}) {
    this.driver = driver;
    this.policy = policy;
    /** The page as last read: { observation, refs, frames, alias? }. */
    this.observed = null;
    this.lastReturned = null;
    this.lastObservationId = null;
  }

  /** Forget the page (the tab changed or was let go). Held refs are no longer valid. */
  reset() { this.observed = null; }

  /** Read the page again and keep it as the one commands act on. */
  async observe() {
    this.observed = await observeTab(this.driver, { extended: true });
    return this.observed;
  }

  /** The caller's observation counts if it is the latest one, or the one this page was last read as. */
  current(id) {
    const o = this.observed;
    return Boolean(o) && (id === o.observation.observation_id || (o.alias != null && id === o.alias));
  }

  /** Search-style comboboxes (react-select) are reported as textboxes with popup: true; options can still be read. */
  comboView() {
    const { observation } = this.observed;
    return { ...observation, elements: observation.elements.map((e) => (e.popup && e.role === "textbox" ? { ...e, role: "combobox" } : e)) };
  }

  /**
   * Everything that must still hold before a command touches the page: this observation is current,
   * no blocker, same document, the control was not edited by the user or replaced, not a password,
   * and a link does not leave the trusted origins unasked.
   */
  async guard(action) {
    const o = this.observed;
    if (!this.current(action.observation_id)) throw new Error("Observe again before changing the page.");
    if (this.policy.blockers !== false && o.observation.blockers.length) throw new Error("Resolve the page blocker first.");
    const target = o.refs.get(action.ref);
    const top = o.frames.find((frame) => frame.isTop);
    const currentDocument = await this.driver.call(top, "freshState", "");
    if (currentDocument.document_id !== o.observation.document_id) throw new Error("Document changed. Observe again.");
    if (target) {
      let current = await this.driver.call(target.frame, "freshState", target.local);
      // The site re-rendered this control (new DOM node): find it again by role and name.
      if (current.present === false && target.name && await this.driver.call(target.frame, "rebind", target.local, target.name, target.role)) {
        current = await this.driver.call(target.frame, "freshState", target.local);
      }
      let changed = current.value !== target.value;
      if (target.role === "checkbox") {
        const state = await this.driver.call(target.frame, "state", target.local);
        const previous = o.observation.elements.find((element) => element.ref === action.ref);
        changed = state?.checked !== previous?.checked;
      }
      if (current.document_id !== target.documentId || (current.user_edited && changed)) throw new Error("The page or field changed. Observe again.");
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
    // command_id enables the final-submit and safe-key guards inside execute().
    const outcome = await (this.policy.around ?? ((_frames, run) => run()))(frames, () => execute(this.driver, this.observed.refs, frames,
      { type: action.type, ref: action.ref, text: action.text, checked: action.checked === true || action.checked === "true",
        direction: action.direction, file: "resume", command_id: commandId },
      async (kind) => (this.policy.files ? this.policy.files(kind) : null)));
    if (FIELD_KINDS.includes(action.type)) {
      // Record what the widget actually shows, not what was asked for.
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
    // What each ref the caller holds stood for. A site that re-renders after an input gives every
    // control a new ref in the next observation: later fields are found again by identity.
    const identity = new Map(this.observed.observation.elements.map((e) => [e.ref, { name: e.name, role: e.role, section: e.section ?? "" }]));
    const resolve = (ref) => {
      const want = identity.get(ref);
      const elements = this.observed.observation.elements;
      const here = elements.find((e) => e.ref === ref);
      if (!want || (here && here.name === want.name && here.role === want.role && (here.section ?? "") === want.section)) return ref;
      const same = elements.filter((e) => e.name === want.name && e.role === want.role && (e.section ?? "") === want.section);
      return same.length === 1 ? same[0].ref : ref;
    };
    for (const [index, field] of fields.entries()) {
      if (this.policy.isPaused?.()) { results.push({ ref: field.ref, ok: false, detail: "Paused by the user, who is editing the form." }); break; }
      if (typeof field.ref !== "string") throw new Error("Each field needs a ref.");
      if (!this.observed) await this.observe();
      let resolved = resolve(field.ref);
      let element = this.observed.observation.elements.find((e) => e.ref === resolved);
      // A dropdown is chosen from, a checkbox is set, anything else is typed into. Typing into a
      // dropdown only fills its search box and picks nothing, so the kind comes from the control.
      // The platform sends `checked: null` on a text entry: only a real boolean makes it a checkbox.
      const type = field.type ?? (typeof field.checked === "boolean" || field.checked === "true" || field.checked === "false" || element?.role === "checkbox" ? "check"
        : element && (element.popup || element.role === "combobox" || element.role === "select") ? "select" : "type");
      if (!FIELD_KINDS.includes(type)) throw new Error("Each field needs a type of type, select or check.");
      const verb = type === "select" ? "Choosing an option in" : type === "check" ? "Setting checkbox" : "Typing into";
      const step = note(`${verb} ${element?.name ? `“${String(element.name).slice(0, 50)}”` : "a field"} (${index + 1} of ${fields.length})`, "running") ?? {};
      const attempt = () => this.mutate({ type, ref: resolved, text: field.text == null ? undefined : String(field.text), checked: String(field.checked ?? ""),
        observation_id: this.observed.observation.observation_id }, `${commandId}:${index}`, true);
      try {
        let done;
        try { done = await attempt(); }
        catch (error) {
          // An earlier field changed this one (a country clears its city, say): read the page again once.
          if (!/Observe again|changed/.test(String(error.message))) throw error;
          await this.observe();
          resolved = resolve(field.ref);
          element = this.observed.observation.elements.find((e) => e.ref === resolved);
          // Reading the page again made the user's own edit look like the starting value: never write over it.
          if (element?.user_edited) throw new Error("The user edited this field, so it was left as they wrote it.");
          done = await attempt();
        }
        // Only a read-back that shows the value counts. A write that reports nothing proved nothing,
        // so it is not a success: the one exception is clearing a field, which has no text to read back.
        const clearing = type === "type" && !String(field.text ?? "").trim();
        const stuck = done?.verified === true || (done?.verified === undefined && clearing);
        step.state = stuck ? "done" : "error";
        if (!stuck && step.text) step.text = `${step.text}: didn't stick`;
        const { committed, ...rest } = done ?? {};
        const unread = done?.verified === undefined;
        results.push({ ...rest, ref: field.ref, ok: stuck, ...(committed != null ? { committed: String(committed).slice(0, 80) } : {}),
          ...(!stuck && unread ? { detail: type === "select" ? "The page did not show the choice. Read the options and choose one verbatim."
            : "The page did not report what this field shows, so the write is not confirmed. Observe again and check it." } : {}) });
        if (!stuck) break;
      } catch (error) {
        step.state = "error"; if (step.text) step.text = `${step.text}: ${String(error.message).slice(0, 60)}`;
        results.push({ ref: field.ref, ok: false, detail: String(error.message).slice(0, 200) });
        break;
      }
    }
    this.observed = null; // the reply reads the whole page once, after every field
    return { type: "fill_form", fields: results, done: results.filter((r) => r.ok).length, requested_count: fields.length };
  }

  /** The choices a dropdown offers, read by opening it (retried once: the first open often races). */
  async options(action) {
    if (!this.observed) await this.observe();
    if (this.observed.observation.blockers.length) throw new Error("Resolve the page blocker first.");
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
    if (this.observed.observation.blockers.length) throw new Error("Resolve the page blocker first.");
    const o = this.observed;
    const roles = new Set(["textbox", "textarea", "combobox", "select", "checkbox", "radio", "file"]);
    const all = o.observation.elements.filter((e) => roles.has(e.role) && !e.disabled);
    const groups = new Map();
    for (const e of all) if ((e.role === "radio" || e.role === "checkbox") && e.group) {
      groups.set(`${e.role}:${e.group}`, [...(groups.get(`${e.role}:${e.group}`) ?? []), e]);
    }
    const answered = (e) => {
      if (e.role === "radio" || e.role === "checkbox") {
        const group = e.group ? groups.get(`${e.role}:${e.group}`) : [e];
        return group.some((member) => member.checked);
      }
      return String(e.value ?? "").trim() !== "";
    };
    const seenGroups = new Set();
    const fields = [];
    const missing = [];
    for (const e of all) {
      if (e.group && (e.role === "radio" || e.role === "checkbox")) {
        const key = `${e.role}:${e.group}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const chosen = groups.get(key).filter((m) => m.checked).map((m) => m.name);
        fields.push({ ref: e.ref, name: e.group, role: e.role, value: chosen.join(", "), required: Boolean(e.required) });
      } else {
        const shown = e.role === "checkbox" ? String(Boolean(e.checked)) : String(e.value ?? "").slice(0, 120);
        fields.push({ ref: e.ref, name: e.name, role: e.role, value: e.input_type === "password" ? "" : shown, required: Boolean(e.required),
          ...(e.invalid || e.error ? { error: String(e.error ?? "invalid").slice(0, 120) } : {}) });
      }
      if (e.required && !answered(e)) missing.push({ ref: e.ref, name: e.group || e.name, role: e.role });
    }
    const needsConfirmation = [];
    const popupRefs = new Set(o.observation.elements.filter((e) => e.popup).map((e) => e.ref));
    for (const item of missing.filter((m) => m.role === "combobox" || m.role === "select" || popupRefs.has(m.ref)).slice(0, 8)) {
      const choices = await questionChoices(this.driver, o.refs, o.frames, this.comboView(), { ref: item.ref }).catch(() => []);
      if (choices.length === 1) needsConfirmation.push({ ref: item.ref, name: item.name, only_option: choices[0] });
    }
    return { type: "review", field_count: fields.length, fields: fields.slice(0, 120), missing_required: missing,
      needs_confirmation: needsConfirmation, errors: o.observation.errors.slice(0, 10),
      note: needsConfirmation.length ? "needs_confirmation: the only option states something the user must confirm. Ask them; do not select it yourself." : undefined };
  }

  /** A read-only command (options, review) or a batch (fill_form) from a controller's decision. */
  async compound(type, args, { observationId = undefined, commandId = "" } = {}) {
    if (type === "fill_form") {
      let fields;
      try { fields = typeof args.fields === "string" ? JSON.parse(args.fields || "[]") : args.fields; } catch { throw new Error("fields must be a JSON list."); }
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
      // Only what changed since the last observation returned: refs stay valid for the whole page.
      const elements = full.elements.filter((e) => this.lastReturned.map.get(e.ref) !== seenNow.get(e.ref));
      const removed = [...this.lastReturned.map.keys()].filter((ref) => !seenNow.has(ref));
      // The page text is large and the caller already has it: a delta reply leaves it empty.
      result = { ...full, text: "", elements, delta: true, unchanged_count: full.elements.length - elements.length, removed };
    }
    this.lastReturned = { url: full.url, map: seenNow };
    this.lastObservationId = full.observation_id;
    return lastAction ? { ...result, last_action: lastAction } : result;
  }
}
