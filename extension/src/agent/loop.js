// The form agent's loop in the background service worker: observe the tab, ask the platform
// (POST /api/extension/agent/step) what to do, act, let the page settle, repeat.
//
// The platform decides; this file only carries out vetted actions. It still refuses to click a
// final submit button (page.js clickable()), and it stops whenever the platform says
// ready_for_review: the user reviews the form and submits it themselves.

const MAX_OBSERVED = 400; // the API's limit on elements per observation
const TEXT_LIMIT = 12000;
const TYPEAHEAD_WAIT_MS = 700;
const KEY_TYPING_LIMIT = 200; // longer text is never a masked input; insertText stays
const DROPDOWN_WAIT_MS = 350;
const OPTION_SCROLL_WAIT_MS = 120;
const MAX_OPTION_PAGES = 80;
const ACTION_PAUSE_MS = 120;
const CAPTCHA_HANDOFF = "There's a CAPTCHA on this page. Please solve it yourself.";
const LOAD_WAIT_MS = 10_000;
const WAIT_FOR_POLL_MS = 250;
// A state seen this often among the recent ones is a loop (one state, or two alternating, as
// when a pop-up keeps closing and reopening): pause before spending more.
const REPEAT_LIMIT = 3;
const RECENT_STATES = 10;
const CALL_LIMIT = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ignore transient IDs and screenshot bytes when detecting stalled planning.
export class ProgressGuard {
  constructor() { this.reset(); }
  reset() { this.states = []; this.calls = 0; }
  check(observation) {
    const state = JSON.stringify({
      url: observation.url, dialog: observation.dialog, text: observation.text,
      errors: observation.errors, blockers: observation.blockers,
      elements: observation.elements.map((e) => [e.role, e.name, e.value, e.checked,
        e.disabled, e.expanded, e.bounds]),
    });
    this.states.push(state);
    this.states = this.states.slice(-RECENT_STATES);
    if (this.calls >= CALL_LIMIT) return `The agent reached its ${CALL_LIMIT}-call safety limit.`;
    if (this.states.filter((previous) => previous === state).length >= REPEAT_LIMIT) {
      return "The page keeps coming back to the same state without progress.";
    }
    this.calls += 1;
    return null;
  }
}

/** A platform from before the agent answers its route with FastAPI's bare 404. */
const unsupported = (error) => error?.status === 404 && error.message === "Not Found";

/** Platform errors in words the panel can show. */
export function explain(error) {
  if (unsupported(error)) {
    return "ApplyShortly doesn't have the form agent yet. Use the assistant chat for now; the agent works once ApplyShortly is updated.";
  }
  if (error?.status === 410) return "This agent session ended. Run the agent again.";
  if (error?.status === 401 || error?.status === 403) return "ApplyShortly didn't accept the API key. Sign in again from settings.";
  return error?.message || String(error);
}

/** Observe every frame and merge into one observation; refs become "frame.local". */
/** Presses Escape only when the field's own list is open: otherwise it closes the dialog. */
async function closePicker(driver, target) {
  const open = await driver.call(target.frame, "pickerOpen", target.local).catch(() => false);
  if (open) await driver.press("Escape").catch(() => {});
}

