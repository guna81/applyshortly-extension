// The in-frame half of the form agent. The background service worker injects fill.js and this
// file into an isolated world of every frame through the debugger, then calls these functions:
// observe() describes the frame's form, the rest locate elements for trusted clicks and typing.
// Pure DOM logic with no chrome.* calls, so test/agent-page.test.mjs runs it in jsdom.
//
// It never submits: clicks come from the background only after the platform's policy has
// vetted them, and it refuses a click on the final submit button itself (clickable()).

(() => {
  const F = globalThis.JobHuntFill;
  const userEdited = new WeakSet();
  let executing = false;
  const trackEdit = (event) => {
    if (!executing && event.isTrusted && event.target?.nodeType === 1) userEdited.add(event.target);
  };
  document.addEventListener("input", trackEdit, true);
  document.addEventListener("change", trackEdit, true);
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
  const MAX_TEXT = 6000;

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
    // A phone number box and its country selector share the number's label as their group, so the
    // platform can treat them as one phone answer while each keeps its own element.
    const phone = field.phoneCountry ? field.label : field.phoneFor?.label;
    const group = phone ? { group: clip(clean(phone), 500) } : {};
    if (field.kind === "text") {
      const role = el.tagName === "TEXTAREA" ? "textarea" : "textbox";
      return [base(el, { role, name: label, input_type: el.type || "text", value: clip(el.value ?? "", 2000), required, ...group, ...invalidInfo(field) })];
    }
    if (field.kind === "select") {
      const chosen = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      const value = field.phoneFor ? F.countryText(field) : F.isEmpty(field) ? "" : clean(chosen?.text);
      return [base(el, { role: "select", name: label, value, required, ...group, options: field.options.filter((o) => !F.isPlaceholderOption(o.text)).slice(0, 100).map((o) => clip(o.text, 500)), ...invalidInfo(field) })];
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
      return [base(el, { role: "combobox", name: label, value: clip(field.phoneFor ? F.countryText(field) : F.dropdownValue(field), 2000), required, options, ...group, ...invalidInfo(field) })];
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

  function pageText(scope, checkLayout) {
    const nodes = [...scope.querySelectorAll('h1, h2, h3, legend, label, p, [role="heading"], [role="alert"], [aria-live], .error, [class*="error-message" i]')];
    const parts = [];
    for (const n of nodes) {
      if (!isVisible(n, checkLayout)) continue;
      const t = clean(n.textContent);
      if (t && t.length <= 500 && !parts.includes(t)) parts.push(t);
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
  /**
   * Visible but disabled controls (State unlocks only after Country is chosen). collectFields
   * skips them, so list them here with disabled: true: the planner should expect them to
   * enable after another answer, not conclude they are missing.
   */
  function disabledElements(root, scope, checkLayout) {
    const out = [];
    const SELECTOR = 'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=file]), textarea, select, [role="combobox"], [aria-haspopup="listbox"]';
    for (const el of root.querySelectorAll(SELECTOR)) {
      if ((scope && !contains(scope, el)) || !isVisible(el, checkLayout)) continue;
      if (!el.disabled && el.getAttribute("aria-disabled") !== "true") continue;
      const label = clip(clean(F.labelOf(el)), 500);
      if (!label) continue;
      out.push(base(el, {
        role: el.tagName === "SELECT" ? "select" : el.matches('[role="combobox"], [aria-haspopup="listbox"]') ? "combobox" : "textbox",
        name: label,
        value: "",
        required: F.isRequired(el),
      }));
    }
    return out;
  }

  const hiddenPanels = new Map();
  function snapshotState(hidden) {
    if (hidden) {
      for (const panel of document.querySelectorAll("jobhunt-autofill-panel")) {
        if (!(panel instanceof HTMLElement)) continue;
        if (!hiddenPanels.has(panel)) hiddenPanels.set(panel, [panel.style.getPropertyValue("visibility"), panel.style.getPropertyPriority("visibility")]);
        panel.style.setProperty("visibility", "hidden", "important");
      }
    } else {
      for (const [panel, [value, priority]] of hiddenPanels) {
        if (value) panel.style.setProperty("visibility", value, priority);
        else panel.style.removeProperty("visibility");
      }
      hiddenPanels.clear();
    }
  }

  // While an action runs the panel stays visible but lets the pointer through, so a click on a
  // control under it lands on the page and the panel does not flash on every action.
  const passedPanels = new Map();
  function passThrough(on) {
    if (on) {
      for (const panel of document.querySelectorAll("jobhunt-autofill-panel")) {
        if (!(panel instanceof HTMLElement) || passedPanels.has(panel)) continue;
        passedPanels.set(panel, [panel.style.getPropertyValue("pointer-events"), panel.style.getPropertyPriority("pointer-events")]);
        panel.style.setProperty("pointer-events", "none", "important");
      }
    } else {
      for (const [panel, [value, priority]] of passedPanels) {
        if (value) panel.style.setProperty("pointer-events", value, priority);
        else panel.style.removeProperty("pointer-events");
      }
      passedPanels.clear();
    }
  }

  function contextOf(el) {
    if (!el) return {};
    const section = el.closest('fieldset, section, [role="group"], [role="tabpanel"]');
    const heading = section?.querySelector('legend, h1, h2, h3, [role="heading"]');
    const r = el.getBoundingClientRect();
    const parts = [];
    let node = el.type === "radio" ? el.closest('fieldset, [role="radiogroup"]') || el : el;
    while (node && node !== document.body && parts.length < 8) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter((n) => n.tagName === node.tagName) : [node];
      parts.unshift(`${node.tagName}:${siblings.indexOf(node)}`);
      node = node.parentElement;
    }
    return { href: el.tagName === "A" ? clip(el.href || "", 2000) : null, identity: clip(parts.join("/"), 300), user_edited: userEdited.has(el), section: clip(clean(section?.getAttribute("aria-label") || heading?.textContent), 300), bounds: [r.x, r.y, r.width, r.height] };
  }

  // AX finds accessible controls that the form mapper does not yet recognize.
  function describeAccessible(el, role, name, observed) {
    if (!el || !isVisible(el, true) || observed.includes(el.getAttribute(REF))) return null;
    const dialog = activeDialog(document, true);
    if (dialog && !contains(dialog, el)) return null;
    const roles = { textField: "textbox", searchbox: "textbox", textfield: "textbox", popUpButton: "combobox" };
    role = roles[role] || role;
    if (!["textbox", "textarea", "combobox", "listbox", "option", "button", "link", "radio", "checkbox"].includes(role)) return null;
    return base(el, {
      ...contextOf(el), role, name: clip(clean(name || F.labelOf(el)), 500),
      value: clip(String(el.value ?? el.getAttribute("aria-valuetext") ?? ""), 2000),
      checked: el.checked ?? (el.getAttribute("aria-checked") === "true"),
      required: Boolean(el.required) || el.getAttribute("aria-required") === "true",
      invalid: el.getAttribute("aria-invalid") === "true",
      submit_like: el.type === "submit" || FINAL.test(name || ""),
    });
  }

  function prepareKey(ref, key) {
    const el = find(ref);
    if (!el) return false;
    // Escape with no list open reaches the page: most dialogs close on it, the application too.
    if (key === "Escape" && !pickerOpen(ref)) return false;
    const role = el.getAttribute("role");
    if (key === "Enter" && !["combobox", "listbox", "option"].includes(role) && el.tagName !== "SELECT") return false;
    if (clickable(ref)) return false;
    el.focus?.();
    return document.activeElement === el || el.getRootNode()?.activeElement === el;
  }

  function scrollControl(ref, direction) {
    const el = find(ref);
    if (!el) return false;
    let container = el;
    while (container && container !== document.body) {
      if (container.scrollHeight > container.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(container).overflowY)) {
        container.scrollBy({ top: (direction === "up" ? -1 : 1) * Math.max(100, container.clientHeight * .8), behavior: "instant" });
        return true;
      }
      container = container.parentElement;
    }
    return scrollPage(direction);
  }

  function hitTest(x, y, ref) {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot?.elementFromPoint) {
      const nested = el.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === el) break;
      el = nested;
    }
    const target = find(ref);
    return Boolean(target && el && (el === target || target.contains(el)) && !clickable(ref));
  }

  function observe({ checkLayout = true, isTop = true, extended = false, query = "" } = {}) {
    const doc = document;
    const dialog = activeDialog(doc, checkLayout);
    const scope = dialog ?? doc.body ?? doc.documentElement;
    const seen = new Set();
    const elements = [];
    const push = (items) => {
      for (const item of items) {
        if (extended && query && !JSON.stringify([item.name, item.group, item.options]).toLowerCase().includes(query.toLowerCase())) continue;
        if (seen.has(item.ref) || elements.length >= MAX_ELEMENTS) continue;
        seen.add(item.ref);
        elements.push(item);
      }
    };
    for (const root of roots(doc)) {
      const fields = F.collectFields(root, { checkLayout }).filter((f) => f.kind !== "picker" && (!dialog || contains(dialog, f.el)));
      for (const field of fields) push(fieldElements(field));
      push(extraTextElements(root, dialog, checkLayout));
      push(disabledElements(root, dialog, checkLayout));
    }
    for (const root of roots(doc)) push(buttonElements(root, dialog, checkLayout));
    if (extended) {
      for (const item of elements) Object.assign(item, contextOf(find(item.ref)));
    }
    const win = doc.defaultView;
    const scroller = doc.scrollingElement ?? doc.documentElement;
    return {
      ...(extended ? {
        document_id: (globalThis.__applyshortlyDocumentId ??= (crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join(""))),
        step_label: clip(clean(scope.querySelector('[aria-current="step"], [role="tab"][aria-selected="true"], h1, h2')?.textContent), 300),
        viewport_width: win.innerWidth || 0, viewport_height: win.innerHeight || 0,
        coverage: [
          ...(query ? ["Focused view; inspect the full page before completion."] : elements.length >= MAX_ELEMENTS ? ["Element limit reached; inspect sections separately."] : []),
          ...([...scope.querySelectorAll('[aria-busy="true"]')].some((el) => isVisible(el, checkLayout)) ? ["Page processing is still in progress."] : []),
        ],
      } : {}),
      url: doc.location?.href ?? "",
      title: clip(clean(doc.title), 300),
      dialog: dialog ? clip(clean(dialog.getAttribute("aria-label") || dialog.querySelector("h1, h2, h3, [role=heading]")?.textContent || "Dialog"), 300) : null,
      blockers: blockers(doc, checkLayout, isTop),
      errors: errors(scope, checkLayout),
      text: pageText(scope, checkLayout),
      elements,
      more_below: Boolean(isTop && scroller && scroller.scrollHeight > (win?.innerHeight ?? 0) + (win?.scrollY ?? 0) + 200),
    };
  }

  // ---------------------------------------------------------------- acting

  // Temporary ref labels for a requested screenshot. Never scroll or intercept input.
  function screenshotRefs(items = []) {
    clearScreenshotRefs();
    const layer = document.createElement("div");
    layer.setAttribute("data-applyshortly-screenshot-refs", "");
    // A manual popover joins the browser's top layer, so the labels show over a site's modal
    // (LinkedIn's Easy Apply) as well as over any z-index.
    layer.setAttribute("popover", "manual");
    layer.style.cssText = "position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;" +
      "background:transparent;overflow:visible;display:block;pointer-events:none;z-index:2147483647";
    const backdrop = document.createElement("style");
    backdrop.textContent = "[data-applyshortly-screenshot-refs]::backdrop{display:none!important}";
    layer.appendChild(backdrop);
    for (const { local, ref } of items) {
      const el = find(local);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const tag = document.createElement("span");
      tag.textContent = ref;
      tag.style.cssText = `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 15)}px;` +
        "background:#111;color:#fff;font:12px monospace;padding:1px 3px;border:1px solid #fff";
      layer.appendChild(tag);
    }
    document.documentElement.appendChild(layer);
    try { layer.showPopover?.(); } catch { /* no Popover API: the z-index still applies */ }
  }

  function clearScreenshotRefs() {
    document.querySelectorAll("[data-applyshortly-screenshot-refs]").forEach((el) => el.remove());
  }

  /**
   * Scrolls only when the element is not fully in view: a field already on screen stays put, so
   * filling a form doesn't jump the page back and forth between fields.
   */
  function revealIfHidden(el, options) {
    const r = el.getBoundingClientRect?.();
    const win = el.ownerDocument?.defaultView;
    if (r && win && (r.width || r.height) && r.top >= 0 && r.left >= 0 && r.bottom <= win.innerHeight && r.right <= win.innerWidth) return;
    el.scrollIntoView?.(options);
  }

  /** Scrolls the element into view if needed and returns its box (this frame's viewport), or null. */
  function box(ref) {
    const el = find(ref);
    if (!el) return null;
    revealIfHidden(el, { block: "center", inline: "center" });
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
    revealIfHidden(el, { block: "center" });
    el.focus?.({ preventScroll: true });
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

  /**
   * The suggestion to commit after typing into a box that turned out to be a pick-one
   * typeahead (a "Search…" country box): typing alone is dropped by the page, and dependent
   * fields unlock only when a suggestion is clicked. { ok: false } for a plain text answer,
   * which stays as typed. noteShown must run before the typing for boxes without ARIA roles.
   */
  function typedSuggestion(ref, answer, checkLayout = true) {
    const el = find(ref);
    if (!el) return { ok: false };
    let options;
    if (el.matches?.('[role="combobox"], [aria-haspopup], [aria-expanded], [aria-controls], [aria-owns]')) {
      options = visibleOptions(ref, checkLayout);
    } else {
      // A plain box: trust only what appeared since noteShown, in response to the typing. One
      // item is enough here (typing often narrows the list to the single match); chooseOption
      // still has to match the answer before anything is clicked.
      if (!shownBefore) return { ok: false };
      const items = [];
      for (const leaf of F.shownTexts(document, checkLayout)) {
        if (shownBefore.has(leaf)) continue;
        let item = leaf;
        while (item.parentElement && item.parentElement !== document.body && item.parentElement.childElementCount === 1) item = item.parentElement;
        if (!items.includes(item)) items.push(item);
      }
      options = items.map((item) => ({ ref: refOf(item), text: clip(clean(item.textContent), 200) }));
    }
    const chosen = F.chooseOption(options, answer)
      ?? options.find((o) => o.text.toLowerCase().startsWith(String(answer).toLowerCase().slice(0, 12)));
    return chosen ? { ok: true, ref: chosen.ref, text: chosen.text } : { ok: false };
  }

  /**
   * Scrolls a virtualized option list (only the options in view are rendered) one page further,
   * from the top when restart is set. False when there is nothing more to scroll.
   */
  function scrollOptions(ref, restart = false, checkLayout = true) {
    const first = visibleOptions(ref, checkLayout)[0];
    let scroller = first ? find(first.ref)?.parentElement : null;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
    if (!scroller) return false;
    if (restart) {
      scroller.scrollTop = 0;
      return true;
    }
    const at = scroller.scrollTop;
    scroller.scrollTop = at + Math.max(40, scroller.clientHeight * 0.8);
    return scroller.scrollTop !== at;
  }

  /**
   * Whether the field's own list is showing: Escape then closes that list. With nothing open,
   * Escape goes to the page, and dialogs (an Apply pop-up with the whole form) close on it.
   */
  function pickerOpen(ref, checkLayout = true) {
    const el = find(ref);
    if (!el) return false;
    const opener = el.closest?.('[aria-expanded]') ?? el;
    if (opener.getAttribute?.("aria-expanded") === "true" || el.getAttribute?.("aria-expanded") === "true") return true;
    if (ownedLists(el).some((list) => isVisible(list, checkLayout))) return true;
    return visibleOptions(ref, checkLayout).length > 0;
  }

  /** Whether `text` shows anywhere visible in this frame (wait_for). */
  function hasText(text, checkLayout = true) {
    const wanted = clean(text).toLowerCase();
    if (!wanted) return false;
    return roots(document).some((root) => [...root.querySelectorAll("*")].some((n) =>
      n.tagName !== PANEL_TAG && !["SCRIPT", "STYLE"].includes(n.tagName) &&
      [...n.childNodes].some((c) => c.nodeType === 3 && clean(c.textContent).toLowerCase().includes(wanted)) &&
      isVisible(n, checkLayout)));
  }

  /** A file into an <input type=file>, or dropped on a drop zone that has none. */
  async function attach(ref, base64, name, type) {
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
    // A drop zone that ignores synthetic drops shows nothing: report it rather than "attached".
    // Only the zone itself and its immediate container: another field's upload never counts.
    const around = el.parentElement ?? el;
    const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
    for (let waited = 0; waited <= 1500; waited += 150) {
      const taken = [...el.querySelectorAll("input[type=file]")].some((i) => i.files?.length) ||
        clean(around.textContent).toLowerCase().includes(stem);
      if (taken) return { ok: true, value: name };
      await new Promise((resolve) => win.setTimeout(resolve, 150));
    }
    return { ok: false, detail: "The drop area didn't take the file. Attach it yourself, then continue." };
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
    describeAccessible,
    hitTest,
    prepareKey,
    snapshotState,
    executionState: (value) => { executing = value; passThrough(value); },
    freshState: (ref) => {
      const el = find(ref);
      return { document_id: globalThis.__applyshortlyDocumentId, user_edited: Boolean(el && userEdited.has(el)), value: el?.value ?? el?.getAttribute("aria-valuetext") ?? null };
    },
    scrollControl,
    screenshotRefs,
    clearScreenshotRefs,
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
    typedSuggestion,
    scrollOptions,
    attach,
    pickerOpen,
    hasText,
    state,
    scrollPage,
    settle,
  };
})();
