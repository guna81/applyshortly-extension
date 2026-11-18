// Tier 0 page simulator: an in-memory form that answers the planner like the guarded command layer would.
// It holds element snapshots (the shape `observeTab` produces), applies accepted actions to them and
// records every safety-relevant event (submit attempts, CAPTCHA touches, overwrites). No browser, no AI.
import { scanFields, isChoiceOption, choiceGroup } from "../../src/page-control/commands.js";

const SIM_KEYS = ["if", "goto", "captcha", "submit"];
const clone = (value) => structuredClone(value);

/**
 * @typedef {object} SimSpec
 * @property {string} [url]
 * @property {Array<{elements: any[], blockers?: string[], text?: string, dialog?: any}>} pages  a click on an element with `goto: n` shows page n
 * @property {Array<{at_turn: number, ref: string, value?: string, checked?: boolean}>} [events]  the user edits a field by hand before the planner's turn n
 * Element extras: `if: {ref, value|checked}` shows the element only then; `captcha: true` marks a challenge widget;
 * `submit: true` marks a real Submit (a click on it is a submit attempt, recorded).
 */
export class PageSim {
  /** @param {SimSpec} spec */
  constructor(spec) {
    this.spec = spec;
    this.url = spec.url ?? "https://careers.example.test/apply";
    this.pages = clone(spec.pages);
    this.page = 0;
    this.turn = 0;
    this.observations = 0;
    this.writes = []; // {type, ref, label, text, checked, turn}
    this.submitAttempts = 0;
    this.captchaTouches = 0;
    this.overwrites = 0;
    this.guarded = 0; // writes the command layer refused because the user had edited the control
    this.clicks = [];
    this.pageViews = new Set([0]);
  }

  get elements() { return this.pages[this.page].elements; }

  visible(el) {
    if (!el.if) return true;
    const gate = this.elements.find((e) => e.ref === el.if.ref);
    if (!gate) return false;
    if ("checked" in el.if) return Boolean(gate.checked) === el.if.checked;
    return String(gate.value ?? "").toLowerCase() === String(el.if.value).toLowerCase() || (gate.pressed === true && gate.name === el.if.value);
  }

  /** The next observation the planner sees. */
  observation() {
    this.observations += 1;
    const page = this.pages[this.page];
    const elements = this.elements.filter((el) => this.visible(el)).map((el) => {
      const out = clone(el);
      for (const key of SIM_KEYS) delete out[key];
      return out;
    });
    return {
      observation_id: `obs-${this.observations}`, document_id: `doc-${this.page}`, url: this.url,
      title: "Apply", dialog: page.dialog ?? null, blockers: page.blockers ?? [], errors: [], coverage: [], more_below: false,
      text: page.text ?? "Apply for this job", elements, tabs: [],
    };
  }

  /** Scripted user edits that happen before turn `n` (a person typing into the page while the agent works). */
  tick() {
    this.turn += 1;
    for (const event of this.spec.events ?? []) {
      if (event.at_turn !== this.turn) continue;
      const el = this.elements.find((e) => e.ref === event.ref);
      if (!el) continue;
      if (event.value !== undefined) el.value = event.value;
      if (event.checked !== undefined) el.checked = event.checked;
      el.user_edited = true;
    }
  }

  find(ref) { return this.elements.find((e) => e.ref === ref && this.visible(e)); }

  /** Apply the planner's accepted actions in order and return the `results` the next request carries. */
  apply(actions) {
    const results = [];
    for (const [index, action] of actions.entries()) {
      const base = { index, command_id: action.command_id };
      const el = action.ref ? this.find(action.ref) : null;
      const label = el ? String(el.group || el.name || "") : "";
      if (["type", "select", "check", "upload", "click", "press", "hover"].includes(action.type) && action.ref && !el) {
        results.push({ ...base, ok: false, detail: "That element is not on the page." });
        break;
      }
      if (el?.captcha) this.captchaTouches += 1;
      // The command layer refuses to write into a control the user edited since the observation (CommandRunner.guard).
      if (el?.user_edited && ["type", "select", "check", "upload"].includes(action.type)) {
        this.guarded += 1;
        results.push({ ...base, ok: false, detail: "The field was edited by you; fresh observation required." });
        break;
      }
      if (action.type === "type" || action.type === "select") {
        if (String(el.value ?? "").trim() && String(el.value) !== action.text) this.overwrites += 1;
        if (el.options?.length && action.type === "select" && !el.options.some((o) => String(o).toLowerCase() === String(action.text).toLowerCase())) {
          results.push({ ...base, ok: true, result: { type: action.type, verified: false, committed: "" } });
          continue;
        }
        // A browser's number box drops text that is not a number: it reads back empty and the write did not stick.
        if (action.type === "type" && el.input_type === "number" && !Number.isFinite(Number(String(action.text).trim()))) {
          results.push({ ...base, ok: true, result: { type: "type", verified: false, committed: "" } });
          continue;
        }
        el.value = action.text;
        this.writes.push({ type: action.type, ref: action.ref, label, text: action.text, turn: this.turn });
        results.push({ ...base, ok: true, result: { type: action.type, verified: true, committed: action.text, value_after: action.text } });
      } else if (action.type === "check") {
        if (isChoiceOption(el) && el.group) {
          if (choiceGroup(this.elements, el).some((m) => m.ref !== el.ref && (m.checked ?? m.pressed ?? m.selected) === true)) this.overwrites += 1;
          for (const member of choiceGroup(this.elements, el)) for (const key of ["checked", "pressed", "selected"]) if (key in member) member[key] = member.ref === el.ref;
        } else {
          if (Boolean(el.checked) && action.checked === false) this.overwrites += 1;
          el.checked = action.checked;
        }
        this.writes.push({ type: "check", ref: action.ref, label, option: el.name, checked: action.checked, turn: this.turn });
        results.push({ ...base, ok: true, result: { type: "check", verified: true, checked: action.checked } });
      } else if (action.type === "upload") {
        el.value = "resume.pdf";
        this.writes.push({ type: "upload", ref: action.ref, label, text: "resume.pdf", turn: this.turn });
        results.push({ ...base, ok: true, result: { type: "upload", verified: true } });
      } else if (action.type === "click") {
        this.clicks.push(el.name);
        if (el.submit || el.submit_like) this.submitAttempts += 1;
        if (typeof el.goto === "number") { this.page = el.goto; this.pageViews.add(el.goto); }
        results.push({ ...base, ok: true, result: { type: "click", verified: true } });
      } else if (action.type === "review") {
        const { missing } = scanFields(this.observationQuiet());
        results.push({ ...base, ok: true, result: { type: "review", missing_required: missing.map((m) => m.name), needs_confirmation: [], errors: [] } });
      } else {
        results.push({ ...base, ok: true, result: { type: action.type } });
      }
    }
    return results;
  }

  /** An observation that does not advance the observation counter (for the final scoring). */
  observationQuiet() {
    const saved = this.observations;
    const obs = this.observation();
    this.observations = saved;
    return obs;
  }
}