export async function observeTab(driver, { screenshot = false, annotate = false, extended = false, query = "" } = {}) {
  const frames = await driver.frames();
  const refs = new Map();
  const merged = { url: "", title: "", dialog: null, blockers: [], errors: [], text: "", elements: [], more_below: false };
  const parts = [];
  for (const [index, frame] of frames.entries()) {
    let obs;
    try { obs = await driver.call(frame, "observe", { isTop: frame.isTop, extended, query }); }
    catch { if (extended) (merged.coverage ??= []).push("A frame could not be inspected."); continue; } // a frame that navigated away or forbids scripting
    if (obs && extended && driver.accessible) {
      try {
        const ax = await driver.accessible(frame, obs.elements.map((e) => e.ref), query);
        obs.elements.push(...ax.elements);
        if (ax.incomplete) (obs.coverage ??= []).push("Accessibility snapshot incomplete.");
      } catch { (obs.coverage ??= []).push("Accessibility snapshot unavailable."); }
    }
    if (obs) parts.push({ index, frame, obs });
  }
  const top = parts.find((p) => p.frame.isTop);
  if (top) {
    Object.assign(merged, { url: top.obs.url, title: top.obs.title, dialog: top.obs.dialog, more_below: top.obs.more_below });
  }
  if (extended) {
    Object.assign(merged, { observation_id: crypto.randomUUID(), document_id: top?.obs.document_id,
      step_label: top?.obs.step_label, viewport_width: top?.obs.viewport_width || 0,
      viewport_height: top?.obs.viewport_height || 0 });
  }
  if (extended && driver.applicationTabs) merged.tabs = await driver.applicationTabs();
  const texts = [];
  for (const { index, frame, obs } of parts) {
    // With a modal open in the tab, the rest of the page is behind it; iframes inside it count.
    if (merged.dialog && !frame.isTop && !(await driver.inDialog(frame, frames).catch(() => false))) continue;
    if (extended) (merged.coverage ??= []).push(...(obs.coverage ?? []));
    for (const b of obs.blockers) if (!merged.blockers.includes(b)) merged.blockers.push(b);
    merged.errors.push(...obs.errors);
    if (obs.text) texts.push(obs.text);
    if (!merged.url) merged.url = obs.url;
    for (const el of obs.elements) {
      if (merged.elements.length >= MAX_OBSERVED) break;
      const ref = `${index}.${el.ref}`;
      refs.set(ref, { frame, local: el.ref, role: el.role, name: el.name, inputType: el.input_type, documentId: obs.document_id, value: el.value, href: el.href });
      if (extended && el.bounds) {
        const offset = await driver.offset(frame, frames);
        el.bounds = [el.bounds[0] + offset.x, el.bounds[1] + offset.y, el.bounds[2], el.bounds[3]];
      }
      merged.elements.push({ ...el, ...(extended ? { frame: String(index) } : {}), ref });
    }
  }
  if (extended && parts.reduce((n, p) => n + p.obs.elements.length, 0) > MAX_OBSERVED) (merged.coverage ??= []).push("Interactive element transport limit reached.");
  if (extended && texts.join(" | ").length > TEXT_LIMIT) (merged.coverage ??= []).push("Page text truncated.");
  merged.errors = merged.errors.slice(0, 20);
  merged.text = texts.join(" | ").slice(0, TEXT_LIMIT);
  if (screenshot) {
    // Nothing on the page changes for a screenshot: the panel stays where it is (the model is
    // told it is ApplyShortly's own), and ref labels are drawn into the image, not the page.
    // Only a driver without an image canvas falls back to labels on the page.
    const inImage = annotate && extended && driver.canDrawLabels;
    const onPage = annotate && !inImage;
    try {
      if (onPage) {
        for (const frame of frames) {
          const items = [...refs].filter(([, target]) => target.frame === frame)
            .map(([ref, target]) => ({ ref, local: target.local }));
          await driver.call(frame, "screenshotRefs", items);
        }
      }
      const labels = inImage ? merged.elements.filter((e) => e.bounds && e.in_viewport !== false).map((e) => ({ ref: e.ref, bounds: e.bounds })) : [];
      merged.screenshot = await driver.screenshot(labels);
      if (extended && driver.shotScale) merged.screenshot_scale = Math.min(4, Math.max(0.05, driver.shotScale));
    } catch { /* the planner works without it */ }
    finally {
      if (onPage) for (const frame of frames) await driver.call(frame, "clearScreenshotRefs").catch(() => {});
    }
  }
  return { observation: merged, refs, frames };
}

async function clickRef(driver, target, frames) {
  const refusal = await driver.call(target.frame, "clickable", target.local);
  if (refusal) throw new Error(refusal);
  const box = await driver.call(target.frame, "box", target.local);
  if (!box) throw new Error("That element is gone from the page.");
  if (!box.width && !box.height) throw new Error("That element isn't visible.");
  const offset = await driver.offset(target.frame, frames);
  await driver.click(box.x + offset.x, box.y + offset.y);
}

async function waitForResult(probe, ready, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let result;
  do {
    result = await probe();
    if (ready(result)) return result;
    await sleep(100);
  } while (Date.now() < deadline);
  return result;
}

/** Whether a field shows what was typed (a mask may add spaces, dashes or separators). */
export function holdsTyped(value, text) {
  const digits = (t) => String(t ?? "").replace(/\D/g, "");
  const words = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (/^[\d\s+()\-.,]+$/.test(text) && digits(text).length >= 3) return digits(value).endsWith(digits(text).replace(/^0+/, "")) || digits(value).includes(digits(text));
  return words(value).includes(words(text));
}

