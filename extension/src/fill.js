// Field discovery and filling. Pure DOM logic with no chrome.* calls, so test/fill.test.mjs can
// run it in jsdom. Exposed as globalThis.JobHuntFill for content.js (content scripts aren't modules).
//
// Rules shared with the server-side filler: fill only empty fields, never tick a checkbox (consent
// boxes are always the user's call). Submitting is only ever the user's explicit "Auto apply"
// (content.js); this file just finds the button.

(() => {
  // Custom dropdowns that aren't a <select> or a Google Forms listbox: Angular Material's mat-select
  // and the ARIA combobox / listbox-popup pattern. Their options only exist while open.
  const CUSTOM_DROPDOWN = 'mat-select, [role="combobox"], [aria-haspopup="listbox"]';
  const TEXT_INPUT = 'input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input[type=date], input:not([type]), textarea';
  const PICK_PLACEHOLDER = /^[\s-]*(select|choose|please select|pick)\b/i;
  // The "nothing chosen" entry of a list: "Select…", "--", Zoho's "-None-".
  const EMPTY_OPTION = /^(select|choose|please select|-+|-+\s*none\s*-+)$/i;

  /** Whether an option is the list's "nothing chosen" entry, not an answer. */
  function isPlaceholderOption(text) {
    const t = cleanLabel(text);
    return !t || EMPTY_OPTION.test(t) || PICK_PLACEHOLDER.test(t);
  }

  /**
   * An <input> that is really a dropdown: a combobox that says "Select…" or can't be typed in.
   * Other combobox inputs are typeaheads (a city search) and stay free text.
   */
  function selectLikeInput(el) {
    if (!el.matches('input:is([role="combobox"], [aria-haspopup="listbox"])')) return false;
    if (el.closest('[data-testid="phone_number-code"]')) return true;
    return el.readOnly || el.getAttribute("inputmode") === "none" || PICK_PLACEHOLDER.test(el.getAttribute("placeholder") ?? "");
  }

  /** Question text without required markers and runs of whitespace. */
  function cleanLabel(text) {
    return (text ?? "")
      .replace(/required question/gi, "")
      .replace(/\s*\*+\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textOfIds(doc, ids) {
    return ids
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ");
  }

  // What a form puts on a box instead of its question (Google Forms' long-text boxes carry
  // aria-label="Your answer"): never a label while the real question can still be found.
  const GENERIC_LABEL = /^(?:(?:your|type your|enter your|write your) )?(?:answer|response|reply|text|value|input)s?\W*$|^(?:short|long) answer(?: text)?\W*$|^(?:type|enter|write) (?:here|text)\W*$/i;

  // "mobilePhone.countryCode", "first_name", "candidate-email": a field name, not a question.
  const IDENTIFIER = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*|[._-][A-Za-z0-9]+)+(?:\[\d*\])?$/;

  /** A field name spelled as words ("mobilePhone.countryCode" → "Mobile phone country code"). */
  function readable(label) {
    if (!IDENTIFIER.test(label)) return label;
    const words = label.replace(/\[\d*\]$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[._\-\s]+/).filter(Boolean).map((w) => w.toLowerCase());
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** The human-readable question for a field, trying the usual ways forms attach one. */
  function labelOf(el) {
    return readable(rawLabel(el));
  }

  function rawLabel(el) {
    const doc = el.ownerDocument;
    const ashby = ashbyField(el);
    if (ashby?.label) return ashby.label;
    const rippling = ripplingField(el);
    if (rippling) return rippling.label;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = cleanLabel(textOfIds(doc, labelledBy));
      if (t) return t;
    }
    const id = el.getAttribute("id");
    if (id) {
      const forLabel = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (forLabel && cleanLabel(forLabel.textContent)) return cleanLabel(forLabel.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const ids = wrapping.getAttribute("aria-labelledby");
      if (ids) {
        const caption = ids.split(/\s+/).filter((id) => /-label$/.test(id));
        const text = cleanLabel(textOfIds(doc, caption.join(" ")));
        if (text) return text;
      }
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, option").forEach((n) => n.remove());
      if (cleanLabel(clone.textContent)) return cleanLabel(clone.textContent);
    }
    const aria = cleanLabel(el.getAttribute("aria-label"));
    if (aria && !GENERIC_LABEL.test(aria)) return aria;
    // Google Forms and similar: the question heading lives in the enclosing list item.
    const heading = el.closest('[role="listitem"]')?.querySelector('[role="heading"]');
    if (heading && cleanLabel(heading.textContent)) return cleanLabel(heading.textContent);
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend && cleanLabel(legend.textContent)) return cleanLabel(legend.textContent);
    const nearby = nearbyLabel(el);
    if (nearby) return nearby;
    // Breezy and similar: the question is a heading inside the list item that holds the box.
    const questionHeading = el.closest('li.question, .question')?.querySelector("h1, h2, h3, h4, h5, h6");
    if (questionHeading && cleanLabel(questionHeading.textContent)) return cleanLabel(questionHeading.textContent);
    const named = cleanLabel(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    // A generic name is still better than none (it keeps the box listed), after the aria text.
    return GENERIC_LABEL.test(named) && aria ? aria : named || aria;
  }

  /**
   * A label that sits next to the field without being linked to it (no for/id, not wrapping):
   * the closest preceding label-like sibling, checked at the field and then up to two ancestors.
   * Placeholders are sample values on many forms ("Arjun"), so this must win over them.
   */
  function nearbyLabel(el) {
    const zoho = zohoTabular(el) ?? zohoRow(el);
    if (zoho) return zoho.label;
    const cf7 = el.closest('.wpcf7-form-control-wrap');
    if (cf7) {
      const label = cf7.parentElement?.querySelector('label');
      if (label && !cf7.contains(label)) return cleanLabel(label.textContent);
    }
    let node = el;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.matches("label, legend, [class*=label i]")) {
          const t = cleanLabel(sib.textContent);
          if (t && t.length <= 150) return t;
        }
        // Stop at another field: its label belongs to it, not to us.
        if (sib.querySelector("input, select, textarea") || sib.matches("input, select, textarea")) break;
      }
      const parent = node.parentElement;
      if (parent && parent.querySelectorAll("input, select, textarea").length > 1) break;
    }
    return "";
  }

  // Rippling puts custom question captions outside data-testid="field". Its required
  // marker is an empty element in that caption, rather than an input attribute.
  function ripplingField(el) {
    if (el.closest('[data-testid="phone_number-code"]')) return { label: "Phone country code", required: true };
    if (el.matches('[role="radiogroup"][data-testid="sms_opt_in"]')) return { label: "Receive text message updates about your application?", required: false };
    const box = el.closest('[data-testid="field"]');
    if (!box) return null;
    if (box.querySelector('[data-testid^="customQuestions."]')) {
      const caption = box.previousElementSibling;
      const question = caption?.querySelector("p");
      const text = cleanLabel(question?.textContent);
      if (text) return { label: text, required: Boolean(question.querySelector("div")) || /\*/.test(question.textContent) };
    }
    if (el.matches('input[type="file" i]')) {
      const caption = box.querySelector('[id$="-label"]');
      const text = cleanLabel(caption?.textContent);
      if (text) return { label: text, required: /\*/.test(caption.parentElement?.textContent ?? "") };
    }
    return null;
  }

  /**
   * Zoho Recruit career sites: a row's <label id="crc-label-rec-form_N"> sits several wrappers
   * above its field and its "*" span is the only required marker. A row can also hold a control
   * the label isn't about (salutation before First Name, country code before Mobile).
   */
  function zohoRow(el) {
    const label = el.closest(".crc-form-row")?.querySelector(":scope > label.crm-from-label");
    const text = cleanLabel(label?.textContent);
    if (!text) return null;
    const component = el.closest(`[id="${CSS.escape(label.id.replace(/^crc-label-/, ""))}"]`);
    const typed = component && [...component.querySelectorAll("input")].some((i) => !i.closest("lyte-drop-box"));
    const main = component && !(el.matches('[role="combobox"]') && typed);
    if (main) return { label: text, required: Boolean(label.querySelector(".crc-form-mandatory")) };
    const controls = (el.getAttribute("aria-controls") ?? "").replace(/[\d_]+/g, " ").trim();
    const part = /phone/i.test(component?.tagName ?? "") ? "country code" : /^[a-z ]+$/i.test(controls) && !/^lyte/i.test(controls) ? controls.toLowerCase() : "prefix";
    return { label: `${text} (${part})`, required: false };
  }

  /**
   * Zoho Recruit's tabular sections (Experience Details, Educational Details): each entry is a
   * region "Experience Details : Entry 1 of 10" whose rows label their own fields. A Duration row
   * holds four dropdowns told apart only by their ids (…_from_month, …_to_year), so those parts go
   * into the label: "Experience Details 1: Duration from (month)".
   */
  function zohoTabular(el) {
    const row = el.closest(".crc-form-tabularrow");
    const label = row?.querySelector(":scope > label");
    const text = cleanLabel(label?.textContent);
    if (!text) return null;
    const entry = /^(.*?)\s*:\s*entry\s+(\d+)/i.exec(row.closest('[role="region"]')?.getAttribute("aria-label") ?? "");
    const prefix = entry ? `${cleanLabel(entry[1])} ${entry[2]}: ` : "";
    const part = /_(from|to)_(month|year)$/i.exec(el.closest("rec-dropdown, lyte-dropdown")?.id ?? "");
    const suffix = part ? ` ${part[1].toLowerCase()} (${part[2].toLowerCase()})` : "";
    return { label: `${prefix}${text}${suffix}`, required: Boolean(label.querySelector(".crc-form-mandatory")) };
  }

  // Ashby uses CSS markers for required questions, including choice groups.
  function ashbyField(el) {
    const box = el.closest(".ashby-application-form-field-entry, .ashby-application-form-input-radio-group, .ashby-application-form-input-checkbox-group");
    const title = box?.querySelector(".ashby-application-form-question-title");
    if (!title) return null;
    return {
      label: cleanLabel(title.textContent),
      required: [...title.classList].some((name) => /(?:^|_)required(?:_|$)/.test(name)) || /\*/.test(title.textContent),
    };
  }

  function isRequired(el) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    if (ashbyField(el)?.required) return true;
    if (ripplingField(el)?.required) return true;
    if ((zohoTabular(el) ?? zohoRow(el))?.required) return true;
    if (el.closest('.wpcf7-validates-as-required')) return true;
    const cf7 = el.closest('.wpcf7-form-control-wrap');
    const cf7Label = cf7?.closest('label') || cf7?.parentElement?.querySelector('label');
    if (cf7 && /\*/.test(cf7Label?.textContent ?? '')) return true;
    const item = el.closest('[role="listitem"]');
    if (item?.querySelector('[aria-label="Required question"]')) return true;
    return starredLabelAbove(el);
  }

  // A "*" ending the question's own <label>, when that label isn't tied to the box by for/id
  // (the box sits in the label's sibling block, inside a wrapper that holds only this one box).
  function starredLabelAbove(el) {
    let wrapper = el.parentElement;
    for (let depth = 0; wrapper && depth < 4; depth += 1, wrapper = wrapper.parentElement) {
      if (wrapper.querySelectorAll("input:not([type=hidden]), textarea, select").length !== 1) continue;
      const label = wrapper.querySelector("label");
      if (label && !label.contains(el)) return /\*\s*$/.test(label.textContent ?? "");
      if (label) return false;
    }
    return false;
  }

  function isVisible(el, checkLayout) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      const style = n.ownerDocument.defaultView?.getComputedStyle(n);
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    }
    return !checkLayout || el.getClientRects().length > 0;
  }

  function isEditable(el) {
    return !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true";
  }

  function optionText(el) {
    return cleanLabel(el.getAttribute("aria-label") || el.textContent || el.getAttribute("data-value") || el.value);
  }

  /**
   * Every fillable question on the page, in document order.
   * Field kinds: text, select, radio (native or ARIA), checkbox, file, picker (an upload the
   * page handles in its own dialog, e.g. Google Forms), dropdown (an ARIA listbox).
   */
  function collectFields(doc, { checkLayout = true } = {}) {
    const fields = [];
    const visible = (el) => isVisible(el, checkLayout);

    for (const el of doc.querySelectorAll(TEXT_INPUT)) {
      if (!visible(el) || !isEditable(el) || selectLikeInput(el)) continue;
      const label = labelOf(el);
      // Typing a CAPTCHA answer is always left to the user.
      if (/captcha/i.test(`${label} ${el.name} ${el.id}`)) continue;
      fields.push({ kind: "text", el, label, required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll("select")) {
      if (!visible(el) || !isEditable(el)) continue;
      const options = [...el.options].filter((o) => o.value !== "").map((o) => ({ text: cleanLabel(o.text), el: o }));
      fields.push({ kind: "select", el, label: labelOf(el), required: isRequired(el), options });
    }
    const radioGroups = new Map();
    for (const el of doc.querySelectorAll("input[type=radio]")) {
      if (!visible(el) || !isEditable(el)) continue;
      if (el.closest('[role="radiogroup"]')?.querySelector('[role="radio"]')) continue;
      const key = el.name || el.closest("fieldset") || el;
      if (!radioGroups.has(key)) radioGroups.set(key, []);
      radioGroups.get(key).push(el);
    }
    for (const radios of radioGroups.values()) {
      const first = radios[0];
      const group = first.closest('fieldset, [role="radiogroup"]');
      const label = group ? labelOf(group) || labelOf(first) : nearbyLabel(first) || labelOf(first);
      const options = radios.map((r) => ({ text: labelOfOption(r), el: r }));
      fields.push({ kind: "radio", el: first, label, required: radios.some(isRequired), options });
    }
    for (const group of doc.querySelectorAll('[role="radiogroup"]')) {
      const options = [...group.querySelectorAll('[role="radio"]')].map((r) => ({ text: optionText(r), el: r }));
      if (!options.length || !visible(group)) continue;
      fields.push({ kind: "radio", el: group, label: labelOf(group), required: isRequired(group), options, aria: true,
        consent: group.matches('[data-testid="sms_opt_in"]') });
    }
    for (const group of doc.querySelectorAll(".ashby-application-form-input-yesno")) {
      if (!visible(group)) continue;
      const options = [...group.querySelectorAll("button[aria-pressed][data-option]")]
        .filter(isEditable).map((el) => ({ text: optionText(el), el }));
      if (options.length !== 2) continue;
      fields.push({ kind: "radio", el: group, label: labelOf(group), required: isRequired(group), options, aria: true, pressed: true });
    }
    const seenCheckboxGroups = new Set();
    for (const el of doc.querySelectorAll('input[type=checkbox], [role="checkbox"]')) {
      if (!visible(el)) continue;
      // The backing checkbox of a yes/no question isn't a separate consent field.
      if (el.closest(".ashby-application-form-input-yesno")) continue;
      const cf7 = el.closest('.wpcf7-checkbox');
      const ashby = el.closest('.ashby-application-form-input-checkbox-group');
      const group = cf7 || (ashby?.querySelectorAll('input[type=checkbox]').length > 1 ? ashby : null);
      if (group) {
        if (seenCheckboxGroups.has(group)) continue;
        seenCheckboxGroups.add(group);
        const inputs = [...group.querySelectorAll('input[type=checkbox]')].filter(visible);
        const options = inputs.map((input) => ({ text: labelOfOption(input), el: input }));
        fields.push({ kind: "checkbox", el, label: ashby ? labelOf(group) : nearbyLabel(el), required: isRequired(group) || inputs.some(isRequired), options });
        continue;
      }
      fields.push({ kind: "checkbox", el, label: labelOf(el) || optionText(el), required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll("input[type=file]")) {
      if (el.disabled) continue;
      fields.push({ kind: "file", el, label: labelOf(el) || "File upload", required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll('[role="listbox"]')) {
      if (!visible(el) || el.closest("select")) continue;
      fields.push({ kind: "dropdown", el, label: labelOf(el), required: isRequired(el) });
    }
    const dropdowns = fields.filter((f) => f.kind === "dropdown").map((f) => f.el);
    for (const el of doc.querySelectorAll(CUSTOM_DROPDOWN)) {
      const input = selectLikeInput(el);
      if (!visible(el) || el.closest("select")) continue;
      if (input ? el.disabled : !isEditable(el) || el.matches("input, textarea, select")) continue;
      if (dropdowns.some((d) => d === el || d.contains(el) || el.contains(d))) continue;
      dropdowns.push(el);
      const label = dropdownLabel(el);
      const marked = /\*/.test(el.getAttribute("aria-label") ?? "") || /\*/.test(el.textContent ?? "");
      fields.push({
        kind: "dropdown",
        custom: true,
        layout: checkLayout,
        el,
        label,
        required: isRequired(el) || el.hasAttribute("required") || marked,
      });
    }
    // Uploads with no <input type=file> on the page (Google Forms opens Google's own picker).
    for (const item of doc.querySelectorAll('[role="listitem"]')) {
      const hasPickerButton = [...item.querySelectorAll('[role="button"]')].some((b) => /add file|upload/i.test(b.textContent));
      if (hasPickerButton && !item.querySelector("input[type=file]")) {
        const heading = item.querySelector('[role="heading"]');
        fields.push({ kind: "picker", el: item, label: cleanLabel(heading?.textContent) || "File upload", required: isRequired(heading ?? item) });
      }
    }
    // Document order, so the panel lists questions the way the page shows them.
    return fields.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
  }

  /** The question a custom dropdown answers, never the value it currently shows. */
  function dropdownLabel(el) {
    const doc = el.ownerDocument;
    const rippling = ripplingField(el);
    if (rippling) return rippling.label;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const own = ids.map((id) => doc.getElementById(id)).filter((n) => n && !el.contains(n));
    const fromIds = cleanLabel(own.map((n) => n.textContent).join(" "));
    if (fromIds) return fromIds;
    // "Select" / "Search" are the control's prompt (Rippling), not its question.
    const aria = cleanLabel(el.getAttribute("aria-label") ?? "");
    if (aria && !PICK_PLACEHOLDER.test(aria) && !/^search$/i.test(aria)) return aria;
    const id = el.getAttribute("id");
    const forLabel = id && doc.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (forLabel && cleanLabel(forLabel.textContent)) return cleanLabel(forLabel.textContent);
    const tabular = zohoTabular(el);
    if (tabular) return tabular.label;
    const box = el.closest("mat-form-field, .form-group, [class*=form-field i]");
    const inBox = box && [...box.querySelectorAll("mat-label, label")].find((n) => !el.contains(n));
    if (inBox && cleanLabel(inBox.textContent)) return cleanLabel(inBox.textContent);
    const near = nearbyLabel(el);
    if (near) return near;
    const shown = cleanLabel(el.textContent ?? "");
    // "Select" is the prompt, not the question: the text above the control is.
    if (!shown || PICK_PLACEHOLDER.test(shown)) return textAbove(el) || shown;
    // The placeholder is often the question ("Gender*").
    return shown;
  }

  /**
   * The closest short text before a control, whatever element holds it (a <div> or <p> caption with
   * no <label>, class or for/id). The control is often wrapped several times (Rippling puts the
   * caption beside the whole field wrapper), so this climbs until an ancestor holds another control.
   */
  const CONTROLS = "input, select, textarea, [role=combobox], [role=listbox]";
  function textAbove(el) {
    let node = el;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.querySelector(CONTROLS) || sib.matches(CONTROLS)) return "";
        const t = cleanLabel(sib.textContent);
        if (t && t.length <= 150 && !PICK_PLACEHOLDER.test(t)) return t;
      }
      if ((node.parentElement?.querySelectorAll(CONTROLS).length ?? 0) > 1) return "";
    }
    return "";
  }

  /** What a dropdown currently shows as its answer; "" while nothing is chosen. */
  /**
   * What a select-like <input> holds: its value, or (react-select and similar, where the input
   * stays empty for searching) the choice shown beside it in the same control.
   */
  function inputDropdownValue(el) {
    const own = el.value?.trim();
    if (own) return PICK_PLACEHOLDER.test(own) ? "" : own;
    let box = el.parentElement;
    for (let i = 0; i < 3 && box && box !== el.ownerDocument.body; i++, box = box.parentElement) {
      if (box.querySelectorAll("input, select, textarea, label").length > 1 || box.querySelector('[role="option"], li')) break;
      const shown = cleanLabel(box.textContent ?? "");
      if (shown) return PICK_PLACEHOLDER.test(shown) ? "" : shown;
    }
    return "";
  }

  function dropdownValue(field) {
    const el = field.el;
    if (el.matches("input")) return inputDropdownValue(el);
    const selected = el.querySelector('[role="option"][aria-selected="true"]');
    if (selected) {
      const text = selected.textContent.trim();
      return /^choose$/i.test(text) ? "" : (selected.getAttribute("data-value") ?? text);
    }
    if (!field.custom) return "";
    if (el.matches(".mat-mdc-select-empty, .mat-select-empty") || el.querySelector(".mat-mdc-select-placeholder, .mat-select-placeholder")) return "";
    const shown = cleanLabel(el.querySelector(".mat-mdc-select-value-text, .mat-select-value-text")?.textContent ?? el.textContent ?? "");
    const same = normalise(shown) === normalise(field.label ?? "");
    return !shown || same || EMPTY_OPTION.test(shown) ? "" : shown;
  }

  const INLINE = new Set(["B", "I", "EM", "STRONG", "SMALL", "SPAN", "SVG", "IMG", "BR"]);
  const SHOWN_LIMIT = 4000;

  /**
   * The short pieces of text the page shows right now. Taken before a dropdown opens, so the list
   * that appears can be found even when it has no ARIA roles (see appearedOptions).
   */
  function shownTexts(doc, checkLayout) {
    const out = new Set();
    const all = doc.body?.querySelectorAll("li, div, span, a, p, button, label, td") ?? [];
    for (let i = 0; i < all.length && i < SHOWN_LIMIT; i++) {
      const el = all[i];
      if ([...el.children].some((c) => !INLINE.has(c.tagName.toUpperCase()))) continue;
      const text = el.textContent?.trim() ?? "";
      if (!text || text.length > 80) continue;
      const shown = el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) && (!checkLayout || el.getClientRects().length > 0) : isVisible(el, checkLayout);
      if (shown) out.add(el);
    }
    return out;
  }

  /**
   * A custom list without ARIA roles (plain <li>s or <div>s): the texts that appeared since
   * `before`, grouped by the element holding them as siblings. The biggest group is the list.
   */
  function appearedOptions(before, doc, checkLayout) {
    const groups = new Map();
    for (const leaf of shownTexts(doc, checkLayout)) {
      if (before.has(leaf)) continue;
      let item = leaf;
      while (item.parentElement && item.parentElement !== doc.body && item.parentElement.childElementCount === 1) item = item.parentElement;
      const holder = item.parentElement;
      if (!holder) continue;
      if (!groups.has(holder)) groups.set(holder, new Set());
      groups.get(holder).add(item);
    }
    let best = [];
    for (const items of groups.values()) if (items.size > best.length) best = [...items];
    return best.length >= 2 ? best.map((o) => ({ text: optionText(o), el: o })) : [];
  }

  /** Visible options of a custom dropdown that is open (Material renders them in an overlay). */
  function openOptions(field, before = null) {
    const el = field.el;
    const doc = el.ownerDocument;
    // Some libraries (Rippling) link nothing but name the list after the control: "field-5" → "field-5-list".
    const named = el.id ? [`${el.id}-list`, `${el.id}-listbox`] : [];
    const owned = [...["aria-controls", "aria-owns"].map((a) => el.getAttribute(a)).filter(Boolean), ...named]
      .map((id) => doc.getElementById(id)).filter(Boolean);
    const scopes = owned.length ? owned : [doc];
    const options = scopes
      .flatMap((s) => [...s.querySelectorAll('[role="option"], mat-option')])
      .filter((o) => isVisible(o, field.layout))
      .map((o) => ({ text: optionText(o), el: o }));
    return options.length || !before ? options : appearedOptions(before, doc, field.layout);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function press(el, types) {
    const win = el.ownerDocument.defaultView;
    for (const type of types) el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win }));
  }

  /** Closes a dropdown: Escape, and a click on the page when Escape isn't enough. */
  function dismiss(el, stillOpen = () => false) {
    const win = el.ownerDocument.defaultView;
    for (const target of [el, el.ownerDocument.activeElement]) {
      target?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    if (stillOpen()) press(el.ownerDocument.body, ["mousedown", "mouseup", "click"]);
  }

  /**
   * Opens a custom dropdown, clicks the option an answer refers to and returns its text, or null
   * when it isn't there. Libraries differ on whether click or mousedown opens, so try one then the other.
   */
  async function pickDropdown(field, answer, { polls = 6, pollMs = 50, strict = false } = {}) {
    const el = field.el;
    const before = shownTexts(el.ownerDocument, field.layout);
    el.focus?.();
    let options = [];
    for (const open of [["click"], ["mousedown", "mouseup"]]) {
      press(el, open);
      for (let i = 0; i < polls && !options.length; i++) {
        options = openOptions(field, before);
        if (!options.length) await sleep(pollMs);
      }
      if (options.length) break;
    }
    const option = options.length ? chooseOption(options, answer, { strict }) : null;
    if (!option) {
      dismiss(el, () => openOptions(field, before).length > 0);
      return null;
    }
    press(option.el, ["mousedown", "mouseup", "click"]);
    await sleep(pollMs);
    return option.text;
  }

  /**
   * The options of a closed custom dropdown, read by opening it briefly and closing it again without
   * choosing anything. They only exist while it's open, so collectFields can't see them; the panel
   * and the assistant need them to offer real choices. Returns [] when none appear (async search).
   */
  async function readDropdownOptions(field, { polls = 6, pollMs = 50 } = {}) {
    const el = field.el;
    const before = shownTexts(el.ownerDocument, field.layout);
    let options = [];
    for (const open of [["click"], ["mousedown", "mouseup"]]) {
      press(el, open);
      for (let i = 0; i < polls && !options.length; i++) {
        options = openOptions(field, before);
        if (!options.length) await sleep(pollMs);
      }
      dismiss(el, () => openOptions(field, before).length > 0);
      // The next dropdown must not find this one's list still on screen.
      for (let i = 0; i < polls && openOptions(field).length; i++) await sleep(pollMs);
      if (options.length) break;
    }
    const seen = new Set();
    return options
      .map((o) => ({ text: cleanLabel(o.text) }))
      .filter((o) => !isPlaceholderOption(o.text) && !seen.has(o.text) && seen.add(o.text));
  }

  // ---------------------------------------------------------------- what the page says is wrong

  /**
   * Whether the page itself rejects what a field holds (Angular/Material, Bootstrap, ARIA or native
   * validation). An empty field is just unanswered, not invalid.
   */
  function isInvalid(field) {
    const el = field.kind === "radio" && !field.aria ? field.options[0]?.el : field.el;
    if (!el?.getAttribute) return false;
    if (el.getAttribute("aria-invalid") === "true") return true;
    if (el.matches(".ng-invalid.ng-touched, .is-invalid, .mat-form-field-invalid *")) return true;
    if (field.kind === "text" && el.value && el.validity && !el.validity.valid) return true;
    return false;
  }

  /** The site's own error text for a field, when it shows one. */
  function invalidReason(field) {
    const el = field.el;
    const doc = el.ownerDocument;
    const ids = `${el.getAttribute("aria-errormessage") ?? ""} ${el.getAttribute("aria-describedby") ?? ""}`;
    const described = cleanLabel(textOfIds(doc, ids.trim()));
    const box = el.closest("mat-form-field, .form-group, [class*=form-field i], [class*=field i]") ?? el.parentElement?.parentElement;
    const shown = box?.querySelector('mat-error, [role="alert"], .invalid-feedback, [class*=error i]');
    const text = described || cleanLabel(shown?.textContent ?? "") || (el.validationMessage ?? "");
    return text.length > 140 ? `${text.slice(0, 137)}…` : text;
  }

  /**
   * Other ways to write a value the page rejected: just the number ("5.6 years" → "5.6", "INR 1,900,000"
   * → "1,900,000" or "1900000"). Empty unless it has both digits and other characters.
   */
  function numericVariants(value) {
    const s = String(value ?? "");
    const core = /\d[\d,]*(\.\d+)?/.exec(s)?.[0];
    if (!core || core === s || !/[a-z]/i.test(s)) return [];
    return [...new Set([core, core.replace(/,/g, "")])].filter((v) => v !== s);
  }

  function labelOfOption(radio) {
    const id = radio.getAttribute("id");
    const doc = radio.ownerDocument;
    const label = (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) || radio.closest("label");
    return cleanLabel(label?.textContent || radio.getAttribute("aria-label") || radio.value);
  }

  // ---------------------------------------------------------------- answers from the profile

  function latestExperience(profile) {
    const jobs = [...(profile.experience ?? [])];
    jobs.sort((a, b) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      return String(b.end_date ?? "9999").localeCompare(String(a.end_date ?? "9999")) ||
        String(b.start_date ?? "").localeCompare(String(a.start_date ?? ""));
    });
    return jobs[0] ?? null;
  }

  function highestEducation(profile) {
    const edu = [...(profile.education ?? [])];
    edu.sort((a, b) => Number(b.end_year ?? 0) - Number(a.end_year ?? 0));
    return edu[0] ?? null;
  }

  function years(n) {
    if (n == null) return null;
    const rounded = Math.round(Number(n) * 10) / 10;
    return `${rounded} ${rounded === 1 ? "year" : "years"}`;
  }

  /**
   * "+91 98765 43210" → "+91". Written without a separator ("+919876543210"), the last ten digits
   * are taken as the national number. Null when the number doesn't start with a country code.
   */
  function dialCode(phone) {
    const text = String(phone ?? "").trim();
    const spaced = /^\+(\d{1,3})[\s\-().]/.exec(text);
    if (spaced) return `+${spaced[1]}`;
    const joined = /^\+?(\d{11,13})$/.exec(text);
    return joined ? `+${joined[1].slice(0, -10)}` : null;
  }

  /**
   * Answers that come straight from profile fields. Anything else goes to the platform's
   * /answers/suggest, which knows preferences (notice period, CTC, work authorisation) and the
   * answer bank. Returns {value, needsReview} or null.
   */
  function profileAnswer(label, profile, app) {
    const l = label.toLowerCase();
    const sure = (value) => (value ? { value: String(value), needsReview: false } : null);
    const check = (value) => (value ? { value: String(value), needsReview: true } : null);
    const [first, ...rest] = (profile.full_name ?? "").trim().split(/\s+/);
    const link = (re) => profile.links?.find((x) => re.test(x.url) || re.test(x.label ?? ""))?.url;

    if (/(?:first(?: name)?|given(?: name)?|name)\s*(?:and|&|\/)\s*(?:last(?: name)?|family(?: name)?|surname)/.test(l)) return sure(profile.full_name);
    if (/first name|given name/.test(l)) return sure(first);
    if (/last name|surname|family name/.test(l)) return sure(rest.join(" "));
    if (/full name|^(your )?name\b|candidate name|applicant name/.test(l)) return sure(profile.full_name);
    if (/e-?mail/.test(l)) return sure(profile.email);
    const includeCode = /\b(?:include|including|with)\b.{0,20}\b(?:country|dial(?:l?ing)?|calling) ?code\b/.test(l);
    if (!includeCode && /country ?code|dial(?:l?ing)? code|calling code|phone code|\bisd\b/.test(l)) return sure(dialCode(profile.phone));
    if (/phone|mobile|contact (number|no)|whatsapp|telephone/.test(l)) return sure(profile.phone);
    if (/\b(?:annual|yearly) (?:salary |compensation |pay )?expectations?\b/.test(l)) {
      const currency = /\b(INR|USD|EUR|GBP|SGD|AED|CAD|AUD)\b/i.exec(label)?.[1].toUpperCase();
      const prefs = profile.preferences;
      return currency && currency === prefs?.currency ? sure(prefs.expected_ctc) : null;
    }
    if (/linkedin/.test(l)) return sure(link(/linkedin/i));
    if (/github/.test(l)) return sure(link(/github/i));
    if (/portfolio|personal (web)?site|^website/.test(l)) return sure(link(/portfolio|website|^https?:\/\/(?!.*(linkedin|github))/i));
    if (/^(current )?(location|city)\b|current (city|location)|where are you (currently )?(based|located)/.test(l)) {
      return sure(profile.location);
    }
    if (/\b(total|overall)\b.{0,40}\bexperience\b|^(how many )?years of (total |overall |professional |work |full[- ]time )?experience\W*$|^exp\.? in it industry\W*$/.test(l)) {
      return sure(years(profile.total_experience_years));
    }
    const job = latestExperience(profile);
    if (/current (company|employer|organi[sz]ation)|present (company|employer)/.test(l)) {
      return job?.is_current ? sure(job.company) : check(job?.company);
    }
    if (/current (job )?(title|designation|role|position)/.test(l)) {
      return job?.is_current ? sure(job.title) : check(job?.title);
    }
    const edu = highestEducation(profile);
    if (/highest (educational |education )?(qualification|degree|education)|^(educational )?qualification\W*$/.test(l)) {
      return sure(edu && [edu.degree, edu.field_of_study].filter(Boolean).join(" "));
    }
    if (/college|university|institut(e|ion)|alma mater/.test(l)) {
      if (!edu?.institution) return null;
      const withBranch = /branch|major|stream|speciali[sz]ation|discipline/.test(l) && edu.field_of_study;
      return sure(withBranch ? `${edu.institution} – ${edu.field_of_study}` : edu.institution);
    }
    if (/cover letter/.test(l)) return check(app?.cover_letter);
    if (/(professional )?summary|about yourself|tell us about you|introduce yourself/.test(l)) {
      return check(app?.tailored_summary || profile.summary);
    }
    return null;
  }

  // ---------------------------------------------------------------- writing values

  /** Sets a value the way typing would, so React/Angular/Google Forms state picks it up. */
  function setValue(el, value) {
    const win = el.ownerDocument.defaultView;
    const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    el.focus?.();
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: String(value) }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    // React delegates onBlur through focusout; synthetic blur alone doesn't notify it.
    el.blur?.();
  }

  function normalise(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /**
   * The option an answer refers to: exact, then yes/no, then containment either way. `strict`
   * (AI drafts) stops before containment: a drafted sentence that merely contains an option's
   * words must not tick it.
   */
  function chooseOption(options, answer, { strict = false } = {}) {
    const a = normalise(answer);
    if (!a) return null;
    const exact = options.find((o) => normalise(o.text) === a);
    if (exact) return exact;
    const yesNo = /^(yes|no)\b/.exec(a)?.[1];
    if (yesNo) {
      const match = options.find((o) => new RegExp(`^${yesNo}\\b`).test(normalise(o.text)));
      if (match) return match;
    }
    if (strict) return null;
    const contained = options.filter((o) => {
      const t = normalise(o.text);
      return t && (a.includes(t) || t.includes(a));
    });
    return contained.length === 1 ? contained[0] : null;
  }

  function isEmpty(field) {
    switch (field.kind) {
      case "text":
        return !field.el.value.trim();
      case "select":
        return !field.el.value || field.el.selectedIndex <= 0 && field.el.options[0]?.value === ""
          || isPlaceholderOption(field.el.options[field.el.selectedIndex]?.text);
      case "radio":
        return field.aria
          ? !field.options.some((o) => o.el.getAttribute(field.pressed ? "aria-pressed" : "aria-checked") === "true")
          : !field.options.some((o) => o.el.checked);
      case "file":
        return !field.el.files?.length;
      case "dropdown":
        if (field.el.closest('[data-testid="phone_number-code"]') &&
            !field.el.ownerDocument.querySelector('[data-input="phone_number"]')?.value?.trim()) return true;
        return !dropdownValue(field);
      default:
        return true;
    }
  }

  /** Applies an answer to a field. Returns the value actually written, or null if none fit. */
  function apply(field, answer, { strict = false } = {}) {
    const win = field.el.ownerDocument.defaultView;
    if (field.kind === "text") {
      let value = answer;
      if (field.el.matches('input[type=date], input.ashby-application-form-input-date')) {
        // Date widgets need their expected format, never a generated sentence about availability.
        const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
        const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value));
        if (!iso && !us) return null;
        const [year, month, day] = iso ? iso.slice(1).map(Number) : [Number(us[3]), Number(us[1]), Number(us[2])];
        const date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
        const mm = String(month).padStart(2, "0"), dd = String(day).padStart(2, "0");
        value = field.el.type === "date" ? `${year}-${mm}-${dd}` : `${mm}/${dd}/${year}`;
      }
      const max = field.el.maxLength;
      if (max >= 0 && String(value).length > max) return null;
      if (field.el.matches('[data-input="phone_number"]')) {
        const code = field.el.ownerDocument.querySelector('[data-testid="phone_number-code"] input');
        const prefix = /^\+(\d{1,3})\b/.exec(code?.value ?? "")?.[1];
        const digits = String(value).replace(/\D/g, "");
        if (prefix && dialCode(value) === `+${prefix}`) value = digits.slice(prefix.length);
      }
      if (field.el.type === "number") {
        const n = /-?\d+(\.\d+)?/.exec(answer)?.[0];
        if (!n) return null;
        value = n;
      }
      setValue(field.el, value);
      return value;
    }
    if (field.kind === "select") {
      const option = chooseOption(field.options, answer, { strict });
      if (!option) return null;
      field.el.value = option.el.value;
      field.el.dispatchEvent(new win.Event("input", { bubbles: true }));
      field.el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return option.text;
    }
    if (field.kind === "radio") {
      const option = chooseOption(field.options, answer, { strict });
      if (!option) return null;
      option.el.click();
      return option.text;
    }
    return null;
  }

  /** Puts a file into an <input type=file> (the browser only allows this via DataTransfer). */
  function attachFile(input, file) {
    const win = input.ownerDocument.defaultView;
    const dt = new win.DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  /** Google Forms' "Your response has been recorded" page, or a generic thank-you page. */
  function looksSubmitted(doc, url) {
    const u = new URL(url);
    if (u.hostname === "docs.google.com" && u.pathname.endsWith("/formResponse")) {
      const hasQuestions = doc.querySelector('[role="listitem"] input:not([type=hidden]), [role="listitem"] textarea');
      return !hasQuestions;
    }
    return false;
  }

  const SUBMIT_TEXT = /\b(submit|apply|send( my)? application)\b/i;
  // "Apply with LinkedIn", "Save and continue", "Next": not the final submit of this form.
  const NOT_SUBMIT = /\b(next|continue|back|previous|save|draft|cancel|later|linkedin|indeed|google|sign ?in|log ?in|upload|attach)\b/i;

  function buttonText(el) {
    return cleanLabel(el.getAttribute("aria-label") || (el.tagName === "INPUT" ? el.value : el.textContent));
  }

  /**
   * The one button that submits the form these fields belong to, or null when there is none
   * or it's ambiguous. Auto apply never guesses between candidates.
   */
  function findSubmitButton(doc, fields, { checkLayout = true, includeDisabled = false } = {}) {
    const forms = new Set(fields.map((f) => f.el.closest?.("form")).filter(Boolean));
    const scope = forms.size === 1 ? [...forms][0] : doc;
    const usable = (el) => isVisible(el, checkLayout) && (includeDisabled || (!el.disabled && el.getAttribute("aria-disabled") !== "true"));
    const candidates = [...scope.querySelectorAll('button, input[type=submit], [role="button"]')].filter((el) => {
      if (!usable(el) || el.type === "reset") return false;
      const text = buttonText(el);
      const formSend = forms.size === 1 && forms.has(el.form) &&
        el.matches('input[type="submit"], button[type="submit"]') && /^send$/i.test(text);
      return (SUBMIT_TEXT.test(text) || formSend) && !NOT_SUBMIT.test(text);
    });
    // A <div role=button> wrapping a <button> counts once.
    const outermost = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
    return outermost.length === 1 ? outermost[0] : null;
  }

  /** "Current CTC? Mention fixed and variable…" → "Current CTC?" */
  function firstSentence(label) {
    const m = /^(.{6,}?[?.:])\s+\S/.exec(label);
    return m ? m[1] : label;
  }

  globalThis.JobHuntFill = {
    cleanLabel,
    isPlaceholderOption,
    firstSentence,
    labelOf,
    collectFields,
    profileAnswer,
    chooseOption,
    isEmpty,
    isInvalid,
    invalidReason,
    numericVariants,
    dropdownValue,
    pickDropdown,
    readDropdownOptions,
    shownTexts,
    appearedOptions,
    apply,
    attachFile,
    findSubmitButton,
    looksSubmitted,
  };
})();
