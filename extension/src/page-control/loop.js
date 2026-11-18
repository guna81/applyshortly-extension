import { CommandRunner, choiceGroup, isChoiceOption, readinessOf, scanFields } from "./commands.js";
const STEP_DEADLINE_MS = 6e4;
const MAX_OBSERVED = 400;
const TEXT_LIMIT = 12e3;
const TYPEAHEAD_WAIT_MS = 700;
const KEY_TYPING_LIMIT = 200;
const DROPDOWN_WAIT_MS = 350;
const OPTION_SCROLL_WAIT_MS = 120;
const MAX_OPTION_PAGES = 80;
const ACTION_PAUSE_MS = 120;
const WAIT_ACTION_MS = 4e3;
const CAPTCHA_HANDOFF = "There's a CAPTCHA on this page. Please solve it yourself.";
function hasApplicationFields(observation) {
  return observation.elements.some((e) => ["textbox", "textarea", "combobox", "select", "radio", "checkbox", "file"].includes(e.role) && !e.disabled && !["password", "hidden", "search"].includes(e.input_type) && !/captcha|recaptcha|hcaptcha|security code|verification code|i.?m not a robot/i.test(`${e.name ?? ""} ${e.identity ?? ""}`));
}
const LOAD_WAIT_MS = 1e4;
const WAIT_FOR_POLL_MS = 250;
const REPEAT_LIMIT = 3;
const RECENT_STATES = 10;
const CALL_LIMIT = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function isEditingInstruction(message) {
  const text = String(message).trim().replace(/^please\s+/i, "");
  if (/^(do not|don't|never)\b/i.test(text) || text.endsWith("?")) return false;
  return /^(fill|set|change|select|choose|pick|upload|attach|click|tick|check|mark|continue|resume|complete|open|scroll|replace|update|recover|proceed|delete|remove|clear|correct|fix|add|commit|verify|put|type|enter|write|draft|input|insert|paste|use|answer|make|leave|switch|turn|fetch|read|look|visit|browse|pull|take|get)\b|^do\s+(?:the|these|those|it)\b|^go\s+(?:ahead|on)\b/i.test(text);
}
class ProgressGuard {
  states = [];
  calls = 0;
  failures = [];
  failureDetails = [];
  reading = false;
  constructor() {
    this.reset();
  }
  reset() {
    this.states = [];
    this.calls = 0;
    this.failures = [];
    this.failureDetails = [];
    this.reading = false;
  }
  /** The step just taken only looked (a screenshot, review, options): the same page after it is no stall. */
  noteReading(reading) {
    this.reading = Boolean(reading);
  }
  /** Labels of the actions that failed in the latest step ([] when all stuck). A stall with failures is a field the agent cannot fill. */
  /** `details`: for each failed action its label, the text it tried and the error, so a hand-off can say why it failed. */
  noteFailures(labels, details = []) {
    this.failures = labels.slice(0, 3);
    this.failureDetails = details.slice(0, 3);
  }
  check(observation) {
    if (this.reading) {
      this.reading = false;
      this.calls += 1;
      return this.calls >= CALL_LIMIT ? `The agent reached its ${CALL_LIMIT}-call safety limit.` : null;
    }
    const state = JSON.stringify({
      url: observation.url,
      dialog: observation.dialog,
      text: observation.text,
      errors: observation.errors,
      blockers: observation.blockers,
      elements: observation.elements.map((e) => [
        e.role,
        e.name,
        e.value,
        e.checked,
        e.disabled,
        e.expanded,
        e.bounds
      ])
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
const echoes = (a, b) => {
  const flat = (x2) => String(x2 ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const [x, y] = [flat(a), flat(b)];
  return Boolean(x) && Boolean(y) && (x === y || y.includes(x) || x.includes(y));
};
const unsupported = (error) => error?.status === 404 && error.message === "Not Found";
const BUSY_RETRIES = [1e3, 2500];
function transientStepError(error) {
  return error instanceof TypeError || [408, 429, 502, 503, 504].includes(error?.status);
}
async function stepWithRetry(step, body, waits = BUSY_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step(body);
    } catch (error) {
      const busy = error?.status === 409 && /already running/i.test(String(error?.message ?? ""));
      if (!busy && !transientStepError(error) || !body.request_id || attempt >= waits.length) throw error;
      await sleep(waits[attempt]);
    }
  }
}
function explain(error) {
  if (unsupported(error)) {
    return "ApplyShortly doesn't have the form agent yet. Use the assistant chat for now; the agent works once ApplyShortly is updated.";
  }
  if (error?.status === 410) return "This agent session ended. Run the agent again.";
  if (error?.status === 401 || error?.status === 403) return "ApplyShortly didn't accept the API key. Sign in again from settings.";
  return error?.message || String(error);
}
async function closePicker(driver, target) {
  const open = await driver.call(target.frame, "pickerOpen", target.local).catch(() => false);
  if (open) await driver.press("Escape").catch(() => {
  });
}
async function observeTab(driver, { screenshot = false, annotate = false, extended = false, query = "" } = {}) {
  const frames = await driver.frames();
  const refs = /* @__PURE__ */ new Map();
  const merged = { url: "", title: "", dialog: null, blockers: [], errors: [], text: "", elements: [], more_below: false };
  const parts = [];
  for (const [index, frame] of frames.entries()) {
    let obs;
    try {
      obs = await driver.call(frame, "observe", { isTop: frame.isTop, extended, query });
    } catch {
      if (extended) (merged.coverage ??= []).push("A frame could not be inspected.");
      continue;
    }
    if (obs && extended && driver.accessible) {
      try {
        const ax = await driver.accessible(frame, obs.elements.map((e) => e.ref), query);
        obs.elements.push(...ax.elements);
        if (ax.incomplete) (obs.coverage ??= []).push("Accessibility snapshot incomplete.");
      } catch {
        (obs.coverage ??= []).push("Accessibility snapshot unavailable.");
      }
    }
    if (obs) parts.push({ index, frame, obs });
  }
  const top = parts.find((p) => p.frame.isTop);
  if (top) {
    Object.assign(merged, { url: top.obs.url, title: top.obs.title, dialog: top.obs.dialog, more_below: top.obs.more_below });
  }
  if (extended) {
    Object.assign(merged, {
      observation_id: crypto.randomUUID(),
      document_id: top?.obs.document_id,
      step_label: top?.obs.step_label,
      viewport_width: top?.obs.viewport_width || 0,
      viewport_height: top?.obs.viewport_height || 0
    });
  }
  if (extended && driver.applicationTabs) merged.tabs = await driver.applicationTabs();
  if (extended && driver.diagnostics) merged.diagnostics = driver.diagnostics();
  const texts = [];
  for (const { index, frame, obs } of parts) {
    if (merged.dialog && !frame.isTop && !await driver.inDialog(frame, frames).catch(() => false)) continue;
    if (extended) (merged.coverage ??= []).push(...obs.coverage ?? []);
    for (const b of obs.blockers) if (!merged.blockers.includes(b)) merged.blockers.push(b);
    merged.errors.push(...obs.errors);
    if (obs.text) texts.push(obs.text);
    if (!merged.url) merged.url = obs.url;
    for (const el of obs.elements) {
      if (merged.elements.length >= MAX_OBSERVED) break;
      const ref = `${index}.${el.ref}`;
      refs.set(ref, { frame, local: el.ref, role: el.role, name: el.name, inputType: el.input_type, documentId: obs.document_id, value: el.value, href: el.href, inViewport: el.in_viewport, viewportHeight: obs.viewport_height, viewportWidth: obs.viewport_width });
      if (extended && el.bounds) {
        const offset = await driver.offset(frame, frames);
        el.bounds = [el.bounds[0] + offset.x, el.bounds[1] + offset.y, el.bounds[2], el.bounds[3]];
      }
      merged.elements.push({ ...el, ...extended ? { frame: String(index) } : {}, ref });
    }
  }
  if (extended && parts.reduce((n, p) => n + p.obs.elements.length, 0) > MAX_OBSERVED) (merged.coverage ??= []).push("Interactive element transport limit reached.");
  if (extended && texts.join(" | ").length > TEXT_LIMIT) (merged.coverage ??= []).push("Page text truncated.");
  merged.errors = merged.errors.slice(0, 20);
  merged.text = texts.join(" | ").slice(0, TEXT_LIMIT);
  if (screenshot) {
    const inImage = annotate && extended && driver.canDrawLabels;
    const onPage = annotate && !inImage;
    try {
      if (onPage) {
        for (const frame of frames) {
          const items = [...refs].filter(([, target]) => target.frame === frame).map(([ref, target]) => ({ ref, local: target.local }));
          await driver.call(frame, "screenshotRefs", items);
        }
      }
      const labels = inImage ? merged.elements.filter((e) => e.bounds && e.in_viewport !== false).map((e) => ({ ref: e.ref, bounds: e.bounds })) : [];
      merged.screenshot = await driver.screenshot(labels);
      if (extended && driver.shotScale) merged.screenshot_scale = Math.min(4, Math.max(0.05, driver.shotScale));
    } catch {
    } finally {
      if (onPage) for (const frame of frames) await driver.call(frame, "clearScreenshotRefs").catch(() => {
      });
    }
  }
  return { observation: merged, refs, frames };
}
async function clickRef(driver, target, frames) {
  const refusal = await driver.call(target.frame, "clickable", target.local);
  if (refusal) throw new Error(refusal);
  let box = await driver.call(target.frame, "box", target.local);
  const movedIntoView = target.inViewport === false || box && (target.viewportHeight && (box.y < 0 || box.y > target.viewportHeight) || target.viewportWidth && (box.x < 0 || box.x > target.viewportWidth));
  let settled = !movedIntoView;
  if (movedIntoView) {
    let previous = box;
    await sleep(100);
    box = await waitForResult(() => driver.call(target.frame, "box", target.local), (next) => {
      const inView = next && (!target.viewportHeight || next.y >= 0 && next.y <= target.viewportHeight) && (!target.viewportWidth || next.x >= 0 && next.x <= target.viewportWidth);
      settled = Boolean(inView && previous && ["x", "y", "width", "height"].every((key) => Math.abs(next[key] - previous[key]) < 0.5));
      previous = next;
      return !next || settled;
    }, 1500);
  }
  if (!box) throw new Error("That element is gone from the page.");
  if (!box.width && !box.height) throw new Error("That element isn't visible.");
  if (!settled) throw new Error("That element is still moving; inspect the page again before clicking.");
  if (target.selectionOption && !await driver.call(target.frame, "hitTest", box.x, box.y, target.local)) throw new Error("The option is obscured or changed; inspect the dropdown again.");
  const offset = await driver.offset(target.frame, frames);
  await driver.click(box.x + offset.x, box.y + offset.y);
}
async function clickOption(driver, target, frames) {
  try {
    await clickRef(driver, target, frames);
    return false;
  } catch (error) {
    if (!/obscured or changed/.test(String(error?.message))) throw error;
    const done = await driver.call(target.frame, "activateOption", target.local);
    if (!done?.ok) throw error;
    return true;
  }
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
      if (typeof now?.value === "string" && !await driver.call(target.frame, "holdsTyped", now.value, text)) {
        await driver.call(target.frame, "focusForTyping", target.local);
        await driver.press("Backspace");
        await driver.typeKeys(text);
      }
    }
    if (!adaptive) await sleep(TYPEAHEAD_WAIT_MS);
    const pick = adaptive ? await waitForResult(() => driver.call(target.frame, "typedSuggestion", target.local, text), (r) => r?.ok, 1500) : await driver.call(target.frame, "typedSuggestion", target.local, text);
    if (pick?.ok) {
      await clickOption(driver, { ...target, local: pick.ref, selectionOption: true }, frames);
      return;
    }
  }
  await driver.call(target.frame, "blur", target.local);
}
async function choose(driver, target, frames, answer, adaptive = false) {
  const native = await driver.call(target.frame, "selectNative", target.local, answer);
  if (native?.native) {
    if (!native.ok) throw new Error(native.detail);
    return { matched: native.value, committed: native.value, verified: true };
  }
  await driver.call(target.frame, "noteShown");
  await clickRef(driver, target, frames);
  if (!adaptive) await sleep(DROPDOWN_WAIT_MS);
  let match = adaptive ? await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok || r?.options?.length) : await driver.call(target.frame, "matchOption", target.local, answer);
  if (!match.ok) {
    const focus = await driver.call(target.frame, "focusForTyping", target.local);
    const dialCode = /^\+\d{1,4}$/.test(String(answer).trim());
    if (focus?.ok && focus.mode === "keys" && !dialCode) {
      await driver.insertText(answer);
      if (!adaptive) await sleep(TYPEAHEAD_WAIT_MS);
      match = adaptive ? await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok) : await driver.call(target.frame, "matchOption", target.local, answer);
    }
  }
  if (!match.ok && !match.options?.length) {
    if (!await driver.call(target.frame, "pickerOpen", target.local).catch(() => false)) await clickRef(driver, target, frames);
    match = await waitForResult(() => driver.call(target.frame, "matchOption", target.local, answer), (r) => r?.ok || r?.options?.length, 3e3);
  }
  if (!match.ok && await driver.call(target.frame, "scrollOptions", target.local, true)) {
    for (let i = 0; i < MAX_OPTION_PAGES; i++) {
      await sleep(OPTION_SCROLL_WAIT_MS);
      match = await driver.call(target.frame, "matchOption", target.local, answer);
      if (match.ok || !await driver.call(target.frame, "scrollOptions", target.local, false)) break;
    }
  }
  if (!match.ok) {
    const keyed = await commitByKeys(driver, target, answer);
    if (keyed.verified) return { matched: answer, ...keyed };
    await closePicker(driver, target);
    const shown = match.options?.length ? ` Options shown: ${match.options.join(", ")}` : " No options appeared.";
    const left = keyed.undone === false && keyed.committed ? ` The field now shows "${keyed.committed}": fix it by hand.` : "";
    throw new Error(`No option matches "${answer}".${shown}${left}`.slice(0, 290));
  }
  const viaScript = await clickOption(driver, { ...target, local: match.ref, selectionOption: true }, frames);
  const readback = await readCommitted(driver, target, [match.text, answer]);
  await closePicker(driver, target);
  return { matched: match.text, ...readback, ...viaScript ? { via: "activateOption" } : {} };
}
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
  const start = await driver.call(target.frame, "keyCommitStart", target.local, answer).catch(() => null);
  if (!start?.ok) return { committed: "", verified: false };
  try {
    if (!await driver.call(target.frame, "prepareKey", target.local, "ArrowDown")) return { committed: "", verified: false };
    await driver.press("ArrowDown");
    if (!await driver.call(target.frame, "prepareKey", target.local, "Enter")) return { committed: "", verified: false };
    await driver.press("Enter");
  } catch {
    return { committed: "", verified: false };
  }
  let check = null;
  for (let i = 0; i < 4; i++) {
    await sleep(i === 0 ? 150 : 250);
    check = await driver.call(target.frame, "keyCommitCheck", target.local, answer, start.before).catch(() => null);
    if (check?.verified) break;
  }
  if (check?.verified) return { committed: check.committed, verified: true };
  if (check?.wrong) {
    await driver.press("Backspace").catch(() => {
    });
    const now = await driver.call(target.frame, "keyCommitCheck", target.local, answer, start.before).catch(() => null);
    return { committed: now?.committed ?? "", verified: false, undone: now?.undone ?? false };
  }
  return { committed: check?.committed ?? "", verified: false };
}
function comboView(observation) {
  return { ...observation, elements: observation.elements.map((e) => e.popup && e.role === "textbox" ? { ...e, role: "combobox" } : e) };
}
function questionRole(observation, question) {
  const ref = String(question?.ref ?? "").replace(/^g\d+:/, "");
  return ref && observation.elements.find((e) => e.ref === ref)?.role || null;
}
async function questionChoices(driver, refs, frames, observation, question) {
  const ref = String(question?.ref ?? "").replace(/^g\d+:/, "");
  const el = ref && observation.elements.find((e) => e.ref === ref);
  if (!el) return [];
  if (el.role === "radio" || el.role === "checkbox" && el.group) {
    return observation.elements.filter((e) => e.role === el.role && e.group === el.group).map((e) => e.name).filter(Boolean);
  }
  if (isChoiceOption(el) && el.role !== "radio" && el.group) return choiceGroup(observation.elements, el).map((e) => e.name).filter(Boolean);
  if (el.role === "checkbox" && !el.group && el.section) {
    const same = observation.elements.filter((e) => e.role === "checkbox" && !e.group && e.section === el.section);
    if (same.length >= 2 && /\?|\b(?:select|choose|pick)\b|all that apply/i.test(el.section)) return same.map((e) => e.name).filter(Boolean);
  }
  if (el.options?.length) return el.options;
  const target = refs.get(ref);
  if (el.role !== "combobox" || !target) return [];
  try {
    await driver.call(target.frame, "noteShown");
    await clickRef(driver, target, frames);
    const query = await driver.call(target.frame, "typedText", target.local).catch(() => "");
    const state = await driver.call(target.frame, "freshState", target.local).catch(() => null);
    if (String(query ?? "").trim() && state?.user_edited !== true) {
      const focus = await driver.call(target.frame, "focusForTyping", target.local);
      if (focus?.ok && focus.mode === "keys") await driver.press("Backspace");
    }
    await sleep(DROPDOWN_WAIT_MS);
    return await driver.call(target.frame, "shownChoices", target.local) ?? [];
  } catch {
    return [];
  } finally {
    await closePicker(driver, target);
  }
}
async function execute(driver, refs, frames, action, files) {
  const target = action.ref ? refs.get(action.ref) : null;
  if (action.ref && !target) throw new Error("That element is no longer on the page.");
  switch (action.type) {
    case "wait":
      await sleep(WAIT_ACTION_MS);
      return null;
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
        if (!await driver.call(target.frame, "hitTest", action.x - offset.x, action.y - offset.y, target.local)) throw new Error("Screenshot point changed or is obscured; reobserve.");
        await driver.click(action.x, action.y);
        return null;
      }
      if (action.command_id) {
        const box = await driver.call(target.frame, "box", target.local);
        if (!box || !await driver.call(target.frame, "hitTest", box.x, box.y, target.local)) throw new Error("Control is obscured or changed; inspect again.");
      }
      await clickRef(driver, target, frames);
      return null;
    case "type": {
      let text = action.text ?? "";
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
      const limit = await driver.call(target.frame, "textLimit", target.local).catch(() => 0);
      if (limit > 0 && String(text).length > limit) throw new Error(`This field accepts at most ${limit} characters and the answer has ${String(text).length}. Shorten it to fit.`);
      await typeInto(driver, target, frames, text, Boolean(action.command_id));
      if (!plan) {
        if (!action.command_id || target.inputType === "password" || !text) return null;
        const shown = await driver.call(target.frame, "committedValue", target.local).catch(() => null);
        if (shown == null) return null;
        const loose = ["date", "datetime-local", "month", "time", "week", "number", "range", "color"].includes(target.inputType);
        return { matched: text, committed: shown, verified: loose ? String(shown).trim() !== "" : await driver.call(target.frame, "holdsTyped", shown, text) };
      }
      const committed = await driver.call(target.frame, "committedValue", target.local).catch(() => null);
      const digits = (value) => String(value ?? "").replace(/\D/g, "");
      const currentPlan = !String(committed ?? "").trim().startsWith("+") ? await driver.call(target.frame, "phoneTypePlan", target.local, action.text).catch(() => null) : null;
      const verified = Boolean(digits(committed) && (digits(committed) === digits(action.text) || digits(committed) === digits(text) && currentPlan?.ok === true));
      return {
        matched: text,
        committed: committed ?? "",
        verified,
        ...country ? { country: country.committed } : {}
      };
    }
    case "select": {
      const first = await choose(driver, target, frames, action.text ?? "", Boolean(action.command_id));
      if (first.verified) return first;
      try {
        const second = await choose(driver, target, frames, action.text ?? "", Boolean(action.command_id));
        return second.verified || !first.committed ? second : first;
      } catch {
        return first;
      }
    }
    case "check": {
      const want = Boolean(action.checked);
      const read = async () => Boolean((await driver.call(target.frame, "state", target.local).catch(() => null))?.checked);
      if (await read() === want) return { checked: want, committed: String(want), verified: true };
      await clickRef(driver, target, frames);
      let got = false;
      for (let i = 0; i < 3 && (got = await read()) !== want; i++) await sleep(150);
      if (got !== want) {
        if (await driver.call(target.frame, "activate", target.local).catch(() => false)) {
          await sleep(150);
          got = await read();
        }
      }
      return { checked: got, committed: String(got), verified: got === want };
    }
    case "upload": {
      const file = await files(action.file);
      if (!file) throw new Error(action.file === "cover_letter" ? "No cover letter to attach." : "No r\xE9sum\xE9 uploaded in ApplyShortly.");
      const res = await driver.call(target.frame, "attach", target.local, file.base64, file.name, file.type);
      if (!res?.ok) throw new Error(res?.detail ?? "The upload didn't take the file.");
      return res.value;
    }
    case "press":
      if (action.command_id && (!target || !await driver.call(target.frame, "prepareKey", target.local, action.key))) throw new Error("Key target is unsafe or unfocused.");
      if (target) await driver.call(target.frame, "box", target.local);
      await driver.press(action.key);
      return null;
    case "scroll":
      if (target && action.command_id) await driver.call(target.frame, "scrollControl", target.local, action.direction ?? "down");
      else if (target) await driver.call(target.frame, "box", target.local);
      else await driver.call(frames.find((f) => f.isTop) ?? frames[0], "scrollPage", action.direction ?? "down");
      return null;
    case "wait":
      await sleep(Math.min(action.ms ?? 1e3, 5e3));
      return null;
    case "hover": {
      const box = await driver.call(target.frame, "box", target.local);
      if (!box || !box.width && !box.height) throw new Error("That element isn't visible.");
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
      const deadline = Date.now() + Math.min(action.ms ?? 5e3, 1e4);
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
function withDeadline(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms / 1e3} s ${label}.`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
async function settle(driver) {
  const deadline = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < deadline && !driver.dialog) {
    try {
      const frames = await driver.frames();
      const top = frames.find((f) => f.isTop);
      if (top && await driver.call(top, "settle", 400, 4e3) === "complete") return;
    } catch {
    }
    await sleep(250);
  }
}
async function executing(driver, frames, run) {
  for (const frame of frames) await driver.call(frame, "executionState", true);
  try {
    return await run();
  } finally {
    for (const frame of frames) await driver.call(frame, "executionState", false).catch(() => {
    });
  }
}
function boundedResult(result) {
  const text = JSON.stringify(result);
  return text.length <= 8e3 ? result : { truncated: true, ok: result.ok, type: result.type, committed: result.committed, verified: result.verified };
}
class Agent {
  trustedOrigins;
  planner;
  silenceMs;
  verifiedCommands;
  runPromise;
  messages;
  progressGuard;
  executedCommands;
  tabId;
  appId;
  driver;
  step;
  files;
  notify;
  report;
  status;
  stopped;
  paused;
  controlRevision;
  waiting;
  log;
  last;
  recoveries;
  fillingNotice;
  runner;
  progress = {};
  url = "";
  reviewResult = null;
  constructor({ tabId, appId, driver, step, files, notify, report, startUrl = null, verifiedCommands = false }) {
    this.trustedOrigins = new Set(startUrl ? [new URL(startUrl).origin] : []);
    this.planner = "platform";
    this.silenceMs = 2e4;
    this.verifiedCommands = verifiedCommands;
    this.runPromise = null;
    this.messages = [];
    this.progressGuard = new ProgressGuard();
    this.executedCommands = /* @__PURE__ */ new Set();
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
    this.waiting = null;
    this.log = [];
    this.last = null;
    this.recoveries = [];
    this.fillingNotice = null;
    driver.onDetached = () => this.stop("You closed the debugging bar, so the agent stopped.");
    this.runner = new CommandRunner({ driver, policy: {
      blockers: false,
      // blocker handoffs are handled by this loop and the platform policy
      allowHref: (href, origin) => {
        if (/^https?:/.test(href)) this.trustedOrigins.add(origin);
        return true;
      },
      isPaused: () => this.paused,
      files: (kind) => this.files(kind),
      around: (frames, run) => executing(this.driver, frames, run)
    } });
  }
  /** What recovered by itself, for the debug channel (the test harness counts these per run). */
  recovered(kind, detail = "") {
    this.recoveries.push({ kind, detail: String(detail).slice(0, 70) });
  }
  emit(extra = {}) {
    const message = { type: "agentUpdate", guarded_commands: true, status: this.status, filling_notice: this.fillingNotice, log: this.log.slice(-40), appId: this.appId, ...this.progress, ...this.last, ...this.last?.debug ? { recoveries: this.recoveries.slice(-40) } : {}, ...extra };
    void this.notify(message);
  }
  say(line) {
    if (line) this.log.push(line);
  }
  waitForUser() {
    if (this.stopped) return Promise.resolve({ kind: "stop" });
    if (this.messages.length) return Promise.resolve({ kind: "message" });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  input(kind, text) {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.({ kind, text });
  }
  message(text) {
    this.progressGuard.reset();
    this.messages.push(text);
    this.controlRevision += 1;
    this.paused = false;
    this.status = "running";
    this.emit();
    this.input("message", text);
  }
  reply(text) {
    this.progressGuard.reset();
    this.input("reply", text);
  }
  skip() {
    this.progressGuard.reset();
    this.input("skip");
  }
  resume() {
    this.progressGuard.reset();
    this.paused = false;
    this.status = "running";
    this.emit();
    this.input("resume");
  }
  pause() {
    this.controlRevision += 1;
    this.paused = true;
    this.status = "paused";
    this.emit();
  }
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
    return true;
  }
  async planningStep(body) {
    const local = this.planner !== "platform";
    const call = () => local ? this.step(body) : stepWithRetry(this.step, body);
    const attempt = async () => {
      const started = Date.now();
      const timer = setInterval(() => {
        this.say(`Still waiting for the AI provider (${Math.round((Date.now() - started) / 1e3)}s). It may be slow or retrying.`);
        this.emit({ message: this.log.at(-1) });
      }, this.silenceMs);
      try {
        return await call();
      } finally {
        clearInterval(timer);
      }
    };
    for (let pauses = 0; ; pauses++) {
      try {
        return await attempt();
      } catch (error) {
        if (!transientStepError(error) || !local && !body.request_id || this.stopped || pauses >= 3) throw error;
        this.pause();
        this.say(`The AI provider is temporarily unavailable (${String(explain(error)).slice(0, 200)}). Resume to retry the same request without repeating page actions.`);
        this.emit({ message: this.log.at(-1) });
        while (this.paused && !this.stopped) await this.waitForUser();
        if (this.stopped) return null;
      }
    }
  }
  async run() {
    let sessionId = null;
    let results = [];
    let extra = {};
    let wantScreenshot = true;
    let annotateScreenshot = false;
    const stuckLooked = /* @__PURE__ */ new Set();
    let focusQuery = "";
    let observationFailures = 0;
    let recoveries = 0;
    let captchaClearedFor = "";
    try {
      await this.driver.attach();
      this.status = "running";
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
            observed = await withDeadline(observeTab(this.driver, {
              screenshot: wantScreenshot,
              annotate: annotateScreenshot,
              extended: true,
              query: focusQuery
            }), STEP_DEADLINE_MS, "reading the page");
          } catch (error) {
            if (!(error instanceof Error && error.name === "DialogOpenError")) {
              if (++observationFailures > 2) throw error;
              this.runner.reset();
              await sleep(500);
              continue;
            }
          }
        }
        if (this.driver.dialog || !observed) {
          if (!await this.dialogHandoff()) break;
          wantScreenshot = true;
          continue;
        }
        observationFailures = 0;
        const { observation, refs, frames } = observed;
        if (this.stopped) break;
        if (this.paused) continue;
        this.url = observation.url;
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
          continue;
        }
        if (this.messages.length) {
          extra = { user_message: this.messages.splice(0).join("\n").slice(0, 4e3), inspect_only: true };
          extra.inspect_only = !isEditingInstruction(extra.user_message);
        }
        const stalled = this.progressGuard.check(observation);
        if (stalled) {
          if (/without progress/.test(stalled)) {
            const stuck = this.progressGuard.failures;
            const stuckKey = stuck.join("|");
            if (stuck.length && !stuckLooked.has(stuckKey)) {
              stuckLooked.add(stuckKey);
              this.recovered("stuck_retry", stuck.slice(0, 1).join(""));
              this.progressGuard.reset();
              wantScreenshot = true;
              annotateScreenshot = true;
              extra = { stuck_retry: { fields: stuck.slice(0, 3) } };
              this.emit();
              continue;
            }
            const all = (this.last?.unresolved ?? []).map((u) => String(u?.label ?? u).trim().slice(0, 90));
            const open = all.slice(0, 1);
            const more = all.length > 1 ? ` (and ${all.length - 1} more)` : "";
            const why = this.progressGuard.failureDetails?.[0];
            const tried = why?.error ? ` ${why.tried ? `Tried "${why.tried}": ` : "Last error: "}${why.error.replace(/[.\s]+$/, "")}.` : "";
            const text = stuck.length ? `I couldn't fill: ${stuck.slice(0, 1).join("")}${stuck.length > 1 ? ` (and ${stuck.length - 1} more)` : ""}.${tried} Fill ${stuck.length > 1 ? "them" : "it"} yourself, or type the answer for me, then continue.` : open.length ? `I'm stuck on: ${open[0]}${more}. Fill it on the page yourself, or type the answer for me, then continue.` : "I'm not getting any further on this page. Fill what's left yourself, or type the answer for me, then continue.";
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
        let res;
        try {
          res = await this.planningStep({
            guarded_commands: true,
            request_id: crypto.randomUUID(),
            ...this.verifiedCommands ? { verified_commands: true } : {},
            session_id: sessionId,
            application_id: this.appId,
            observation,
            results,
            in_user_tab: true,
            ...extra
          });
        } catch (error) {
          if (this.planner !== "platform" || error?.status !== 410 || ++recoveries > 1) throw error;
          this.runner.reset();
          results = [];
          extra = {};
          sessionId = null;
          captchaClearedFor = "";
          this.pause();
          this.say("The planning session expired. Resume to start a fresh session from the current form. Previous skipped questions and answer permissions must be given again.");
          this.emit({ message: this.log.at(-1) });
          const input = await this.waitForUser();
          if (input.kind === "stop" || this.stopped) break;
          if (this.paused) continue;
          wantScreenshot = true;
          continue;
        }
        if (!res) break;
        sessionId = res.session_id;
        if (res.guarded_commands !== true) throw new Error("Update ApplyShortly before starting the form agent; this server does not support guarded commands.");
        if (this.stopped) break;
        if (this.paused || controlRevision !== this.controlRevision) {
          results = (res.actions ?? []).map((_, index) => ({
            index,
            ok: false,
            detail: "Not executed: user took control; fresh observation required."
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
        try {
          const { fields } = scanFields(observation);
          this.progress = { field_total: fields.length, field_answered: fields.filter((f) => {
            const v = String(f.value ?? "").trim();
            return v && v !== "false";
          }).length };
        } catch {
        }
        this.last = { agent_engine: res.agent_engine, question: res.question, filled: res.filled, unresolved: res.unresolved, message: res.message, failure_code: res.failure_code, ...res.debug ? { debug: res.debug } : {} };
        if (res.message && res.status !== "ready_for_review" && !echoes(res.message, res.question?.text)) this.say(res.message);
        for (const [index, action] of (res.actions ?? []).entries()) {
          if (this.stopped || this.paused || controlRevision !== this.controlRevision) break;
          try {
            if (!action.command_id || action.observation_id !== observation.observation_id) throw new Error("Stale browser command; fresh observation required.");
            if (this.executedCommands.has(action.command_id)) throw new Error("Duplicate command refused; inspect current page.");
            this.executedCommands.add(action.command_id);
            let outcome = null;
            this.runner.observed = observed;
            if (action.type === "switch_tab") {
              const tab = observation.tabs?.find((t) => t.id === action.tab_id);
              if (tab) this.trustedOrigins.add(new URL(tab.url).origin);
            }
            if (["fill_form", "options", "review"].includes(action.type)) {
              outcome = await withDeadline(this.runner.compound(action.type, { fields: action.fields, ref: action.ref }, { observationId: action.observation_id, commandId: action.command_id }), STEP_DEADLINE_MS, `doing ${action.label || action.type}`);
            } else if (action.type === "wait") {
              await execute(this.driver, refs, frames, action, this.files);
            } else if (action.type === "run_js") {
              outcome = await withDeadline(this.driver.evaluate(String(action.code ?? "")), STEP_DEADLINE_MS, "running a page script");
              if (outcome?.error) throw new Error(outcome.error);
            } else {
              await this.runner.guard(action);
              outcome = await withDeadline(executing(this.driver, frames, () => execute(this.driver, refs, frames, action, this.files)), STEP_DEADLINE_MS, `doing ${action.label || action.type}`);
            }
            if (outcome && typeof outcome === "object" && outcome.via === "activateOption") this.recovered("activate_option", action.label);
            const shown = action.type === "run_js" ? { value: outcome?.value } : this.verifiedCommands && outcome && typeof outcome === "object" ? ["fill_form", "options", "review"].includes(action.type) ? outcome : CommandRunner.shape(action, outcome) : null;
            const failed = shown?.verified === false || action.type === "fill_form" && shown && shown.done < shown.requested_count;
            results.push({
              index,
              ok: !failed,
              command_id: action.command_id,
              effect: "Input dispatched; verify committed result in next observation.",
              ...shown ? { result: boundedResult(shown) } : {},
              ...failed ? { detail: "The page did not show the requested value." } : {}
            });
            if (failed) break;
          } catch (error) {
            results.push({ index, command_id: action.command_id, ok: false, detail: String(error?.message).slice(0, 290) });
            break;
          }
          await sleep(ACTION_PAUSE_MS);
        }
        const looks = (res.actions ?? []).length ? res.actions.every((a) => ["review", "options", "observe", "read_page", "wait"].includes(a.type)) : Boolean(res.want_screenshot);
        this.progressGuard.noteReading(looks && results.every((r) => r.ok));
        {
          const failed = results.filter((r) => !r.ok).map((r) => ({
            label: String(res.actions?.[r.index]?.label || res.actions?.[r.index]?.type || "a field").replace(/^(?:Filled|Filling|Chose|Typed|Selected)\s+/i, ""),
            tried: typeof res.actions?.[r.index]?.text === "string" ? res.actions[r.index].text.slice(0, 60) : "",
            error: String(r.detail ?? "").slice(0, 200)
          }));
          this.progressGuard.noteFailures(failed.map((f) => f.label), failed);
        }
        if (res.status === "ready_for_review") {
          this.status = "ready";
          const captchaPending = observation.blockers.includes("captcha") && !captchaClearedFor;
          this.emit({ captchaPending, readiness: readinessOf(observation, refs) });
          await this.report("filled", res, this.url);
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
            const view = comboView(observation);
            const choices = await questionChoices(this.driver, refs, frames, view, res.question);
            const target = view.elements.find((e) => e.ref === String(res.question.ref ?? "").replace(/^g\d+:/, ""));
            const label = target && (target.group || target.name);
            const contextualLabel = label && target.section && /^(?:name|title|date|description)$/i.test(label.trim()) ? `${target.section}: ${label}` : label;
            this.last.question = { ...res.question, choices, role: questionRole(view, res.question), ...contextualLabel ? { label: contextualLabel } : {} };
          }
          this.status = "waiting";
          this.emit();
          const input = await this.waitForUser();
          if (input.kind === "stop") break;
          this.status = "running";
          if (input.kind === "reply") extra = { user_reply: input.text };
          else if (input.kind === "skip") extra = { skip_question: true };
          else extra = { resumed: true };
          wantScreenshot = true;
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
      if (!unsupported(error)) await this.report("failed", { failure_code: "unknown", message }, this.url).catch(() => {
      });
    } finally {
      await this.driver.detach();
    }
  }
}
export {
  Agent,
  ProgressGuard,
  comboView,
  execute,
  executing,
  explain,
  hasApplicationFields,
  isEditingInstruction,
  observeTab,
  questionChoices,
  questionRole,
  settle,
  stepWithRetry,
  transientStepError,
  withDeadline
};
