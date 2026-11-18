(() => {
  const F = globalThis.JobHuntFill;
  const userEdited = /* @__PURE__ */ new WeakSet();
  let executing = false;
  const trackEdit = (event) => {
    if (!executing && event.isTrusted && event.target?.nodeType === 1) userEdited.add(event.target);
  };
  document.addEventListener("input", trackEdit, true);
  document.addEventListener("change", trackEdit, true);
  const REF = "data-applyshortly-ref";
  const PANEL_TAG = "JOBHUNT-AUTOFILL-PANEL";
  const CAPTCHA = [
    "iframe[src*='recaptcha/api2/bframe']",
    "iframe[src*='recaptcha'][title*='challenge' i]",
    "iframe[src*='hcaptcha.com'][title*='challenge' i]",
    ".g-recaptcha:not([data-size='invisible'])",
    ".h-captcha:not([data-size='invisible'])",
    "iframe[src*='challenges.cloudflare.com']",
    "input:not([type='hidden'])[name='captcha' i]",
    "input:not([type='hidden'])[id='captcha' i]"
  ];
  const LOGIN_URL = /\/(login|signin|sign_in|sign-in)\b|\/auth\//i;
  const BUTTONS = 'button, input[type=submit], input[type=button], [role="button"], [role="tab"], [role="link"]';
  const ACTION_LINK = /apply|next|continue|review|upload|attach|add |add$|accept|agree|close|dismiss|got it|start|resume|\bcv\b|cookie|skip/i;
  const FINAL = /\b(submit|send)\b|\bsend (my )?application\b|\bfinish\b|\bcomplete (my )?application\b|\b(envoyer|soumettre|valider|enviar|submeter|absenden|abschicken|einreichen|invia|inviare|verzenden|versturen|indienen)\b/i;
  const EXTRA_TEXT = 'input[type=date], input[type=month], input[type=time], input[type=datetime-local], input[type=week], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const MAX_ELEMENTS = 300;
  const MAX_TEXT = 6e3;
  const clean = (s) => F.cleanLabel(s ?? "");
  const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
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
  function activeDialog(doc, checkLayout) {
    const dialogs = roots(doc).flatMap((r) => [...r.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')]).filter((d) => isVisible(d, checkLayout) && d.querySelector("input, select, textarea, button, [role=button]"));
    return dialogs.at(-1) ?? null;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect?.();
    const win = el.ownerDocument.defaultView;
    if (!r || !r.width && !r.height) return true;
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  }
  function buttonText(el) {
    return clean(el.getAttribute("aria-label") || (el.tagName === "INPUT" ? el.value : el.textContent) || el.getAttribute("title"));
  }
  function ariaState(el) {
    const out = {};
    for (const [key, attr] of [["pressed", "aria-pressed"], ["selected", "aria-selected"], ["expanded", "aria-expanded"]]) {
      const value = el.getAttribute?.(attr);
      if (value === "true" || value === "false") out[key] = value === "true";
    }
    return out;
  }
  function selectedChips(el) {
    if (!el.matches?.('input[role="combobox"]')) return "";
    for (let box2 = el.parentElement, depth = 0; box2 && depth < 6 && !box2.matches("form, body, html"); box2 = box2.parentElement, depth++) {
      if (box2.querySelectorAll('input[role="combobox"], select').length > 1) break;
      const labels = [...box2.querySelectorAll('[class*="multi-value__label" i], [class*="multiValueLabel" i]')].map((label) => clean(label.textContent)).filter(Boolean);
      if (labels.length) return [...new Set(labels)].join(", ");
    }
    return "";
  }
  function base(el, extra) {
    const picked = selectedChips(el);
    return {
      ref: refOf(el),
      in_viewport: inViewport(el),
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      ...ariaState(el),
      ...extra,
      ...picked ? { value: clip(picked, 2e3) } : {}
    };
  }
  function invalidInfo(field) {
    const invalid = F.isInvalid(field);
    return invalid ? { invalid, error: clip(F.invalidReason(field) || "", 300) || null } : { invalid: false };
  }
  const GENERIC_UPLOAD = /^(?:attach|upload|choose|browse|select|add)(?: a| your)?(?: file| document| resume| cv)?s?\W*$/i;
  function uploadGroupLabel(el, label) {
    if (label && !GENERIC_UPLOAD.test(label.trim())) return { name: label, required: false };
    const group = el.closest('[role="group"][aria-labelledby], fieldset');
    const ids = group?.getAttribute?.("aria-labelledby");
    const text = ids ? ids.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : group?.querySelector?.("legend")?.textContent ?? "";
    const name = clip(clean(text), 500);
    return name ? { name, required: /\*\s*$/.test(text.trim()) } : { name: label, required: false };
  }
  const ATTACHED_FILE = /^[^\\/\n]{1,200}\.(?:pdf|docx?|rtf|txt|odt|pages)$/i;
  const REMOVE_FILE = /^(?:remove|delete|clear)\b/i;
  function uploadedFileName(input) {
    if (input.files?.length) return input.files[0].name;
    for (let area = input.parentElement, depth = 0; area && depth < 5; area = area.parentElement, depth++) {
      if (area.matches("form, body, html") || area.querySelectorAll("input[type=file]").length !== 1 || area.querySelector("input:not([type=file]):not([type=hidden]), textarea, select")) break;
      const replacement = [...area.querySelectorAll('button, [role="button"], label, a')].some((node) => isVisible(node, false) && /^(?:replace\s+file|remove\b|delete\b|clear\b)/i.test(clean(node.textContent || node.getAttribute("aria-label") || "")));
      if (!replacement) continue;
      const names = [...area.querySelectorAll("span, a, p, div")].filter((node) => !node.children.length && isVisible(node, false)).map((node) => clean(node.textContent)).filter((name) => ATTACHED_FILE.test(name));
      if (new Set(names).size === 1) return names[0];
    }
    return "";
  }
  function attachedUploadElements(root, scope, checkLayout) {
    const out = [];
    for (const group of root.querySelectorAll('[role="group"][aria-labelledby], fieldset')) {
      if (scope && !contains(scope, group) || !isVisible(group, checkLayout) || group.querySelector("input[type=file]")) continue;
      const removers = [...group.querySelectorAll('button, [role="button"]')].filter((b) => REMOVE_FILE.test(buttonText(b)));
      if (removers.length !== 1) continue;
      const shown = [...group.querySelectorAll("p, span, a, div")].map((n) => n.children.length ? "" : clean(n.textContent)).filter((t) => ATTACHED_FILE.test(t));
      const named = uploadGroupLabel(group, "");
      if (shown.length !== 1 || !named.name) continue;
      out.push(base(group, { role: "file", name: named.name, value: clip(shown[0], 300), required: named.required || group.getAttribute("aria-required") === "true", in_viewport: true }));
    }
    return out;
  }
  function fieldElements(field) {
    const { el } = field;
    const label = clip(clean(field.label), 500);
    const required = Boolean(field.required || field.options?.some((o) => o.el.required || o.el.getAttribute("aria-required") === "true" || o.el.querySelector?.('input[required], input[aria-required="true"]')));
    const phone = field.phoneCountry ? field.label : field.phoneFor?.label;
    const group = phone ? { group: clip(clean(phone), 500) } : {};
    if (field.kind === "text") {
      const rich = el.hasAttribute("contenteditable");
      const role = el.tagName === "TEXTAREA" || rich ? "textarea" : "textbox";
      const picked = el.value ? "" : F.widgetPick(el);
      const cap = Number.isInteger(el.maxLength) && el.maxLength > 0 && el.maxLength < 1e6 ? { text_limit: el.maxLength } : {};
      const mode = el.inputMode ? { input_mode: clip(el.inputMode, 20) } : {};
      const pat = el.getAttribute?.("pattern") ? { pattern: clip(el.getAttribute("pattern"), 200) } : {};
      return [base(el, {
        role,
        name: label,
        input_type: rich ? "richtext" : el.type || "text",
        value: clip(rich ? clean(F.textValue(el)) : el.value || picked || "", 2e3),
        required,
        ...el.matches('[role="combobox"]') ? { popup: true } : {},
        ...group,
        ...cap,
        ...mode,
        ...pat,
        ...invalidInfo(field)
      })];
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
        ...invalidInfo(field)
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
      const named = uploadGroupLabel(el, label);
      return [base(el, { role: "file", name: named.name, value: uploadedFileName(el), required: required || named.required, in_viewport: true })];
    }
    if (field.kind === "dropdown") {
      const options = listedOptions(el).slice(0, 100).map((t) => clip(t, 500));
      return [base(el, { role: "combobox", name: label, value: clip(field.phoneFor ? F.countryText(field) : F.dropdownValue(field), 2e3), required, options, ...group, ...invalidInfo(field) })];
    }
    return [];
  }
  function ownedLists(el) {
    const doc = el.ownerDocument;
    return ["aria-controls", "aria-owns"].map((a) => el.getAttribute(a)).filter(Boolean).flatMap((ids) => ids.split(/\s+/)).map((id) => doc.getElementById(id)).filter(Boolean);
  }
  function answerTexts(texts) {
    return [...new Set(texts.map(clean))].filter((t) => !F.isPlaceholderOption(t));
  }
  function listedOptions(el) {
    const options = ownedLists(el).flatMap((list) => [...list.querySelectorAll('[role="option"]')]);
    return answerTexts(options.filter((o) => o.getAttribute("aria-disabled") !== "true").map((o) => o.getAttribute("aria-label") || o.textContent));
  }
  function extraTextElements(root, scope, checkLayout) {
    return [...root.querySelectorAll(EXTRA_TEXT)].filter((el) => (!scope || contains(scope, el)) && isVisible(el, checkLayout) && !el.disabled && !el.readOnly).map((el) => {
      const rich = el.isContentEditable || el.hasAttribute("contenteditable");
      return base(el, {
        role: rich ? "textarea" : "textbox",
        name: clip(F.labelOf(el), 500),
        input_type: rich ? "richtext" : el.type,
        value: clip(rich ? clean(el.textContent) : el.value ?? "", 2e3),
        required: el.required || el.getAttribute("aria-required") === "true"
      });
    });
  }
  function buttonElements(root, scope, checkLayout) {
    const out = [];
    for (const el of root.querySelectorAll(BUTTONS)) {
      if (scope && !contains(scope, el) || !isVisible(el, checkLayout) || el.closest?.("label")) continue;
      const name = clip(buttonText(el), 200);
      if (!name || el.type === "reset") continue;
      const submitType = el.matches("button[type=submit], input[type=submit]") || el.tagName === "BUTTON" && !el.getAttribute("type") && el.form;
      out.push(base(el, { role: "button", name, submit_like: Boolean(submitType) || FINAL.test(name), ...choiceInfo(el) }));
    }
    for (const el of root.querySelectorAll("a[href]")) {
      if (scope && !contains(scope, el) || !isVisible(el, checkLayout) || el.matches(BUTTONS)) continue;
      const name = clip(buttonText(el), 200);
      if (!name || name.length > 60 || !(scope || ACTION_LINK.test(name))) continue;
      out.push(base(el, { role: "link", name }));
    }
    return out;
  }
  const CHOICE_STATE = ["aria-pressed", "aria-checked", "aria-selected"];
  function choiceInfo(el) {
    const attr = CHOICE_STATE.find((a) => el.hasAttribute?.(a));
    const parent = el.parentElement;
    if (!attr || !parent) return {};
    const members = [...parent.children].filter((n) => n.hasAttribute?.(attr));
    if (members.length < 2 || members.length > 6) return {};
    let label = "";
    let required = false;
    for (let node = parent, depth = 0; node && node !== document.body && depth < 4 && !label; node = node.parentElement, depth++) {
      const ids = node.getAttribute?.("aria-labelledby");
      const named = ids ? ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : node.getAttribute?.("aria-label") || "";
      const prior = [...node.parentElement?.children ?? []].slice(0, [...node.parentElement?.children ?? []].indexOf(node)).reverse();
      const heading = node.matches?.("fieldset") ? node.querySelector("legend") : prior.find((n) => n.matches?.("label, legend, h1, h2, h3, h4, h5, h6, p, [class*=title i], [class*=label i], [class*=question i]") && !n.querySelector?.("button, input, select, textarea"));
      const raw = String(named || heading?.textContent || "");
      label = clean(raw);
      if (label) {
        required = node.getAttribute?.("aria-required") === "true" || /\*\s*$/.test(raw.trim()) || /required/i.test(`${heading?.className ?? ""} ${node.className ?? ""}`) || Boolean(heading?.querySelector?.("[class*=required i], [aria-label*=required i]"));
      }
    }
    return label && label.length <= 500 ? { group: label, required } : {};
  }
  function genericElements(root, scope, checkLayout) {
    const selector = '[role="switch"], [role="slider"], [role="spinbutton"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="treeitem"], [aria-pressed]:not(button):not([role="button"]):not([role="radio"])';
    const out = [];
    for (const el of root.querySelectorAll(selector)) {
      if (scope && !contains(scope, el) || !isVisible(el, checkLayout) || el.closest?.("label") || el.matches("input") && el.type === "hidden") continue;
      const role = el.getAttribute("role") || "button";
      const name = clip(buttonText(el) || clean(F.labelOf(el)), 300);
      if (!name) continue;
      const checked = el.hasAttribute("aria-checked") ? { checked: el.getAttribute("aria-checked") === "true" } : {};
      const value = ["slider", "spinbutton"].includes(role) ? { value: clip(String(el.value ?? el.getAttribute("aria-valuenow") ?? el.getAttribute("aria-valuetext") ?? ""), 100) } : {};
      out.push(base(el, { role, name, ...checked, ...value, required: el.getAttribute("aria-required") === "true", ...choiceInfo(el) }));
    }
    return out;
  }
  function blockers(doc, checkLayout, isTop) {
    const found = [];
    if (CAPTCHA.some((sel) => [...doc.querySelectorAll(sel)].some((el) => isVisible(el, checkLayout)))) found.push("captcha");
    const password = roots(doc).some((r) => [...r.querySelectorAll("input[type=password]")].some((el) => isVisible(el, checkLayout)));
    if (password || isTop && LOGIN_URL.test(new URL(doc.location?.href ?? "about:blank").pathname)) found.push("login");
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
    return [...scope.querySelectorAll('[role="alert"], .error-message, .invalid-feedback')].filter((n) => isVisible(n, checkLayout)).map((n) => clip(clean(n.textContent), 300)).filter(Boolean).slice(0, 10);
  }
  function disabledElements(root, scope, checkLayout) {
    const out = [];
    const SELECTOR = 'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=file]), textarea, select, [role="combobox"], [aria-haspopup="listbox"]';
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (scope && !contains(scope, el) || !isVisible(el, checkLayout)) continue;
      if (!el.disabled && el.getAttribute("aria-disabled") !== "true") continue;
      const label = clip(clean(F.labelOf(el)), 500);
      if (!label) continue;
      out.push(base(el, {
        role: el.tagName === "SELECT" ? "select" : el.matches('[role="combobox"], [aria-haspopup="listbox"]') ? "combobox" : "textbox",
        name: label,
        value: "",
        required: F.isRequired(el)
      }));
    }
    return out;
  }
  const hiddenPanels = /* @__PURE__ */ new Map();
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
  const passedPanels = /* @__PURE__ */ new Map();
  function passThrough(on) {
    if (on) {
      for (const panel of document.querySelectorAll("jobhunt-autofill-panel")) {
        if (!(panel instanceof HTMLElement) || passedPanels.has(panel)) continue;
        passedPanels.set(panel, [panel.style.getPropertyValue("pointer-events"), panel.style.getPropertyPriority("pointer-events")]);
        panel.setAttribute("data-applyshortly-executing", "");
        panel.style.setProperty("pointer-events", "none", "important");
      }
    } else {
      for (const [panel, [value, priority]] of passedPanels) {
        if (value) panel.style.setProperty("pointer-events", value, priority);
        else panel.style.removeProperty("pointer-events");
        panel.removeAttribute("data-applyshortly-executing");
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
    return { href: el.tagName === "A" ? clip(el.href || "", 2e3) : null, identity: clip(parts.join("/"), 300), user_edited: userEdited.has(el), section: clip(clean(section?.getAttribute("aria-label") || heading?.textContent), 300), bounds: [r.x, r.y, r.width, r.height] };
  }
  function shownChoice(el) {
    if (el.getAttribute("role") !== "combobox" || el.matches("input, textarea, select")) return "";
    const text = clean(el.textContent);
    return /^[\s-]*(select|choose|please select|pick|find an option)\b/i.test(text) ? "" : text;
  }
  function describeAccessible(el, role, name, observed) {
    if (!el || !F.applicationControl(el) || !isVisible(el, true) || observed.includes(el.getAttribute(REF))) return null;
    const dialog = activeDialog(document, true);
    if (dialog && !contains(dialog, el)) return null;
    const roles = { textField: "textbox", searchbox: "textbox", textfield: "textbox", popUpButton: "combobox" };
    role = roles[role] || role;
    if (["radio", "checkbox"].includes(role) && [...el.querySelectorAll(`[${REF}]`)].some((n) => observed.includes(n.getAttribute(REF)))) return null;
    if (!["textbox", "textarea", "combobox", "listbox", "option", "button", "link", "radio", "checkbox"].includes(role)) return null;
    return base(el, {
      ...contextOf(el),
      role,
      name: clip(clean(name || F.labelOf(el)), 500),
      // AX-only controls still need their native type: otherwise a search or password input
      // becomes an ordinary textbox when the platform extracts application questions.
      ...el.tagName === "INPUT" ? { input_type: el.type } : {},
      // A rich-text box (a div with contenteditable) has no `value`: it holds its text.
      // A search-style combobox (react-select) keeps its input empty and shows the pick beside it, so an empty value falls through to what the widget shows, as the main scan does.
      value: clip(el.isContentEditable ? clean(el.textContent) : String(el.value || F.widgetPick(el) || el.getAttribute("aria-valuetext") || shownChoice(el) || ""), 2e3),
      // Only a checkable control has a checked state; a combobox or button reporting checked:false reads as an unanswered choice.
      ...["radio", "checkbox"].includes(role) ? { checked: el.checked ?? el.getAttribute("aria-checked") === "true" } : {},
      required: Boolean(el.required) || el.getAttribute("aria-required") === "true",
      invalid: el.getAttribute("aria-invalid") === "true",
      submit_like: el.type === "submit" || FINAL.test(name || "")
    });
  }
  function prepareKey(ref, key) {
    const el = find(ref);
    if (!el) return false;
    if (key === "Escape" && !pickerOpen(ref)) return false;
    const role = el.getAttribute("role");
    if (key === "Enter" && !["combobox", "listbox", "option"].includes(role) && el.tagName !== "SELECT") return false;
    if (key === "Enter" && el.tagName === "INPUT" && !listShown(el)) return false;
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
        container.scrollBy({ top: (direction === "up" ? -1 : 1) * Math.max(100, container.clientHeight * 0.8), behavior: "instant" });
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
  function activateOption(ref) {
    const el = find(ref);
    if (!el) return { ok: false, detail: "That element is gone from the page." };
    const refusal = clickable(ref, false);
    if (refusal) return { ok: false, detail: refusal };
    if (el.disabled || el.getAttribute?.("aria-disabled") === "true") return { ok: false, detail: "That option is disabled." };
    if (el.closest?.("a[href], button[type=submit], input[type=submit]")) return { ok: false, detail: "That option is a link or a submit control." };
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(type.startsWith("pointer") && typeof PointerEvent === "function" ? new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
    }
    return { ok: true };
  }
  function observe({ checkLayout = true, isTop = true, extended = false, query = "" } = {}) {
    const doc = document;
    const dialog = activeDialog(doc, checkLayout);
    const scope = dialog ?? doc.body ?? doc.documentElement;
    const seen = /* @__PURE__ */ new Set();
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
      push(attachedUploadElements(root, dialog, checkLayout));
    }
    elements.sort((a, b) => {
      const x = find(a.ref), y = find(b.ref);
      if (!x || !y || x === y) return 0;
      const place = x.compareDocumentPosition(y);
      return place & 4 ? -1 : place & 2 ? 1 : 0;
    });
    for (const root of roots(doc)) push(buttonElements(root, dialog, checkLayout));
    for (const root of roots(doc)) push(genericElements(root, dialog, checkLayout));
    if (extended) {
      for (const item of elements) Object.assign(item, contextOf(find(item.ref)));
    }
    const win = doc.defaultView;
    const scroller = doc.scrollingElement ?? doc.documentElement;
    return {
      ...extended ? {
        document_id: globalThis.__applyshortlyDocumentId ??= crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join(""),
        step_label: clip(clean(scope.querySelector('[aria-current="step"], [role="tab"][aria-selected="true"], h1, h2')?.textContent), 300),
        viewport_width: win.innerWidth || 0,
        viewport_height: win.innerHeight || 0,
        coverage: [
          ...query ? ["Focused view; inspect the full page before completion."] : elements.length >= MAX_ELEMENTS ? ["Element limit reached; inspect sections separately."] : [],
          ...[...scope.querySelectorAll('[aria-busy="true"]')].some((el) => isVisible(el, checkLayout)) ? ["Page processing is still in progress."] : []
        ]
      } : {},
      url: doc.location?.href ?? "",
      title: clip(clean(doc.title), 300),
      dialog: dialog ? clip(clean(dialog.getAttribute("aria-label") || dialog.querySelector("h1, h2, h3, [role=heading]")?.textContent || "Dialog"), 300) : null,
      blockers: blockers(doc, checkLayout, isTop),
      errors: errors(scope, checkLayout),
      text: pageText(scope, checkLayout),
      elements,
      more_below: Boolean(isTop && scroller && scroller.scrollHeight > (win?.innerHeight ?? 0) + (win?.scrollY ?? 0) + 200)
    };
  }
  function screenshotRefs(items = []) {
    clearScreenshotRefs();
    const layer = document.createElement("div");
    layer.setAttribute("data-applyshortly-screenshot-refs", "");
    layer.setAttribute("popover", "manual");
    layer.style.cssText = "position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;display:block;pointer-events:none;z-index:2147483647";
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
      tag.style.cssText = `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 15)}px;background:#111;color:#fff;font:12px monospace;padding:1px 3px;border:1px solid #fff`;
      layer.appendChild(tag);
    }
    document.documentElement.appendChild(layer);
    try {
      layer.showPopover?.();
    } catch {
    }
  }
  function clearScreenshotRefs() {
    document.querySelectorAll("[data-applyshortly-screenshot-refs]").forEach((el) => el.remove());
  }
  function revealIfHidden(el, options) {
    const r = el.getBoundingClientRect?.();
    const win = el.ownerDocument?.defaultView;
    if (r && win && (r.width || r.height) && r.top >= 0 && r.left >= 0 && r.bottom <= win.innerHeight && r.right <= win.innerWidth) return;
    el.scrollIntoView?.(options);
  }
  function box(ref) {
    const el = find(ref);
    if (!el) return null;
    revealIfHidden(el, { block: "center", inline: "center" });
    const target = el.matches?.("input[type=radio], input[type=checkbox]") && !isVisible(el, true) ? el.closest("label") ?? el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`) ?? el : el;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  }
  function clickable(ref, checkLayout = true) {
    const el = find(ref);
    if (!el) return "That element is gone from the page.";
    const name = buttonText(el);
    const fields = F.collectFields(el.ownerDocument, { checkLayout }).length;
    if (FINAL.test(name) && (fields >= 1 || el.form)) return "Submitting is left to you.";
    return null;
  }
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
    if (/^(date|month|time|datetime-local|week|color|range)$/.test(el.type)) return { ok: true, mode: "direct" };
    el.select?.();
    return { ok: true, mode: "keys" };
  }
  function typedText(ref) {
    const el = find(ref);
    return el && "value" in el ? String(el.value ?? "") : "";
  }
  function activate(ref) {
    const el = find(ref);
    if (!el) return false;
    if (!el.matches?.("input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]")) return false;
    el.click();
    return true;
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
  function normaliseDate(type, value) {
    const v = String(value).trim();
    if (type !== "date" && type !== "month") return v;
    if (/^\d{4}-\d{2}$/.test(v)) return type === "month" ? v : `${v}-01`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return type === "month" ? v.slice(0, 7) : v;
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
    const parsed = dmy ? new Date(Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1])) : /* @__PURE__ */ new Date(`${v} UTC`);
    if (Number.isNaN(parsed.getTime())) return v;
    const iso = parsed.toISOString().slice(0, 10);
    return type === "month" ? iso.slice(0, 7) : iso;
  }
  function blur(ref) {
    find(ref)?.blur?.();
    return true;
  }
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
  let shownBefore = null;
  function noteShown(checkLayout = true) {
    shownBefore = F.shownTexts(document, checkLayout);
    return true;
  }
  function visibleOptions(ref, checkLayout = true, limit = 100) {
    const el = find(ref);
    if (!el) return [];
    const doc = el.ownerDocument;
    const owned = ownedLists(el);
    const scopes = owned.length ? owned : roots(doc);
    let found = scopes.flatMap((s) => [...s.querySelectorAll('[role="option"], mat-option, li[id*="option" i], .pac-item, .dropdown-location')]).filter((o) => isVisible(o, checkLayout) && o.getAttribute("aria-disabled") !== "true");
    if (!found.length && shownBefore) found = F.appearedOptions(shownBefore, doc, checkLayout).map((o) => o.el);
    return found.slice(0, limit).map((o) => ({ ref: refOf(o), text: clip(clean(o.getAttribute("aria-label") || o.textContent), 200) }));
  }
  function shownChoices(ref, checkLayout = true) {
    return answerTexts(visibleOptions(ref, checkLayout).map((o) => o.text)).slice(0, 30);
  }
  function matchOption(ref, answer, checkLayout = true) {
    const options = visibleOptions(ref, checkLayout, Infinity);
    const chosen = F.chooseOption(options, answer) ?? options.find((o) => o.text.toLowerCase().startsWith(String(answer).toLowerCase().slice(0, 12)));
    return chosen ? { ok: true, ref: chosen.ref, text: chosen.text } : { ok: false, options: options.map((o) => o.text).slice(0, 15) };
  }
  function firstOptionMatches(ref, answer) {
    const [first] = visibleOptions(ref, true, 3);
    if (!first) return { known: false, matches: false };
    const matches = Boolean(F.chooseOption([first], answer)) || first.text.toLowerCase().startsWith(String(answer).toLowerCase().slice(0, 12));
    return { known: true, matches };
  }
  function typedSuggestion(ref, answer, checkLayout = true) {
    const el = find(ref);
    if (!el) return { ok: false };
    let options;
    if (el.matches?.('[role="combobox"], [aria-haspopup], [aria-expanded], [aria-controls], [aria-owns]')) {
      options = visibleOptions(ref, checkLayout);
    } else {
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
    const chosen = F.chooseOption(options, answer) ?? options.find((o) => o.text.toLowerCase().startsWith(String(answer).toLowerCase().slice(0, 12)));
    return chosen ? { ok: true, ref: chosen.ref, text: chosen.text } : { ok: false };
  }
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
  function listShown(el) {
    const opener = el.closest?.("[aria-expanded]") ?? el;
    if (el.getAttribute?.("aria-expanded") === "true" || opener.getAttribute?.("aria-expanded") === "true") return true;
    return ownedLists(el).some((list) => isVisible(list, true));
  }
  function pickerOpen(ref, checkLayout = true) {
    const el = find(ref);
    if (!el) return false;
    const opener = el.closest?.("[aria-expanded]") ?? el;
    if (opener.getAttribute?.("aria-expanded") === "true" || el.getAttribute?.("aria-expanded") === "true") return true;
    if (ownedLists(el).some((list) => isVisible(list, checkLayout))) return true;
    return visibleOptions(ref, checkLayout).length > 0;
  }
  function hasText(text, checkLayout = true) {
    const wanted = clean(text).toLowerCase();
    if (!wanted) return false;
    return roots(document).some((root) => [...root.querySelectorAll("*")].some((n) => n.tagName !== PANEL_TAG && !["SCRIPT", "STYLE"].includes(n.tagName) && [...n.childNodes].some((c) => c.nodeType === 3 && clean(c.textContent).toLowerCase().includes(wanted)) && isVisible(n, checkLayout)));
  }
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
    const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
    const doc = el.ownerDocument;
    const mentions = () => {
      const lower = (text) => String(text ?? "").toLowerCase();
      let count = lower(doc.body?.textContent).split(stem).length - 1;
      for (const n of doc.querySelectorAll("[aria-label]")) count += lower(n.getAttribute("aria-label")).includes(stem) ? 1 : 0;
      return count;
    };
    const before = mentions();
    const around = el.parentElement ?? el;
    const shownBefore2 = clean(around.textContent).toLowerCase().includes(stem);
    for (const kind of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new win.DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    for (let waited = 0; waited <= 3e3; waited += 150) {
      const taken = [...el.querySelectorAll("input[type=file]")].some((i) => i.files?.length) || !shownBefore2 && clean(around.textContent).toLowerCase().includes(stem) || mentions() > before;
      if (taken) return { ok: true, value: name };
      await new Promise((resolve) => win.setTimeout(resolve, 150));
    }
    if (before && [...doc.querySelectorAll('[role="dialog"]')].some((d) => (d.textContent + " " + [...d.querySelectorAll("[aria-label]")].map((n) => n.getAttribute("aria-label")).join(" ")).toLowerCase().includes(stem))) {
      return { ok: true, value: name };
    }
    return { ok: false, detail: "The drop area didn't take the file. Attach it yourself, then continue." };
  }
  function state(ref) {
    const el = find(ref);
    if (!el) return null;
    if (el.matches("input[type=checkbox], input[type=radio]")) return { checked: el.checked };
    if (el.getAttribute("role") === "checkbox" || el.getAttribute("role") === "radio") return { checked: el.getAttribute("aria-checked") === "true" };
    for (const attr of ["aria-pressed", "aria-checked", "aria-selected"]) {
      if (el.hasAttribute(attr) && !el.matches("input, select, textarea")) return { checked: el.getAttribute(attr) === "true" };
    }
    if (el.matches("input[type=file]")) return { value: el.files?.[0]?.name ?? "" };
    if (el.tagName === "SELECT") return { value: clean(el.options[el.selectedIndex]?.text) };
    if (el.isContentEditable) return { value: clean(el.textContent) };
    return { value: el.value ?? clean(el.textContent), invalid: el.getAttribute("aria-invalid") === "true" };
  }
  function committedValue(ref, widgetOnly = false) {
    const el = find(ref);
    if (!el) return null;
    const chips = selectedChips(el);
    if (chips) return clip(chips, 2e3);
    const root = el.getRootNode?.() ?? document;
    const field = F.collectFields(root.nodeType === 9 || root.host ? root : document, { checkLayout: false }).find((f) => f.el === el || f.options?.some?.((o) => o.el === el));
    const rich = el.isContentEditable || el.hasAttribute?.("contenteditable");
    if (!field) return widgetOnly ? shownChoice(el) : rich ? clean(el.textContent) : el.value ?? el.getAttribute("aria-valuetext") ?? (shownChoice(el) || null);
    if (field.kind === "select") return field.phoneFor ? F.countryText(field) : F.isEmpty(field) ? "" : clean(el.options[el.selectedIndex]?.text);
    if (field.kind === "dropdown") return clip(field.phoneFor ? F.countryText(field) : F.dropdownValue(field, { widgetOnly }), 2e3);
    if (field.kind === "text" && el.matches?.('input[role="combobox"]')) {
      const picked = F.widgetPick(el);
      return widgetOnly ? picked : el.value || picked;
    }
    return widgetOnly ? "" : rich ? clean(el.textContent) : el.value ?? "";
  }
  const squashText = (t) => String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}+]+/gu, " ").trim();
  function holdsTyped(value, text) {
    const digits = (t) => String(t ?? "").replace(/\D/g, "");
    const words = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (/^[\d\s+()\-.,]+$/.test(text) && digits(text).length >= 3) {
      return digits(value).endsWith(digits(text).replace(/^0+/, "")) || digits(value).includes(digits(text));
    }
    return words(value).includes(words(text));
  }
  function showsChoice(shown, ...wanted) {
    const seen = squashText(shown);
    return Boolean(seen) && wanted.some((w) => {
      const want = squashText(w);
      return want && (seen === want || seen.includes(want) || want.includes(seen));
    });
  }
  function keyCommitStart(ref, answer) {
    if (!showsChoice(typedText(ref), answer)) return { ok: false, before: "" };
    const first = firstOptionMatches(ref, answer);
    if (first?.known && !first.matches) return { ok: false, before: "" };
    return { ok: true, before: committedValue(ref, true) ?? "" };
  }
  function keyCommitCheck(ref, answer, before) {
    const committed = committedValue(ref, true) ?? "";
    const shown = squashText(committed);
    return {
      committed,
      verified: showsChoice(committed, answer),
      wrong: Boolean(shown) && shown !== squashText(before),
      undone: !shown || shown === squashText(before)
    };
  }
  function phoneTypePlan(ref, answer) {
    const el = find(ref);
    if (!el) return null;
    const field = F.collectFields(document, { checkLayout: false }).find((f) => f.el === el);
    if (!field?.phoneCountry) return null;
    const plan = F.phonePlan(field, answer);
    return { ...plan, countryRef: refOf(field.phoneCountry.el) };
  }
  function rebind(ref, name, role) {
    if (find(ref)) return true;
    const matches = [];
    for (const root of roots(document)) {
      for (const field of F.collectFields(root, { checkLayout: false })) {
        for (const item of fieldElements(field)) {
          if (item.name === name && item.role === role) matches.push(item.ref);
        }
      }
    }
    if (matches.length !== 1) return false;
    const el = find(matches[0]);
    el?.setAttribute(REF, String(ref));
    return Boolean(el);
  }
  function scrollPage(direction) {
    const win = document.defaultView;
    win.scrollBy({ top: (direction === "up" ? -1 : 1) * Math.round(win.innerHeight * 0.8), behavior: "instant" });
    return true;
  }
  function settle(quietMs = 400, maxMs = 4e3) {
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
    activateOption,
    prepareKey,
    /** The most characters a text box takes (its maxlength), or 0 when it has no limit. */
    textLimit: (ref) => {
      const n = find(ref)?.maxLength;
      return Number.isInteger(n) && n > 0 && n < 1e6 ? n : 0;
    },
    snapshotState,
    executionState: (value) => {
      executing = value;
      passThrough(value);
    },
    freshState: (ref) => {
      const el = find(ref);
      return { document_id: globalThis.__applyshortlyDocumentId, user_edited: Boolean(el && userEdited.has(el)), present: Boolean(el), value: el?.value ? el.value : el && committedValue(ref) || (el?.getAttribute("aria-valuetext") ?? el?.value ?? null) };
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
    committedValue,
    holdsTyped,
    showsChoice,
    keyCommitStart,
    keyCommitCheck,
    typedText,
    activate,
    phoneTypePlan,
    rebind,
    visibleOptions,
    shownChoices,
    noteShown,
    matchOption,
    firstOptionMatches,
    typedSuggestion,
    scrollOptions,
    attach,
    pickerOpen,
    hasText,
    state,
    scrollPage,
    settle
  };
})();