async function typeInto(driver, target, frames, text, adaptive = false) {
  await clickRef(driver, target, frames);
  const focus = await driver.call(target.frame, "focusForTyping", target.local);
  if (!focus?.ok) throw new Error(focus?.detail ?? "Couldn't focus that field.");
  if (focus.mode === "direct") {
    const set = await driver.call(target.frame, "setDirect", target.local, text);
    if (!set.ok) throw new Error(set.detail);
  } else {
    await driver.call(target.frame, "noteShown");
    await driver.insertText(text);
    if (text && text.length <= KEY_TYPING_LIMIT && driver.typeKeys) {
      const now = await driver.call(target.frame, "state", target.local);
      if (typeof now?.value === "string" && !holdsTyped(now.value, text)) {
        // A masked input dropped the inserted string: clear it and type key by key instead.
        await driver.call(target.frame, "focusForTyping", target.local);
        await driver.press("Backspace");
        await driver.typeKeys(text);
      }
    }
    // A "Search…" box that is really a pick-one typeahead: the page drops text that was never
    // picked from its list, and dependent fields (State after Country) unlock only on a pick.
    if (!adaptive) await sleep(TYPEAHEAD_WAIT_MS);
    const pick = adaptive
      ? await waitForResult(() => driver.call(target.frame, "typedSuggestion", target.local, text), (r) => r?.ok, 1500)
      : await driver.call(target.frame, "typedSuggestion", target.local, text);
    if (pick?.ok) {
      await clickRef(driver, { ...target, local: pick.ref }, frames);
      return;
    }
  }
  await driver.call(target.frame, "blur", target.local);
}

/** Native selects directly; custom dropdowns and typeaheads by opening, typing and picking. */
async function choose(driver, target, frames, answer, adaptive = false) {
  const native = await driver.call(target.frame, "selectNative", target.local, answer);
  if (native?.native) {
    if (!native.ok) throw new Error(native.detail);
    return native.value;
  }
  await driver.call(target.frame, "noteShown");
  await clickRef(driver, target, frames);
  if (!adaptive) await sleep(DROPDOWN_WAIT_MS);
  let match = adaptive
    ? await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok || r?.options?.length)
    : await driver.call(target.frame, "matchOption", target.local, answer);
  if (!match.ok) {
    // A typeahead: type the answer and wait for suggestions.
    const focus = await driver.call(target.frame, "focusForTyping", target.local);
    if (focus?.ok && focus.mode === "keys") {
      await driver.insertText(answer);
      if (!adaptive) await sleep(TYPEAHEAD_WAIT_MS);
      match = adaptive
        ? await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok)
        : await driver.call(target.frame, "matchOption", target.local, answer);
    }
  }
  if (!match.ok && (await driver.call(target.frame, "scrollOptions", target.local, true))) {
    // A virtualized list renders only the options in view: page through it.
    for (let i = 0; i < MAX_OPTION_PAGES; i++) {
      await sleep(OPTION_SCROLL_WAIT_MS);
      match = await driver.call(target.frame, "matchOption", target.local, answer);
      if (match.ok || !(await driver.call(target.frame, "scrollOptions", target.local, false))) break;
    }
  }
  if (!match.ok) {
    await closePicker(driver, target);
    const shown = match.options?.length ? ` Options shown: ${match.options.join(", ")}` : " No options appeared.";
    throw new Error(`No option matches "${answer}".${shown}`.slice(0, 290));
  }
  await clickRef(driver, { ...target, local: match.ref }, frames);
  return match.text;
}

/**
 * The answers a question about a choice offers, so the panel can show them as buttons: a radio
 * group's options, a dropdown's listed options, or (a list that loads when opened) what shows
 * after opening it for a moment. [] for free-text questions or when nothing could be read.
 * The platform names the field by its ref; radio groups as "g<n>:<ref of one option>".
 */
/** The role of the field a question is about (checkbox, file, textbox…), or null when it names none. */
export function questionRole(observation, question) {
  const ref = String(question?.ref ?? "").replace(/^g\d+:/, "");
  return (ref && observation.elements.find((e) => e.ref === ref)?.role) || null;
}

