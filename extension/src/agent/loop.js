// The form agent's loop in the background service worker: observe the tab, ask the platform
// (POST /api/extension/agent/step) what to do, act, let the page settle, repeat.
//
// The platform decides; this file only carries out vetted actions. It still refuses to click a
// final submit button (page.js clickable()), and it stops whenever the platform says
// ready_for_review: the user reviews the form and submits it themselves.

const MAX_OBSERVED = 400; // the API's limit on elements per observation
const TEXT_LIMIT = 4000;
const TYPEAHEAD_WAIT_MS = 700;
const DROPDOWN_WAIT_MS = 350;
const ACTION_PAUSE_MS = 120;
const LOAD_WAIT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A platform from before the agent answers its route with FastAPI's bare 404. */
const unsupported = (error) => error?.status === 404 && error.message === "Not Found";

/** Platform errors in words the panel can show. */
export function explain(error) {
  if (unsupported(error)) {
    return "Your ApplyShortly server doesn't have the form agent yet. Use the Form tab for now; the agent works once the platform is updated.";
  }
  if (error?.status === 410) return "This agent session ended. Run the agent again.";
  if (error?.status === 401 || error?.status === 403) return "ApplyShortly didn't accept the API key. Sign in again from settings.";
  return error?.message || String(error);
}

