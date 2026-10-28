// The in-frame half of the form agent. The background service worker injects fill.js and this
// file into an isolated world of every frame through the debugger, then calls these functions:
// observe() describes the frame's form, the rest locate elements for trusted clicks and typing.
// Pure DOM logic with no chrome.* calls, so test/agent-page.test.mjs runs it in jsdom.
//
// It never submits: clicks come from the background only after the platform's policy has
// vetted them, and it refuses a click on the final submit button itself (clickable()).

(() => {
  const F = globalThis.JobHuntFill;
  const REF = "data-applyshortly-ref";
  const PANEL_TAG = "JOBHUNT-AUTOFILL-PANEL";
  // Visible challenges only (same list as the platform's services/apply/blockers.py).
  const CAPTCHA = [
    "iframe[src*='recaptcha/api2/bframe']",
    "iframe[src*='recaptcha'][title*='challenge' i]",
    "iframe[src*='hcaptcha.com'][title*='challenge' i]",
    ".g-recaptcha:not([data-size='invisible'])",
    ".h-captcha",
    "iframe[src*='challenges.cloudflare.com']",
    "input:not([type='hidden'])[name='captcha' i]",
    "input:not([type='hidden'])[id='captcha' i]",
  ];
  const LOGIN_URL = /\/(login|signin|sign_in|sign-in)\b|\/auth\//i;
  const BUTTONS = 'button, input[type=submit], input[type=button], [role="button"], [role="tab"], [role="link"]';
  // Links worth showing: the rest of a careers site's navigation is noise for the planner.
  const ACTION_LINK = /apply|next|continue|review|upload|attach|add |add$|accept|agree|close|dismiss|got it|start|resume|\bcv\b|cookie|skip/i;
  // English, then French, Spanish/Portuguese, German, Italian and Dutch words that only send a
  // form. "Apply" words (postuler, bewerben) stay out: on a job page they open the form.
  const FINAL = /\b(submit|send)\b|\bsend (my )?application\b|\bfinish\b|\bcomplete (my )?application\b|\b(envoyer|soumettre|valider|enviar|submeter|absenden|abschicken|einreichen|invia|inviare|verzenden|versturen|indienen)\b/i;
  const EXTRA_TEXT = 'input[type=date], input[type=month], input[type=time], input[type=datetime-local], input[type=week], [contenteditable="true"], [contenteditable=""]';
  const MAX_ELEMENTS = 300;
  const MAX_TEXT = 1500;

  const clean = (s) => F.cleanLabel(s ?? "");
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  /** The document plus every open shadow root in it, so web-component forms are seen too. */
  function roots(doc) {
    const out = [doc];
    for (let i = 0; i < out.length; i++) {
      for (const el of out[i].querySelectorAll("*")) {
        if (el.shadowRoot && el.tagName !== PANEL_TAG) out.push(el.shadowRoot);
      }
    }
    return out;
  }

  function isVisible(el, checkLayout) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement ?? n.getRootNode?.().host) {
      if (n.hidden || n.tagName === PANEL_TAG) return false;
      const style = n.ownerDocument.defaultView?.getComputedStyle(n);
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    }
    return !checkLayout || el.getClientRects().length > 0;
  }

  function nextRef() {
    globalThis.__applyshortlyRefSeq = (globalThis.__applyshortlyRefSeq ?? 0) + 1;
    return String(globalThis.__applyshortlyRefSeq);
  }

  function refOf(el) {
    let ref = el.getAttribute(REF);
    if (!ref) {
      ref = nextRef();
      el.setAttribute(REF, ref);
    }
    return ref;
  }

  function find(ref) {
    for (const root of roots(document)) {
      const el = root.querySelector(`[${REF}="${String(ref).replace(/["\\]/g, "")}"]`);
      if (el) return el;
    }
    return null;
  }

  function contains(scope, el) {
    for (let n = el; n; n = n.parentNode ?? n.host) {
      if (n === scope) return true;
    }
    return false;
  }

  /** The open modal (LinkedIn Easy Apply, "Apply" pop-ups): the agent then works inside it only. */
  function activeDialog(doc, checkLayout) {
    const dialogs = roots(doc)
      .flatMap((r) => [...r.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')])
      .filter((d) => isVisible(d, checkLayout) && d.querySelector("input, select, textarea, button, [role=button]"));
    return dialogs.at(-1) ?? null;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect?.();
    const win = el.ownerDocument.defaultView;
    if (!r || (!r.width && !r.height)) return true; // no layout (tests) or hidden file inputs
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  }

  function buttonText(el) {
    return clean(el.getAttribute("aria-label") || (el.tagName === "INPUT" ? el.value : el.textContent) || el.getAttribute("title"));
  }

  function base(el, extra) {
    return {
      ref: refOf(el),
      in_viewport: inViewport(el),
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      ...extra,
    };
  }

  function invalidInfo(field) {
    const invalid = F.isInvalid(field);
    return invalid ? { invalid, error: clip(F.invalidReason(field) || "", 300) || null } : { invalid: false };
  }

  /** Field → observation elements: one per input, or one per option for radio groups. */
  function fieldElements(field) {
    const { el } = field;
    const label = clip(clean(field.label), 500);
    const required = Boolean(field.required);
    if (field.kind === "text") {
      const role = el.tagName === "TEXTAREA" ? "textarea" : "textbox";
      return [base(el, { role, name: label, input_type: el.type || "text", value: clip(el.value ?? "", 2000), required, ...invalidInfo(field) })];
    }
    if (field.kind === "select") {
      const chosen = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      const value = F.isEmpty(field) ? "" : clean(chosen?.text);
      return [base(el, { role: "select", name: label, value, required, options: field.options.filter((o) => !F.isPlaceholderOption(o.text)).slice(0, 100).map((o) => clip(o.text, 500)), ...invalidInfo(field) })];
    }
    if (field.kind === "radio") {
      return field.options.map((o) => base(o.el, {
        role: "radio",
        name: clip(o.text, 500),
        group: label,
        checked: field.aria ? o.el.getAttribute(field.pressed ? "aria-pressed" : "aria-checked") === "true" : Boolean(o.el.checked),
        required,
        ...invalidInfo(field),
      }));
    }
    if (field.kind === "checkbox") {
      if (field.options) {
        return field.options.map((o) => base(o.el, { role: "checkbox", name: clip(o.text, 500), group: label, checked: Boolean(o.el.checked), required }));
      }
      const checked = el.getAttribute("role") === "checkbox" ? el.getAttribute("aria-checked") === "true" : Boolean(el.checked);
      return [base(el, { role: "checkbox", name: label, checked, required })];
    }
    if (field.kind === "file") {
      return [base(el, { role: "file", name: label, value: el.files?.[0]?.name ?? "", required, in_viewport: true })];
    }
    if (field.kind === "dropdown") {
      const options = listedOptions(el).slice(0, 100).map((t) => clip(t, 500));
      return [base(el, { role: "combobox", name: label, value: clip(F.dropdownValue(field), 2000), required, options, ...invalidInfo(field) })];
    }
    return [];
  }

  /** The listbox(es) a dropdown names in aria-controls / aria-owns. */
  function ownedLists(el) {
    const doc = el.ownerDocument;
    return ["aria-controls", "aria-owns"]
      .map((a) => el.getAttribute(a))
      .filter(Boolean)
      .flatMap((ids) => ids.split(/\s+/))
      .map((id) => doc.getElementById(id))
      .filter(Boolean);
  }

  /** Answers without "-None-"/"Select…" entries or repeats. */
  function answerTexts(texts) {
    return [...new Set(texts.map(clean))].filter((t) => !F.isPlaceholderOption(t));
  }

  /**
   * A closed dropdown's options when the page keeps them in its listbox (Zoho Recruit's month and
   * year lists, or any list after its first opening). Empty when they only exist while open.
   */
  function listedOptions(el) {
    const options = ownedLists(el).flatMap((list) => [...list.querySelectorAll('[role="option"]')]);
    return answerTexts(options.filter((o) => o.getAttribute("aria-disabled") !== "true").map((o) => o.getAttribute("aria-label") || o.textContent));
  }

  /** Date/time inputs and rich-text editors, which fill.js leaves to the user. */
  function extraTextElements(root, scope, checkLayout) {
    return [...root.querySelectorAll(EXTRA_TEXT)]
      .filter((el) => (!scope || contains(scope, el)) && isVisible(el, checkLayout) && !el.disabled && !el.readOnly)
      .map((el) => {
        const rich = el.isContentEditable || el.hasAttribute("contenteditable");
        return base(el, {
          role: rich ? "textarea" : "textbox",
          name: clip(F.labelOf(el), 500),
          input_type: rich ? "richtext" : el.type,
          value: clip(rich ? clean(el.textContent) : el.value ?? "", 2000),
          required: el.required || el.getAttribute("aria-required") === "true",
        });
      });
  }

  function buttonElements(root, scope, checkLayout) {
    const out = [];
    for (const el of root.querySelectorAll(BUTTONS)) {
      if ((scope && !contains(scope, el)) || !isVisible(el, checkLayout) || el.closest?.("label")) continue;
      const name = clip(buttonText(el), 200);
      if (!name || el.type === "reset") continue;
      const submitType = el.matches("button[type=submit], input[type=submit]") || (el.tagName === "BUTTON" && !el.getAttribute("type") && el.form);
      out.push(base(el, { role: "button", name, submit_like: Boolean(submitType) || FINAL.test(name) }));
    }
    for (const el of root.querySelectorAll("a[href]")) {
      if ((scope && !contains(scope, el)) || !isVisible(el, checkLayout) || el.matches(BUTTONS)) continue;
      const name = clip(buttonText(el), 200);
      if (!name || name.length > 60 || !(scope || ACTION_LINK.test(name))) continue;
      out.push(base(el, { role: "link", name }));
    }
    return out;
  }

  function blockers(doc, checkLayout, isTop) {
    const found = [];
    if (CAPTCHA.some((sel) => [...doc.querySelectorAll(sel)].some((el) => isVisible(el, checkLayout)))) found.push("captcha");
    const password = roots(doc).some((r) => [...r.querySelectorAll("input[type=password]")].some((el) => isVisible(el, checkLayout)));
    if (password || (isTop && LOGIN_URL.test(new URL(doc.location?.href ?? "about:blank").pathname))) found.push("login");
    return found;
  }

  function pageText(scope) {
    const nodes = [...scope.querySelectorAll('h1, h2, h3, legend, [role="heading"], [role="alert"], .error, [class*="error-message" i]')];
    const parts = [];
    for (const n of nodes) {
      const t = clean(n.textContent);
      if (t && t.length <= 200 && !parts.includes(t)) parts.push(t);
    }
    return clip(parts.join(" | "), MAX_TEXT);
  }

  function errors(scope, checkLayout) {
    return [...scope.querySelectorAll('[role="alert"], .error-message, .invalid-feedback')]
      .filter((n) => isVisible(n, checkLayout))
      .map((n) => clip(clean(n.textContent), 300))
      .filter(Boolean)
      .slice(0, 10);
  }

  /**
   * This frame's view for the planner. isTop: the tab's main frame (URL-based sign-in detection,
   * scroll position). Elements of an open modal only, when one is open.
   */
  function observe({ checkLayout = true, isTop = true } = {}) {
    const doc = document;
    const dialog = activeDialog(doc, checkLayout);
    const scope = dialog ?? doc.body ?? doc.documentElement;
    const seen = new Set();
    const elements = [];
    const push = (items) => {
      for (const item of items) {
        if (seen.has(item.ref) || elements.length >= MAX_ELEMENTS) continue;
        seen.add(item.ref);
        elements.push(item);
      }
    };
    for (const root of roots(doc)) {
      const fields = F.collectFields(root, { checkLayout }).filter((f) => f.kind !== "picker" && (!dialog || contains(dialog, f.el)));
      for (const field of fields) push(fieldElements(field));
      push(extraTextElements(root, dialog, checkLayout));
    }
    for (const root of roots(doc)) push(buttonElements(root, dialog, checkLayout));
    const win = doc.defaultView;
    const scroller = doc.scrollingElement ?? doc.documentElement;
    return {
      url: doc.location?.href ?? "",
      title: clip(clean(doc.title), 300),
      dialog: dialog ? clip(clean(dialog.getAttribute("aria-label") || dialog.querySelector("h1, h2, h3, [role=heading]")?.textContent || "Dialog"), 300) : null,
      blockers: blockers(doc, checkLayout, isTop),
      errors: errors(scope, checkLayout),
      text: pageText(scope),
      elements,
      more_below: Boolean(isTop && scroller && scroller.scrollHeight > (win?.innerHeight ?? 0) + (win?.scrollY ?? 0) + 200),
    };
  }

  // ---------------------------------------------------------------- acting

  /** Scrolls the element into view and returns its box (this frame's viewport), or null. */
  function box(ref) {
    const el = find(ref);
    if (!el) return null;
    el.scrollIntoView?.({ block: "center", inline: "center" });
    const target = el.matches?.("input[type=radio], input[type=checkbox]") && !isVisible(el, true)
      ? (el.closest("label") ?? el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`) ?? el)
      : el;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  }

  /** Refuses the final submit even if it reached here: the user always sends the form. */
  function clickable(ref, checkLayout = true) {
    const el = find(ref);
    if (!el) return "That element is gone from the page.";
    const name = buttonText(el);
    const fields = F.collectFields(el.ownerDocument, { checkLayout }).length;
    if (fields >= 2 && FINAL.test(name)) return "Submitting is left to you.";
    return null;
  }

  /** Focus the field and select what it holds, so typing replaces it. Returns how to type. */
  function focusForTyping(ref) {
    const el = find(ref);
    if (!el) return { ok: false, detail: "That field is gone from the page." };
    el.scrollIntoView?.({ block: "center" });
    el.focus?.();
    if (el.isContentEditable) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const sel = el.ownerDocument.defaultView.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { ok: true, mode: "keys" };
    }
    // Date and time inputs don't take typed text reliably; their value is set directly.
    if (/^(date|month|time|datetime-local|week|color|range)$/.test(el.type)) return { ok: true, mode: "direct" };
    el.select?.();
    return { ok: true, mode: "keys" };
  }

  function setDirect(ref, value) {
    const el = find(ref);
    if (!el) return { ok: false, detail: "That field is gone from the page." };
    const win = el.ownerDocument.defaultView;
    const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, normaliseDate(el.type, value));
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return { ok: Boolean(el.value), detail: el.value ? null : `"${value}" isn't a valid ${el.type}` };
  }

  /** "05/01/2026", "Jan 5 2026" → "2026-01-05" for <input type=date>; others are left alone. */
  function normaliseDate(type, value) {
    const v = String(value).trim();
    if (type !== "date" && type !== "month") return v;
    // A month alone ("2020-12", how résumés and profiles store a job's dates) is a full date's
    // first day: a date box refuses it without a day.
    if (/^\d{4}-\d{2}$/.test(v)) return type === "month" ? v : `${v}-01`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return type === "month" ? v.slice(0, 7) : v;
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
    const parsed = dmy ? new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1])) : new Date(`${v} UTC`);
    if (Number.isNaN(parsed.getTime())) return v;
    const iso = parsed.toISOString().slice(0, 10);
    return type === "month" ? iso.slice(0, 7) : iso;
  }

  function blur(ref) {
    find(ref)?.blur?.();
    return true;
  }

  /** A native <select>: choose the matching option. Returns the chosen text, or a reason. */
  function selectNative(ref, answer) {
    const el = find(ref);
    if (!el) return { ok: false, detail: "That field is gone from the page." };
    if (el.tagName !== "SELECT") return { ok: false, native: false };
    const options = [...el.options].filter((o) => o.value !== "" && !F.isPlaceholderOption(o.text)).map((o) => ({ text: clean(o.text), el: o }));
    const option = F.chooseOption(options, answer);
    if (!option) return { ok: false, native: true, detail: `No option matches "${answer}". Options: ${options.slice(0, 15).map((o) => o.text).join(", ")}` };
    const win = el.ownerDocument.defaultView;
    el.value = option.el.value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return { ok: true, native: true, value: option.text };
  }

  /** Options showing for an open dropdown or typeahead (in its listbox, else anywhere visible). */
  // What the page showed just before a dropdown was opened (noteShown), for lists without roles.
  let shownBefore = null;
  function noteShown(checkLayout = true) {
    shownBefore = F.shownTexts(document, checkLayout);
    return true;
  }

  function visibleOptions(ref, checkLayout = true) {
    const el = find(ref);
    if (!el) return [];
    const doc = el.ownerDocument;
    const owned = ownedLists(el);
    const scopes = owned.length ? owned : roots(doc);
    let found = scopes
      .flatMap((s) => [...s.querySelectorAll('[role="option"], mat-option, li[id*="option" i], .pac-item')])
      .filter((o) => isVisible(o, checkLayout) && o.getAttribute("aria-disabled") !== "true");
    if (!found.length && shownBefore) found = F.appearedOptions(shownBefore, doc, checkLayout).map((o) => o.el);
    return found
      .slice(0, 100)
      .map((o) => ({ ref: refOf(o), text: clip(clean(o.getAttribute("aria-label") || o.textContent), 200) }));
  }

  /** The answers an open dropdown offers, for the panel to show as choices. */
  function shownChoices(ref, checkLayout = true) {
    return answerTexts(visibleOptions(ref, checkLayout).map((o) => o.text)).slice(0, 30);
  }

  /** The option to click for an answer among the showing ones; partial matches allowed. */
  function matchOption(ref, answer, checkLayout = true) {
    const options = visibleOptions(ref, checkLayout);
    const chosen = F.chooseOption(options, answer)
      ?? options.find((o) => o.text.toLowerCase().startsWith(String(answer).toLowerCase().slice(0, 12)));
    return chosen ? { ok: true, ref: chosen.ref, text: chosen.text } : { ok: false, options: options.map((o) => o.text).slice(0, 15) };
  }

  /** A file into an <input type=file>, or dropped on a drop zone that has none. */
  function attach(ref, base64, name, type) {
    const el = find(ref);
    if (!el) return { ok: false, detail: "That upload is gone from the page." };
    const win = el.ownerDocument.defaultView;
    const bytes = Uint8Array.from(win.atob(base64), (c) => c.charCodeAt(0));
    const file = new win.File([bytes], name, { type });
    const input = el.matches("input[type=file]") ? el : el.querySelector?.("input[type=file]");
    if (input) {
      F.attachFile(input, file);
      return { ok: Boolean(input.files?.length), value: name };
    }
    const dt = new win.DataTransfer();
    dt.items.add(file);
    for (const kind of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new win.DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return { ok: true, value: name };
  }

  /** What a field holds now, to report whether an action stuck. */
  function state(ref) {
    const el = find(ref);
    if (!el) return null;
    if (el.matches("input[type=checkbox], input[type=radio]")) return { checked: el.checked };
    if (el.getAttribute("role") === "checkbox" || el.getAttribute("role") === "radio") return { checked: el.getAttribute("aria-checked") === "true" };
    if (el.matches("input[type=file]")) return { value: el.files?.[0]?.name ?? "" };
    if (el.tagName === "SELECT") return { value: clean(el.options[el.selectedIndex]?.text) };
    if (el.isContentEditable) return { value: clean(el.textContent) };
    return { value: el.value ?? clean(el.textContent), invalid: el.getAttribute("aria-invalid") === "true" };
  }

  function scrollPage(direction) {
    const win = document.defaultView;
    win.scrollBy({ top: (direction === "up" ? -1 : 1) * Math.round(win.innerHeight * 0.8), behavior: "instant" });
    return true;
  }

  /** Resolves once the DOM has been quiet for quietMs (or after maxMs): the page settled. */
  function settle(quietMs = 400, maxMs = 4000) {
    return new Promise((resolve) => {
      const win = document.defaultView;
      let timer = win.setTimeout(done, quietMs);
      const cap = win.setTimeout(done, maxMs);
      const observer = new win.MutationObserver(() => {
        win.clearTimeout(timer);
        timer = win.setTimeout(done, quietMs);
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      function done() {
        observer.disconnect();
        win.clearTimeout(timer);
        win.clearTimeout(cap);
        resolve(document.readyState);
      }
    });
  }

  globalThis.JobHuntAgentPage = {
    observe,
    box,
    clickable,
    focusForTyping,
    setDirect,
    normaliseDate,
    blur,
    selectNative,
    visibleOptions,
    shownChoices,
    noteShown,
    matchOption,
    attach,
    state,
    scrollPage,
    settle,
  };
})();