export async function questionChoices(driver, refs, frames, observation, question) {
  const ref = String(question?.ref ?? "").replace(/^g\d+:/, "");
  const el = ref && observation.elements.find((e) => e.ref === ref);
  if (!el) return [];
  if (el.role === "radio" || (el.role === "checkbox" && el.group)) {
    return observation.elements.filter((e) => e.role === el.role && e.group === el.group).map((e) => e.name).filter(Boolean);
  }
  if (el.options?.length) return el.options;
  const target = refs.get(ref);
  if (el.role !== "combobox" || !target) return [];
  try {
    await driver.call(target.frame, "noteShown");
    await clickRef(driver, target, frames);
    await sleep(DROPDOWN_WAIT_MS);
    return (await driver.call(target.frame, "shownChoices", target.local)) ?? [];
  } catch {
    return [];
  } finally {
    await closePicker(driver, target);
  }
}

/** Carries out one vetted action; returns the result the platform sees next step. */
export async function execute(driver, refs, frames, action, files) {
  const target = action.ref ? refs.get(action.ref) : null;
  if (action.ref && !target) throw new Error("That element is no longer on the page.");
  switch (action.type) {
    case "switch_tab":
      if (!driver.switchTab) throw new Error("Application tab switching is unavailable.");
      await driver.switchTab(action.tab_id);
      return null;
    case "click":
      if (action.command_id) {
        const refusal = await driver.call(target.frame, "clickable", target.local);
        if (refusal) throw new Error(refusal);
      }
      if (action.x != null && action.y != null) {
        const offset = await driver.offset(target.frame, frames);
        if (!(await driver.call(target.frame, "hitTest", action.x - offset.x, action.y - offset.y, target.local))) throw new Error("Screenshot point changed or is obscured; reobserve.");
        await driver.click(action.x, action.y);
        return null;
      }
      if (action.command_id) {
        const box = await driver.call(target.frame, "box", target.local);
        if (!box || !(await driver.call(target.frame, "hitTest", box.x, box.y, target.local))) throw new Error("Control is obscured or changed; inspect again.");
      }
      await clickRef(driver, target, frames);
      return null;
    case "type":
      await typeInto(driver, target, frames, action.text ?? "", Boolean(action.command_id));
      return null;
    case "select":
      return choose(driver, target, frames, action.text ?? "", Boolean(action.command_id));
    case "check": {
      const now = await driver.call(target.frame, "state", target.local);
      if (Boolean(now?.checked) !== Boolean(action.checked)) await clickRef(driver, target, frames);
      return null;
    }
    case "upload": {
      const file = await files(action.file);
      if (!file) throw new Error(action.file === "cover_letter" ? "No cover letter to attach." : "No résumé uploaded in ApplyShortly.");
      const res = await driver.call(target.frame, "attach", target.local, file.base64, file.name, file.type);
      if (!res?.ok) throw new Error(res?.detail ?? "The upload didn't take the file.");
      return res.value;
    }
    case "press":
      if (action.command_id && (!target || !(await driver.call(target.frame, "prepareKey", target.local, action.key)))) throw new Error("Key target is unsafe or unfocused.");
      if (target) await driver.call(target.frame, "box", target.local);
      await driver.press(action.key);
      return null;
    case "scroll":
      if (target && action.command_id) await driver.call(target.frame, "scrollControl", target.local, action.direction ?? "down");
      else if (target) await driver.call(target.frame, "box", target.local);
      else await driver.call(frames.find((f) => f.isTop) ?? frames[0], "scrollPage", action.direction ?? "down");
      return null;
    case "wait":
      await sleep(Math.min(action.ms ?? 1000, 5000));
      return null;
    case "hover": {
      const box = await driver.call(target.frame, "box", target.local);
      if (!box || (!box.width && !box.height)) throw new Error("That element isn't visible.");
      const offset = await driver.offset(target.frame, frames);
      await driver.hover(box.x + offset.x, box.y + offset.y);
      return null;
    }
    case "drag": {
      const drop = refs.get(action.to_ref);
      if (!drop) throw new Error("The drop target is no longer on the page.");
      const from = await driver.call(target.frame, "box", target.local);
      const to = await driver.call(drop.frame, "box", drop.local);
      if (!from || !to) throw new Error("That element is gone from the page.");
      const a = await driver.offset(target.frame, frames);
      const b = await driver.offset(drop.frame, frames);
      await driver.drag({ x: from.x + a.x, y: from.y + a.y }, { x: to.x + b.x, y: to.y + b.y });
      return null;
    }
    case "wait_for": {
      const deadline = Date.now() + Math.min(action.ms ?? 5000, 10_000);
      do {
        for (const frame of frames) {
          if (await driver.call(frame, "hasText", action.text ?? "").catch(() => false)) return null;
        }
        await sleep(WAIT_FOR_POLL_MS);
      } while (Date.now() < deadline);
      throw new Error(`"${String(action.text ?? "").slice(0, 80)}" did not appear.`);
    }
    default:
      throw new Error(`Unknown action ${action.type}`);
  }
}