/** Observe every frame and merge into one observation; refs become "frame.local". */
export async function observeTab(driver, { screenshot = false } = {}) {
  const frames = await driver.frames();
  const refs = new Map();
  const merged = { url: "", title: "", dialog: null, blockers: [], errors: [], text: "", elements: [], more_below: false };
  const parts = [];
  for (const [index, frame] of frames.entries()) {
    let obs;
    try { obs = await driver.call(frame, "observe", { isTop: frame.isTop }); }
    catch { continue; } // a frame that navigated away or forbids scripting
    if (obs) parts.push({ index, frame, obs });
  }
  const top = parts.find((p) => p.frame.isTop);
  if (top) {
    Object.assign(merged, { url: top.obs.url, title: top.obs.title, dialog: top.obs.dialog, more_below: top.obs.more_below });
  }
  const texts = [];
  for (const { index, frame, obs } of parts) {
    // With a modal open in the tab, the rest of the page is behind it; iframes inside it count.
    if (merged.dialog && !frame.isTop && !(await driver.inDialog(frame, frames).catch(() => false))) continue;
    for (const b of obs.blockers) if (!merged.blockers.includes(b)) merged.blockers.push(b);
    merged.errors.push(...obs.errors);
    if (obs.text) texts.push(obs.text);
    if (!merged.url) merged.url = obs.url;
    for (const el of obs.elements) {
      if (merged.elements.length >= MAX_OBSERVED) break;
      const ref = `${index}.${el.ref}`;
      refs.set(ref, { frame, local: el.ref, role: el.role, name: el.name, inputType: el.input_type });
      merged.elements.push({ ...el, ref });
    }
  }
  merged.errors = merged.errors.slice(0, 20);
  merged.text = texts.join(" | ").slice(0, TEXT_LIMIT);
  if (screenshot) {
    try { merged.screenshot = await driver.screenshot(); } catch { /* the planner works without it */ }
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

async function typeInto(driver, target, frames, text) {
  await clickRef(driver, target, frames);
  const focus = await driver.call(target.frame, "focusForTyping", target.local);
  if (!focus?.ok) throw new Error(focus?.detail ?? "Couldn't focus that field.");
  if (focus.mode === "direct") {
    const set = await driver.call(target.frame, "setDirect", target.local, text);
    if (!set.ok) throw new Error(set.detail);
  } else {
    await driver.insertText(text);
  }
  await driver.call(target.frame, "blur", target.local);
}

/** Native selects directly; custom dropdowns and typeaheads by opening, typing and picking. */
async function choose(driver, target, frames, answer) {
  const native = await driver.call(target.frame, "selectNative", target.local, answer);
  if (native?.native) {
    if (!native.ok) throw new Error(native.detail);
    return native.value;
  }
  await driver.call(target.frame, "noteShown");
  await clickRef(driver, target, frames);
  await sleep(DROPDOWN_WAIT_MS);
  let match = await driver.call(target.frame, "matchOption", target.local, answer);
  if (!match.ok) {
    // A typeahead: type the answer and wait for suggestions.
    const focus = await driver.call(target.frame, "focusForTyping", target.local);
    if (focus?.ok && focus.mode === "keys") {
      await driver.insertText(answer);
      await sleep(TYPEAHEAD_WAIT_MS);
      match = await driver.call(target.frame, "matchOption", target.local, answer);
    }
  }
  if (!match.ok) {
    await driver.press("Escape").catch(() => {});
    const shown = match.options?.length ? ` Options shown: ${match.options.join(", ")}` : " No options appeared.";
    throw new Error(`No option matches "${answer}".${shown}`.slice(0, 290));
  }
  await clickRef(driver, { ...target, local: match.ref }, frames);
  return match.text;
}

/** Carries out one vetted action; returns the result the platform sees next step. */
export async function execute(driver, refs, frames, action, files) {
  const target = action.ref ? refs.get(action.ref) : null;
  if (action.ref && !target) throw new Error("That element is no longer on the page.");
  switch (action.type) {
    case "click":
      await clickRef(driver, target, frames);
      return null;
    case "type":
      await typeInto(driver, target, frames, action.text ?? "");
      return null;
    case "select":
      return choose(driver, target, frames, action.text ?? "");
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
      if (target) await driver.call(target.frame, "box", target.local);
      await driver.press(action.key);
      return null;
    case "scroll":
      if (target) await driver.call(target.frame, "box", target.local);
      else await driver.call(frames.find((f) => f.isTop) ?? frames[0], "scrollPage", action.direction ?? "down");
      return null;
    case "wait":
      await sleep(Math.min(action.ms ?? 1000, 5000));
      return null;
    default:
      throw new Error(`Unknown action ${action.type}`);
  }
}

/** Waits for navigation to finish and the DOM to go quiet in the top frame. */
export async function settle(driver) {
  const deadline = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < deadline) {
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
  constructor({ tabId, appId, driver, step, files, notify, report }) {
    Object.assign(this, { tabId, appId, driver, step, files, notify, report });
    this.status = "starting";
    this.stopped = false;
    this.paused = false;
    this.waiting = null; // resolves with the user's input while status is ask_user / paused
    this.log = [];
    this.last = null;
    driver.onDetached = () => this.stop("You closed the debugging bar, so the agent stopped.");
  }

  emit(extra = {}) {
    const message = { type: "agentUpdate", status: this.status, log: this.log.slice(-40), ...this.last, ...extra };
    void this.notify(message);
  }

  say(line) {
    if (line) this.log.push(line);
  }

  waitForUser() {
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  input(kind, text) {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.({ kind, text });
  }

  reply(text) { this.input("reply", text); }
  skip() { this.input("skip"); }
  resume() { this.paused = false; this.input("resume"); }
  pause() { this.paused = true; this.status = "paused"; this.emit(); }

  stop(reason = "Stopped. The form is yours to finish.") {
    if (this.stopped) return;
    this.stopped = true;
    this.status = "stopped";
    this.say(reason);
    this.input("stop");
    this.emit({ message: reason });
  }

  async run() {
    let sessionId = null;
    let results = [];
    let extra = {};
    let wantScreenshot = false;
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
        const { observation, refs, frames } = await observeTab(this.driver, { screenshot: wantScreenshot });
        if (this.stopped) break;
        this.url = observation.url;
        const res = await this.step({
          session_id: sessionId,
          application_id: this.appId,
          observation,
          results,
          in_user_tab: true,
          ...extra,
        });
        sessionId = res.session_id;
        results = [];
        extra = {};
        wantScreenshot = Boolean(res.want_screenshot);
        this.last = { question: res.question, filled: res.filled, unresolved: res.unresolved, message: res.message, failure_code: res.failure_code };
        if (res.message && res.status !== "continue") this.say(res.message);
        for (const [index, action] of (res.actions ?? []).entries()) {
          if (this.stopped) break;
          try {
            await execute(this.driver, refs, frames, action, this.files);
            this.say(action.label);
            results.push({ index, ok: true });
          } catch (error) {
            this.say(`Couldn't: ${action.label || action.type} (${error.message})`);
            results.push({ index, ok: false, detail: String(error.message).slice(0, 290) });
          }
          await sleep(ACTION_PAUSE_MS);
        }
        if (res.status === "ready_for_review") {
          this.status = "ready";
          this.say("Everything I could fill is done. Review the form and submit it yourself.");
          this.emit();
          await this.report("filled", res, this.url);
          break;
        }
        if (res.status === "failed") {
          this.status = "failed";
          this.emit();
          await this.report("failed", res, this.url);
          break;
        }
        if (res.status === "ask_user") {
          this.status = "waiting";
          this.emit();
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
          this.status = "running";
          if (input.kind === "reply") extra = { user_reply: input.text };
          else if (input.kind === "skip") extra = { skip_question: true };
          else extra = { resumed: true };
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
