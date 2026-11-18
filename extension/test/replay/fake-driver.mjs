// A scripted driver (no browser) for loop-level replay: the same shape agent-loop.test.mjs uses.
import { Agent } from "../../src/page-control/loop.js";
import { PAGE } from "../page-rules.mjs";

export const TOP = { frameId: "top", isTop: true, parentId: null };
export const FRAME = { frameId: "child", isTop: false, parentId: "top", sessionId: "oopif" };

export function frameObs(elements, extra = {}) {
  return { document_id: extra.url ?? "doc", url: "https://careers.example.com/apply", title: "Apply", dialog: null, blockers: [], errors: [], text: "", elements, more_below: false, ...extra };
}

// Scripted server responses obey the same command identity contract as the real server.
export class ScriptedAgent extends Agent {
  constructor(options) {
    super({ ...options, step: async (request) => {
      const response = await options.step(request);
      if (!response) return response;
      return { guarded_commands: true, ...response, actions: (response.actions ?? []).map((action, index) => ({
        command_id: `${request.request_id}:${index}`, observation_id: request.observation.observation_id, ...action,
      })) };
    } });
  }
  waitForUser() { return this.status === "ready" ? Promise.resolve({ kind: "stop" }) : super.waitForUser(); }
}

export class FakeDriver {
  constructor({ top, child = null, refuse = new Set() }) {
    this.pages = { top, child };
    this.refuse = refuse;
    this.calls = [];
  }
  async attach() { this.calls.push(["attach"]); }
  async detach() { this.calls.push(["detach"]); }
  async frames() { return this.pages.child ? [TOP, FRAME] : [TOP]; }
  async offset(frame) { return frame.isTop ? { x: 0, y: 0 } : { x: 100, y: 200 }; }
  async inDialog() { return this.frameInDialog ?? false; }
  async click(x, y) { this.calls.push(["click", x, y]); }
  async insertText(text) { this.calls.push(["insertText", text]); }
  async press(key) { this.calls.push(["press", key]); }
  async screenshot() { return "SHOT"; }
  async call(frame, name, ...args) {
    switch (name) {
      case "freshState": return { document_id: "doc", user_edited: false, value: "" };
      case "executionState": case "snapshotState": return;
      case "hitTest": return true;
      case "observe": return frame.isTop ? this.pages.top() : this.pages.child?.();
      case "settle": return "complete";
      case "clickable": return this.refuse.has(args[0]) ? "Submitting is left to you." : null;
      case "box": return { x: 10, y: 20, width: 40, height: 20 };
      case "focusForTyping": return { ok: true, mode: "keys" };
      case "blur": return true;
      case "selectNative": return { native: false };
      case "noteShown": return true;
      case "phoneTypePlan": return this.phonePlans?.shift() ?? null;
      case "committedValue": return this.committed ?? "Bengaluru, India";
      case "holdsTyped": return PAGE.holdsTyped(...args);
      case "showsChoice": return PAGE.showsChoice(...args);
      // The page's key-commit decisions, over this fake's simulated typedText/committedValue.
      case "keyCommitStart": {
        if (!PAGE.showsChoice(await this.call(frame, "typedText", args[0]).catch(() => ""), args[1])) return { ok: false, before: "" };
        const first = await this.call(frame, "firstOptionMatches", args[0], args[1]).catch(() => null);
        if (first?.known && !first.matches) return { ok: false, before: "" };
        return { ok: true, before: (await this.call(frame, "committedValue", args[0], true).catch(() => "")) ?? "" };
      }
      case "keyCommitCheck": {
        const committed = (await this.call(frame, "committedValue", args[0], true)) ?? "";
        const shown = committed.toLowerCase().trim();
        const was = String(args[2] ?? "").toLowerCase().trim();
        return { committed, verified: PAGE.showsChoice(committed, args[1]), wrong: Boolean(shown) && shown !== was, undone: !shown || shown === was };
      }
      case "typedSuggestion": return this.suggestion ?? { ok: false };
      case "matchOption": return { ok: true, ref: "opt", text: "Bengaluru, India" };
      case "attach": this.calls.push(["attach-file", args[0], args[2]]); return { ok: true, value: args[2] };
      case "state": return { checked: false };
      case "shownChoices": return this.shown ?? [];
      case "pickerOpen": return this.pickerOpen ?? true;
      case "hasText": return (this.texts ?? []).includes(args[0]);
      default: throw new Error(`unexpected ${name}`);
    }
  }
}

