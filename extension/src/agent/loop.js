// The form agent's loop in the background service worker: observe the tab, ask the platform
// (POST /api/extension/agent/step) what to do, act, let the page settle, repeat.
//
// The platform decides; this file only carries out vetted actions. It still refuses to click a
// final submit button (page.js clickable()), and it stops whenever the platform says
// ready_for_review: the user reviews the form and submits it themselves.

import { CommandRunner, readinessOf } from "./commands.js";

const MAX_OBSERVED = 400; // the API's limit on elements per observation
const TEXT_LIMIT = 12000;
const TYPEAHEAD_WAIT_MS = 700;
const KEY_TYPING_LIMIT = 200; // longer text is never a masked input; insertText stays
const DROPDOWN_WAIT_MS = 350;
const OPTION_SCROLL_WAIT_MS = 120;
const MAX_OPTION_PAGES = 80;
const ACTION_PAUSE_MS = 120;
const CAPTCHA_HANDOFF = "There's a CAPTCHA on this page. Please solve it yourself.";
// An embedded verification widget must not prevent filling the accessible application.
// Challenge-only pages still need the user's intervention before any work can continue.
export function hasApplicationFields(observation) {
  return observation.elements.some((e) =>
    ["textbox", "textarea", "combobox", "select", "radio", "checkbox", "file"].includes(e.role) &&
    !e.disabled && !["password", "hidden", "search"].includes(e.input_type) &&
    !/captcha|recaptcha|hcaptcha|security code|verification code|i.?m not a robot/i.test(`${e.name ?? ""} ${e.identity ?? ""}`));
}

const LOAD_WAIT_MS = 10_000;
const WAIT_FOR_POLL_MS = 250;
// A state seen this often among the recent ones is a loop (one state, or two alternating, as
// when a pop-up keeps closing and reopening): pause before spending more.
const REPEAT_LIMIT = 3;
const RECENT_STATES = 10;
const CALL_LIMIT = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only explicit commands unlock edits. Polite prefixes and recovery commands are commands
// too ("put my website in", "type 5 years", "use the second one"); questions and negations
// must retain the inspection-only path.
export function isEditingInstruction(message) {
  const text = String(message).trim().replace(/^please\s+/i, "");
  if (/^(do not|don't|never)\b/i.test(text) || text.endsWith("?")) return false;
  return /^(fill|set|change|select|choose|pick|upload|attach|click|tick|check|mark|continue|resume|complete|open|scroll|replace|update|recover|proceed|delete|remove|clear|correct|fix|add|commit|verify|put|type|enter|write|input|insert|paste|use|answer|make|leave|switch|turn)\b|^do\s+(?:the|these|those|it)\b|^go\s+(?:ahead|on)\b/i.test(text);
}

// Ignore transient IDs and screenshot bytes when detecting stalled planning.
export class ProgressGuard {
  constructor() { this.reset(); }
  reset() { this.states = []; this.calls = 0; this.failures = []; this.reading = false; }
  /** The step just taken only looked (a screenshot, review, options): the same page after it is no stall. */
  noteReading(reading) { this.reading = Boolean(reading); }
  /** Labels of the actions that failed in the latest step ([] when all stuck). A stall with failures is a field the agent cannot fill. */
  noteFailures(labels) { this.failures = labels.slice(0, 3); }
  check(observation) {
    if (this.reading) { this.reading = false; this.calls += 1; return this.calls >= CALL_LIMIT ? `The agent reached its ${CALL_LIMIT}-call safety limit.` : null; }
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

const BUSY_RETRIES = [1000, 2500];
/**
 * One step request. "Already running" (409) is the platform's session lock: it can answer that
 * while it still finishes this very decision. Sent again with the same request_id, the finished
 * decision comes back from its cache instead of the run ending. Other 409s are not retried.
 */
export async function stepWithRetry(step, body, waits = BUSY_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step(body);
    } catch (error) {
      const busy = error?.status === 409 && /already running/i.test(String(error?.message ?? ""));
      if (!busy || !body.request_id || attempt >= waits.length) throw error;
      await sleep(waits[attempt]);
    }
  }
}

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
      if (typeof now?.value === "string" && !(await driver.call(target.frame, "holdsTyped", now.value, text))) {
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
    return { matched: native.value, committed: native.value, verified: true };
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
    // A dial code ("+91") is not part of any country's name: typed into the search box it would
    // filter every country away (or leave an unfiltered list whose first entry is a different country).
    const dialCode = /^\+\d{1,4}$/.test(String(answer).trim());
    if (focus?.ok && focus.mode === "keys" && !dialCode) {
      await driver.insertText(answer);
      if (!adaptive) await sleep(TYPEAHEAD_WAIT_MS);
      match = adaptive
        ? await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok)
        : await driver.call(target.frame, "matchOption", target.local, answer);
    }
  }
  if (!match.ok && !match.options?.length) {
    // The first try often races the menu opening: make sure it is open, then wait for options.
    if (!(await driver.call(target.frame, "pickerOpen", target.local).catch(() => false))) await clickRef(driver, target, frames);
    match = await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok || r?.options?.length, 3000);
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
    // Role-less typeaheads (older react-select): the filtered list's first entry is highlighted,
    // so ArrowDown + Enter commits it; keep it only if the widget then shows the answer.
    const keyed = await commitByKeys(driver, target, answer);
    if (keyed.verified) return { matched: answer, ...keyed };
    await closePicker(driver, target);
    const shown = match.options?.length ? ` Options shown: ${match.options.join(", ")}` : " No options appeared.";
    const left = keyed.undone === false && keyed.committed ? ` The field now shows "${keyed.committed}": fix it by hand.` : "";
    throw new Error(`No option matches "${answer}".${shown}${left}`.slice(0, 290));
  }
  await clickRef(driver, { ...target, local: match.ref }, frames);
  const readback = await readCommitted(driver, target, [match.text, answer]);
  // Some widgets (a phone's country list) stay open after a pick, and an open list of 200+ options
  // would fill every later page read: close it now that the choice is made.
  await closePicker(driver, target);
  return { matched: match.text, ...readback };
}