/** Waits for navigation to finish and the DOM to go quiet in the top frame. */
export async function settle(driver) {
  const deadline = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < deadline && !driver.dialog) {
    try {
      const frames = await driver.frames();
      const top = frames.find((f) => f.isTop);
      if (top && (await driver.call(top, "settle", 400, 4000)) === "complete") return;
    } catch { /* mid-navigation: try again */ }
    await sleep(250);
  }
}

/**
 * One agent run in one tab. Control methods come from the panel: reply(text), skip(),
 * resume() after a CAPTCHA/sign-in or a click the user had to make, pause(), stop().
 */
export class Agent {
  constructor({ tabId, appId, driver, step, files, notify, report, controllerVersion = 1, startUrl = null }) {
    this.trustedOrigins = new Set(startUrl ? [new URL(startUrl).origin] : []);
    this.controllerVersion = controllerVersion;
    /** @type {Promise<void> | null} */
    this.runPromise = null;
    this.messages = [];
    this.progressGuard = new ProgressGuard();
    this.executedCommands = new Set();
    this.tabId = tabId;
    this.appId = appId;
    this.driver = driver;
    this.step = step;
    this.files = files;
    this.notify = notify;
    this.report = report;
    this.status = "starting";
    this.stopped = false;
    this.paused = false;
    this.controlRevision = 0;
    this.waiting = null; // resolves with the user's input while status is ask_user / paused
    this.log = [];
    this.last = null;
    driver.onDetached = () => this.stop("You closed the debugging bar, so the agent stopped.");
  }

  emit(extra = {}) {
    const message = { type: "agentUpdate", controller_version: this.controllerVersion, status: this.status, log: this.log.slice(-40), appId: this.appId, ...this.last, ...extra };
    void this.notify(message);
  }

  say(line) {
    if (line) this.log.push(line);
  }