/** Reads the widget's value after a pick, giving React a moment to re-render. */
async function readCommitted(driver, target, wanted, widgetOnly = false) {
  let committed = null;
  let verified = false;
  for (let i = 0; i < 4; i++) {
    await sleep(i === 0 ? 150 : 250);
    committed = await driver.call(target.frame, "committedValue", target.local, widgetOnly).catch(() => null);
    verified = Boolean(await driver.call(target.frame, "showsChoice", committed, ...wanted));
    if (verified) break;
  }
  return { committed: committed ?? "", verified };
}

async function commitByKeys(driver, target, answer) {
  // ArrowDown + Enter takes the first entry of whatever list is open. The page decides whether that
  // entry is the answer (the typed search text has narrowed the list to it); nothing is pressed
  // otherwise. The page script is shared with the platform's server driver.
  const start = await driver.call(target.frame, "keyCommitStart", target.local, answer).catch(() => null);
  if (!start?.ok) return { committed: "", verified: false };
  try {
    // Enter on a plain input, or a combobox whose list closed, submits the form: check again right
    // before Enter, after ArrowDown, that the list is still open.
    if (!(await driver.call(target.frame, "prepareKey", target.local, "ArrowDown"))) return { committed: "", verified: false };
    await driver.press("ArrowDown");
    if (!(await driver.call(target.frame, "prepareKey", target.local, "Enter"))) return { committed: "", verified: false };
    await driver.press("Enter");
  } catch {
    return { committed: "", verified: false };
  }
  // Strict: the typed search text sitting in the input must not count as a pick.
  let check = null;
  for (let i = 0; i < 4; i++) {
    await sleep(i === 0 ? 150 : 250);
    check = await driver.call(target.frame, "keyCommitCheck", target.local, answer, start.before).catch(() => null);
    if (check?.verified) break;
  }
  if (check?.verified) return { committed: check.committed, verified: true };
  if (check?.wrong) {
    // A wrong entry took the Enter: take it back (Backspace clears a single-value widget), and
    // say so rather than leave an answer nobody chose.
    await driver.press("Backspace").catch(() => {});
    const now = await driver.call(target.frame, "keyCommitCheck", target.local, answer, start.before).catch(() => null);
    return { committed: now?.committed ?? "", verified: false, undone: now?.undone ?? false };
  }
  return { committed: check?.committed ?? "", verified: false };
}

/**
 * The answers a question about a choice offers, so the panel can show them as buttons: a radio
 * group's options, a dropdown's listed options, or (a list that loads when opened) what shows
 * after opening it for a moment. [] for free-text questions or when nothing could be read.
 * The platform names the field by its ref; radio groups as "g<n>:<ref of one option>".
 */
/**
 * The observation with each search-style picker (a textbox the page marks `popup`, as Greenhouse's
 * dropdowns are) as the dropdown it is, so reading its choices opens it instead of treating it as
 * free text. Shared by the commands (options, fill_form) and the questions put to the candidate.
 */
export function comboView(observation) {
  return { ...observation, elements: observation.elements.map((e) => (e.popup && e.role === "textbox" ? { ...e, role: "combobox" } : e)) };
}

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
  if (el.role === "checkbox" && !el.group && el.section) {
    // Boxes the page lists under one question without grouping them (Greenhouse's salary ranges)
    // are that question's choices; the platform folds them the same way.
    const same = observation.elements.filter((e) => e.role === "checkbox" && !e.group && e.section === el.section);
    if (same.length >= 2 && /\?|\b(?:select|choose|pick)\b|all that apply/i.test(el.section)) return same.map((e) => e.name).filter(Boolean);
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
    case "type": {
      let text = action.text ?? "";
      // A phone box with a country selector: pick the country from the "+91 …" prefix first,
      // then type only the national number the widget expects.
      const plan = /^\s*\+/.test(text) ? await driver.call(target.frame, "phoneTypePlan", target.local, text).catch(() => null) : null;
      let country = null;
      if (plan) {
        let current = plan;
        if (!current.ok && current.needCountry) {
          country = await choose(driver, { ...target, local: current.countryRef }, frames, current.needCountry, Boolean(action.command_id));
          current = await driver.call(target.frame, "phoneTypePlan", target.local, text);
        }
        if (!current?.ok) throw new Error(current?.reason ?? "Choose the phone country first.");
        text = current.text;
      }
      // A box with a maxlength silently cuts a longer answer: say so instead of typing half of it.
      const limit = await driver.call(target.frame, "textLimit", target.local).catch(() => 0);
      if (limit > 0 && String(text).length > limit) throw new Error(`This field accepts at most ${limit} characters and the answer has ${String(text).length}. Shorten it to fit.`);
      await typeInto(driver, target, frames, text, Boolean(action.command_id));
      if (!plan) {
        // Read the field back so an input the page dropped or cleared is reported, not assumed.
        // Only for assistant commands (command_id); a password is never echoed.
        if (!action.command_id || target.inputType === "password" || !text) return null;
        const shown = await driver.call(target.frame, "committedValue", target.local).catch(() => null);
        if (shown == null) return null;
        const loose = ["date", "datetime-local", "month", "time", "week", "number", "range", "color"].includes(target.inputType);
        return { matched: text, committed: shown, verified: loose ? String(shown).trim() !== "" : await driver.call(target.frame, "holdsTyped", shown, text) };
      }
      const committed = await driver.call(target.frame, "committedValue", target.local).catch(() => null);
      return { matched: text, committed: committed ?? "", verified: String(committed ?? "").replace(/\D/g, "").endsWith(text.replace(/\D/g, "")),
        ...(country ? { country: country.committed } : {}) };
    }
    case "select": {
      const first = await choose(driver, target, frames, action.text ?? "", Boolean(action.command_id));
      if (first.verified) return first;
      // The first pick often lands late or races the menu opening: look once more, then try once
      // more. Choosing the same option again is harmless if the first had already taken.
      try {
        const second = await choose(driver, target, frames, action.text ?? "", Boolean(action.command_id));
        return second.verified || !first.committed ? second : first;
      } catch { return first; }
    }
    case "check": {
      const want = Boolean(action.checked);
      const read = async () => Boolean((await driver.call(target.frame, "state", target.local).catch(() => null))?.checked);
      if ((await read()) === want) return { checked: want, committed: String(want), verified: true };
      await clickRef(driver, target, frames);
      let got = false;
      for (let i = 0; i < 3 && (got = await read()) !== want; i++) await sleep(150);
      if (got !== want) {
        // The pointer click landed on something else (a custom checkbox drawn over the input):
        // activate the input itself, once, and read again.
        if (await driver.call(target.frame, "activate", target.local).catch(() => false)) {
          await sleep(150);
          got = await read();
        }
      }
      return { checked: got, committed: String(got), verified: got === want };
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

/** Page actions of protocol 2 run with the page told to let the agent's clicks through the panel. */
export async function executing(driver, frames, run) {
  for (const frame of frames) await driver.call(frame, "executionState", true);
  try { return await run(); } finally {
    for (const frame of frames) await driver.call(frame, "executionState", false).catch(() => {});
  }
}

/** A command's outcome as the platform accepts it: small, plain JSON. */
function boundedResult(result) {
  const text = JSON.stringify(result);
  return text.length <= 8000 ? result : { truncated: true, ok: result.ok, type: result.type, committed: result.committed, verified: result.verified };
}

/**
 * One agent run in one tab. Control methods come from the panel: reply(text), skip(),
 * resume() after a CAPTCHA/sign-in or a click the user had to make, pause(), stop().
 */
export class Agent {
  constructor({ tabId, appId, driver, step, files, notify, report, controllerVersion = 1, startUrl = null, verifiedCommands = false }) {
    this.trustedOrigins = new Set(startUrl ? [new URL(startUrl).origin] : []);
    this.controllerVersion = controllerVersion;
    this.planner = "platform";
    // The platform understands fill_form / options / review and the per-action `result` (committed, verified).
    this.verifiedCommands = verifiedCommands && controllerVersion === 2;
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
    this.fillingNotice = null;
    driver.onDetached = () => this.stop("You closed the debugging bar, so the agent stopped.");
    // The same guarded, verified commands a host assistant gets; this controller never submits.
    this.runner = new CommandRunner({ driver, policy: {
      blockers: false, // blocker handoffs are handled by this loop and the platform policy
      allowHref: (href, origin) => { if (/^https?:/.test(href)) this.trustedOrigins.add(origin); return true; },
      isPaused: () => this.paused,
      files: (kind) => this.files(kind),
      around: (frames, run) => executing(this.driver, frames, run),
    } });
  }

  emit(extra = {}) {
    const message = { type: "agentUpdate", controller_version: this.controllerVersion, status: this.status, filling_notice: this.fillingNotice, log: this.log.slice(-40), appId: this.appId, ...this.last, ...extra };
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
    if (this.controllerVersion !== 2) throw new Error("Restart with the upgraded AI-led controller.");
    this.progressGuard.reset();
    this.messages.push(text);
    this.controlRevision += 1;
    this.paused = false;
    this.status = "running";
    this.emit();
    this.input("message", text);
  }

  reply(text) { this.progressGuard.reset(); this.input("reply", text); }
  skip() { this.progressGuard.reset(); this.input("skip"); }
  resume() { this.progressGuard.reset(); this.paused = false; this.status = "running"; this.emit(); this.input("resume"); }
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
    let captchaClearedFor = ""; // the document whose CAPTCHA the user cleared; another page or a new challenge starts over
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
        // Fill accessible application fields first. Only a challenge without an accessible
        // form blocks the run here; embedded widgets are left for the user at submission.
        const documentKey = observation.document_id ?? observation.url;
        if (!observation.blockers.includes("captcha") || captchaClearedFor !== documentKey) captchaClearedFor = "";
        if (observation.blockers.includes("captcha") && !captchaClearedFor && !hasApplicationFields(observation)) {
          this.say("There's a CAPTCHA on this page. Solve it yourself; I haven't touched it.");
          this.last = { agent_engine: this.last?.agent_engine, question: { kind: "blocker", text: CAPTCHA_HANDOFF }, filled: this.last?.filled, unresolved: this.last?.unresolved };
          this.status = "waiting";
          this.emit();
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
          this.status = "running";
          captchaClearedFor = documentKey;
          extra = { resumed: true };
          this.say("Continuing…");
          continue;
        }
        if (this.messages.length) {
          extra = { user_message: this.messages.splice(0).join("\n").slice(0, 4000), inspect_only: true };
          // Explicit editing/continuation instructions may mutate; page questions remain read-only.
          extra.inspect_only = !isEditingInstruction(extra.user_message);
        }
        const stalled = this.controllerVersion === 2 && this.progressGuard.check(observation);
        if (stalled) {
          if (/without progress/.test(stalled)) {
            // The page stopped changing: either the same fills keep failing, or the platform keeps answering with
            // nothing that moves the form. Either way the agent can't get further alone. Ask instead of pausing.
            const stuck = this.progressGuard.failures;
            const all = (this.last?.unresolved ?? []).map((u) => String(u?.label ?? u).trim().slice(0, 90));
            // One field at a time, as the platform asks them: the first, and how many more wait.
            const open = all.slice(0, 1);
            const more = all.length > 1 ? ` (and ${all.length - 1} more)` : "";
            const text = stuck.length
              ? `I couldn't fill: ${stuck.slice(0, 1).join("")}${stuck.length > 1 ? ` (and ${stuck.length - 1} more)` : ""}. Fill ${stuck.length > 1 ? "them" : "it"} yourself, or type the answer for me, then continue.`
              : open.length
                ? `I'm stuck on: ${open[0]}${more}. Fill it on the page yourself, or type the answer for me, then continue.`
                : "I'm not getting any further on this page. Fill what's left yourself, or type the answer for me, then continue.";
            this.say(text);
            this.last = { ...this.last, question: { kind: "blocker", text } };
            this.status = "waiting";
            this.emit();
            const input = await this.waitForUser();
            if (input.kind === "stop") break;
            this.progressGuard.reset();
            this.status = "running";
            wantScreenshot = true;
            if (input.kind === "reply") extra = { user_reply: input.text };
            else if (input.kind !== "message") extra = { resumed: true };
            continue;
          }
          this.pause();
          this.say(`${stalled} Paused to avoid spending more tokens. Check the page, then resume when ready.`);
          this.emit({ message: this.log.at(-1) });
          continue;
        }
        const controlRevision = this.controlRevision;
        const res = await stepWithRetry(this.step, {
          ...(this.controllerVersion === 2 ? { controller_version: 2, request_id: crypto.randomUUID() } : {}),
          ...(this.verifiedCommands ? { verified_commands: true } : {}),
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
        if (res.message?.startsWith("Using Rules-led: AI-led is unavailable")) this.fillingNotice = res.message.split(".")[0] + ".";
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
            let outcome = null;
            if (this.controllerVersion === 2) {
              this.runner.observed = observed;
              if (action.type === "switch_tab") {
                const tab = observation.tabs?.find((t) => t.id === action.tab_id);
                if (tab) this.trustedOrigins.add(new URL(tab.url).origin);
              }
              if (["fill_form", "options", "review"].includes(action.type)) {
                outcome = await this.runner.compound(action.type, { fields: action.fields, ref: action.ref }, { observationId: action.observation_id, commandId: action.command_id });
              } else {
                // Same document, same control (not edited by the user, not replaced), not a password.
                await this.runner.guard(action);
                outcome = await executing(this.driver, frames, () => execute(this.driver, refs, frames, action, this.files));
              }
            } else {
              await execute(this.driver, refs, frames, action, this.files);
            }
            this.say(action.label);
            const shown = this.verifiedCommands && outcome && typeof outcome === "object"
              ? ["fill_form", "options", "review"].includes(action.type) ? outcome : CommandRunner.shape(action, outcome) : null;
            const failed = shown?.verified === false || (action.type === "fill_form" && shown && shown.done < shown.requested_count);
            results.push({ index, ok: !failed, ...(this.controllerVersion === 2 ? { command_id: action.command_id, effect: "Input dispatched; verify committed result in next observation." } : {}),
              ...(shown ? { result: boundedResult(shown) } : {}), ...(failed ? { detail: "The page did not show the requested value." } : {}) });
            if (failed) { this.say(`Didn't stick: ${action.label || action.type}`); break; } // later actions assume this one stuck
          } catch (error) {
            this.say(`Couldn't: ${action.label || action.type} (${error.message})`);
            results.push({ index, ...(this.controllerVersion === 2 ? { command_id: action.command_id } : {}), ok: false, detail: String(error.message).slice(0, 290) });
            break; // later actions assume this one succeeded; re-observe before continuing
          }
          await sleep(ACTION_PAUSE_MS);
        }
        const looks = (res.actions ?? []).length
          ? res.actions.every((a) => ["review", "options", "observe", "read_page"].includes(a.type))
          : Boolean(res.want_screenshot);
        this.progressGuard.noteReading(looks && results.every((r) => r.ok));
        // The field's name, not the verb the action's label starts with ("Filled Phone" → "Phone").
        this.progressGuard.noteFailures(results.filter((r) => !r.ok).map((r) => String(res.actions?.[r.index]?.label || res.actions?.[r.index]?.type || "a field").replace(/^(?:Filled|Filling|Chose|Typed|Selected)\s+/i, "")));
        if (res.status === "ready_for_review") {
          this.status = "ready";
          const captchaPending = observation.blockers.includes("captcha") && !captchaClearedFor;
          this.say(captchaPending
            ? "Everything I could fill is done. Review the form, complete any CAPTCHA the site requires, then submit it yourself."
            : "Everything I could fill is done. Review the form and submit it yourself.");
          // The panel only sees the top document; tell it what this frame-aware observation found.
          this.emit({ captchaPending, readiness: readinessOf(observation, refs) });
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
            // A picker the page reports as a textbox is still a dropdown: its choices become the
            // card's buttons, not "type your answer / draft it".
            const view = comboView(observation);
            const choices = await questionChoices(this.driver, refs, frames, view, res.question);
            this.last.question = { ...res.question, choices, role: questionRole(view, res.question) };
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