  waitForUser() {
    if (this.stopped) return Promise.resolve({ kind: "stop" });
    if (this.messages.length) return Promise.resolve({ kind: "message" });
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  input(kind, text) {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.({ kind, text });
  }

  message(text) {
    if (this.controllerVersion !== 2) throw new Error("Restart with the upgraded AI driver.");
    this.progressGuard.reset();
    this.messages.push(text);
    this.controlRevision += 1;
    this.paused = false;
    this.input("message", text);
  }

  reply(text) { this.progressGuard.reset(); this.input("reply", text); }
  skip() { this.input("skip"); }
  resume() { this.progressGuard.reset(); this.paused = false; this.input("resume"); }
  pause() { this.controlRevision += 1; this.paused = true; this.status = "paused"; this.emit(); }

  stop(reason = "Stopped. The form is yours to finish.") {
    if (this.stopped) return;
    this.stopped = true;
    this.status = "stopped";
    this.say(reason);
    this.input("stop");
    this.emit({ message: reason });
  }

  /**
   * A JavaScript dialog froze the page. It is the user's to answer (never accepted here, a
   * "Leave site?" one least of all); the run carries on by itself once it closes, with no AI call.
   * False when the user stopped the agent instead.
   */
  async dialogHandoff() {
    const dialog = this.driver.dialog;
    const text = `The page opened a browser dialog${dialog?.message ? `: "${String(dialog.message).slice(0, 200)}"` : ""}. Answer it yourself; I'll carry on when it closes.`;
    this.say(text);
    this.last = { ...this.last, question: { kind: "blocker", text } };
    this.status = "waiting";
    this.emit();
    const input = await Promise.race([this.driver.dialogClosed().then(() => ({ kind: "closed" })), this.waitForUser()]);
    this.waiting = null;
    if (input.kind === "stop" || this.stopped) return false;
    this.status = "running";
    this.last = { ...this.last, question: null };
    this.say("Continuing…");
    return true;
  }

  async run() {
    let sessionId = null;
    let results = [];
    /** @type {Record<string, any>} */
    let extra = {};
    let wantScreenshot = this.controllerVersion === 2;
    let annotateScreenshot = false;
    let focusQuery = "";
    let captchaCleared = false;
    try {
      await this.driver.attach();
      this.status = "running";
      this.say("Started. Watching the page…");
      this.emit();
      while (!this.stopped) {
        if (this.paused) {
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
        }
        await settle(this.driver);
        let observed = null;
        if (!this.driver.dialog) {
          try {
            observed = await observeTab(this.driver, {
              screenshot: wantScreenshot, annotate: annotateScreenshot, extended: this.controllerVersion === 2, query: focusQuery,
            });
          } catch (error) {
            if (!(error instanceof Error && error.name === "DialogOpenError")) throw error;
          }
        }
        if (this.driver.dialog || !observed) {
          if (!(await this.dialogHandoff())) break;
          wantScreenshot = true;
          continue;
        }
        const { observation, refs, frames } = observed;
        if (this.stopped) break;
        if (this.paused) continue;
        this.url = observation.url;
        if (this.controllerVersion === 2) {
          const origin = new URL(observation.url).origin;
          if (!this.trustedOrigins.size) this.trustedOrigins.add(origin);
          if (!this.trustedOrigins.has(origin)) {
            this.last = { ...this.last, question: { kind: "click", text: `The application moved to ${origin}. Continue only if this is the intended employer or ATS.` } };
            this.status = "waiting";
            this.emit();
            const input = await this.waitForUser();
            if (input.kind === "stop") break;
            const message = this.messages.shift() || "";
            if (input.kind === "resume" || /^(continue|resume|go ahead)\b/i.test(message)) this.trustedOrigins.add(origin);
            this.status = "running";
            wantScreenshot = true;
            continue;
          }
        }
        // A CAPTCHA is never ours to solve or to plan around: hand the form to the user right away,
        // without asking the platform. After they say it's done, one pass runs even if a solved
        // widget stays on the page.
        if (!observation.blockers.includes("captcha")) captchaCleared = false;
        else if (!captchaCleared) {
          this.say("There's a CAPTCHA on this page. Solve it yourself; I haven't touched it.");
          this.last = { agent_engine: this.last?.agent_engine, question: { kind: "blocker", text: CAPTCHA_HANDOFF }, filled: this.last?.filled, unresolved: this.last?.unresolved };
          this.status = "waiting";
          this.emit();
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
          this.status = "running";
          captchaCleared = true;
          extra = { resumed: true };
          this.say("Continuing…");
          continue;
        }
        if (this.messages.length) {
          extra = { user_message: this.messages.splice(0).join("\n").slice(0, 4000), inspect_only: true };
          // Explicit editing/continuation instructions may mutate; page questions remain read-only.
          extra.inspect_only = !/^(fill|set|change|select|choose|upload|attach|click|continue|resume|do |complete|go |open|scroll|replace|update)\b/i.test(extra.user_message);
        }
        const stalled = this.controllerVersion === 2 && this.progressGuard.check(observation);
        if (stalled) {
          this.pause();
          this.say(`${stalled} Paused to avoid spending more tokens. Check the page, then resume when ready.`);
          this.emit({ message: this.log.at(-1) });
          continue;
        }
        const controlRevision = this.controlRevision;
        const res = await this.step({
          ...(this.controllerVersion === 2 ? { controller_version: 2, request_id: crypto.randomUUID() } : {}),
          session_id: sessionId,
          application_id: this.appId,
          observation,
          results,
          in_user_tab: true,
          ...extra,
        });
        sessionId = res.session_id;
        if (res.controller_version !== 2) this.controllerVersion = 1;
        if (this.stopped) break;
        if (this.paused || controlRevision !== this.controlRevision) {
          // The user took control while the model was deciding. Never execute that plan.
          results = (res.actions ?? []).map((_, index) => ({
            index, ok: false, detail: "Not executed: user took control; fresh observation required.",
          }));
          extra = {};
          wantScreenshot = true;
          continue;
        }
        results = [];
        extra = {};
        focusQuery = res.focus_query || "";
        wantScreenshot = Boolean(res.want_screenshot);
        annotateScreenshot = Boolean(res.annotate_screenshot);
        this.last = { agent_engine: res.agent_engine, question: res.question, filled: res.filled, unresolved: res.unresolved, message: res.message, failure_code: res.failure_code };
        if (res.message && res.status !== "continue") this.say(res.message);
        for (const [index, action] of (res.actions ?? []).entries()) {
          if (this.stopped || this.paused || controlRevision !== this.controlRevision) break;
          try {
            if (this.controllerVersion === 2) {
              if (!action.command_id || action.observation_id !== observation.observation_id) throw new Error("Stale browser command; fresh observation required.");
              if (this.executedCommands.has(action.command_id)) throw new Error("Duplicate command refused; inspect current page.");
              this.executedCommands.add(action.command_id);
            }
            if (this.controllerVersion === 2) {
              const top = frames.find((f) => f.isTop);
              const fresh = await this.driver.call(top, "freshState", "");
              if (fresh.document_id !== observation.document_id) throw new Error("Document changed; inspect before acting.");
            }
            if (this.controllerVersion === 2 && action.ref) {
              const target = refs.get(action.ref);
              const fresh = await this.driver.call(target.frame, "freshState", target.local);
              if (fresh.document_id !== target.documentId) throw new Error("Document changed; inspect before acting.");
              if (["type", "select", "check"].includes(action.type) && fresh.user_edited && fresh.value !== target.value) throw new Error("User edited this field; inspect before changing it.");
            }
            if (this.controllerVersion === 2 && action.type === "click") {
              const href = refs.get(action.ref)?.href;
              if (href && /^https?:/.test(href)) this.trustedOrigins.add(new URL(href).origin);
            }
            if (this.controllerVersion === 2 && action.type === "switch_tab") {
              const tab = observation.tabs?.find((t) => t.id === action.tab_id);
              if (tab) this.trustedOrigins.add(new URL(tab.url).origin);
            }
            if (this.controllerVersion === 2) for (const frame of frames) await this.driver.call(frame, "executionState", true);
            try {
              await execute(this.driver, refs, frames, action, this.files);
            } finally {
              if (this.controllerVersion === 2) for (const frame of frames) await this.driver.call(frame, "executionState", false).catch(() => {});
            }
            this.say(action.label);
            results.push({ index, ok: true, ...(this.controllerVersion === 2 ? { command_id: action.command_id, effect: "Input dispatched; verify committed result in next observation." } : {}) });
          } catch (error) {
            this.say(`Couldn't: ${action.label || action.type} (${error.message})`);
            results.push({ index, ...(this.controllerVersion === 2 ? { command_id: action.command_id } : {}), ok: false, detail: String(error.message).slice(0, 290) });
            break; // later actions assume this one succeeded; re-observe before continuing
          }
          await sleep(ACTION_PAUSE_MS);
        }
        if (res.status === "ready_for_review") {
          this.status = "ready";
          this.say("Everything I could fill is done. Review the form and submit it yourself.");
          this.emit();
          await this.report("filled", res, this.url);
          if (this.controllerVersion !== 2) break;
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
          this.status = "running";
          wantScreenshot = true;
          continue;
        }
        if (res.status === "failed") {
          this.status = "failed";
          this.emit();
          await this.report("failed", res, this.url);
          break;
        }
        if (res.status === "ask_user") {
          if (res.question?.kind === "question") {
            const choices = await questionChoices(this.driver, refs, frames, observation, res.question);
            this.last.question = { ...res.question, choices, role: questionRole(observation, res.question) };
          }
          this.status = "waiting";
          this.emit();
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
          this.status = "running";
          if (input.kind === "reply") extra = { user_reply: input.text };
          else if (input.kind === "skip") extra = { skip_question: true };
          else extra = { resumed: true };
          wantScreenshot = this.controllerVersion === 2 || wantScreenshot;
          this.say(input.kind === "reply" ? "Thanks, continuing." : "Continuing…");
          results = [];
        }
        this.emit();
      }
    } catch (error) {
      const message = explain(error);
      this.status = "failed";
      this.say(`The agent stopped: ${message}`);
      this.last = { ...this.last, failure_code: "unknown" };
      this.emit({ message });
      // An older platform without the agent is not a failure of this application.
      if (!unsupported(error)) await this.report("failed", { failure_code: "unknown", message }, this.url).catch(() => {});
    } finally {
      await this.driver.detach();
    }
  }
}
