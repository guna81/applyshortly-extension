(() => {
  const { profileAnswer, dialCode, splitInternational, DIAL_COUNTRIES } = globalThis.JobHuntProfile;
  const CUSTOM_DROPDOWN = 'mat-select, [role="combobox"], [aria-haspopup="listbox"]';
  const TEXT_INPUT = 'input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input[type=date], input:not([type]), textarea, [role="textbox"][contenteditable="true"], [role="textbox"][contenteditable="plaintext-only"]';
  const PICK_PLACEHOLDER = /^[\s-]*(select|choose|please select|pick)\b/i;
  const EMPTY_OPTION = /^(select|choose|please select|-+|-+\s*none\s*-+)$/i;
  function isPlaceholderOption(text) {
    const t = cleanLabel(text);
    return !t || EMPTY_OPTION.test(t) || PICK_PLACEHOLDER.test(t);
  }
  function selectLikeInput(el) {
    if (!el.matches('input:is([role="combobox"], [aria-haspopup="listbox"])')) return false;
    if (el.closest('[data-testid="phone_number-code"]')) return true;
    return el.readOnly || el.getAttribute("inputmode") === "none" || PICK_PLACEHOLDER.test(el.getAttribute("placeholder") ?? "");
  }
  function cleanLabel(text) {
    return (text ?? "").replace(/required question/gi, "").replace(/\s*\*+\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  function textOfIds(doc, ids) {
    return ids.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ");
  }
  const GENERIC_LABEL = /^(?:(?:your|type your|enter your|write your) )?(?:answer|response|reply|text|value|input)s?\W*$|^(?:short|long) answer(?: text)?\W*$|^(?:type|enter|write) (?:here|text)\W*$/i;
  const IDENTIFIER = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*|[._-][A-Za-z0-9]+)+(?:\[\d*\])?$/;
  function readable(label) {
    if (!IDENTIFIER.test(label)) return label;
    const words = label.replace(/\[\d*\]$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[._\-\s]+/).filter(Boolean).map((w) => w.toLowerCase());
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function labelOf(el) {
    return readable(rawLabel(el));
  }
  function rawLabel(el) {
    const doc = el.ownerDocument;
    if (el.matches('input[type="file" i]')) {
      const group = el.closest('[role="group"][aria-labelledby]');
      if (group && group.querySelectorAll('input[type="file" i]').length === 1) {
        const label = cleanLabel(textOfIds(doc, group.getAttribute("aria-labelledby")));
        if (label) return label;
      }
    }
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
        const caption2 = ids.split(/\s+/).filter((id2) => /-label$/.test(id2));
        const text = cleanLabel(textOfIds(doc, caption2.join(" ")));
        if (text) return text;
      }
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, option, svg, [hidden], [aria-hidden="true"], [style*="display: none"], [class*="dropdown" i]').forEach((n) => n.remove());
      if (cleanLabel(clone.textContent)) return cleanLabel(clone.textContent);
    }
    const aria = cleanLabel(el.getAttribute("aria-label"));
    if (aria && !GENERIC_LABEL.test(aria)) return aria;
    const heading = el.closest('[role="listitem"]')?.querySelector('[role="heading"]');
    if (heading && cleanLabel(heading.textContent)) return cleanLabel(heading.textContent);
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend && cleanLabel(legend.textContent)) return cleanLabel(legend.textContent);
    const nearby = nearbyLabel(el);
    if (nearby) return nearby;
    const caption = reactSelectCaption(el);
    if (caption) return caption;
    const questionHeading = el.closest("li.question, .question")?.querySelector("h1, h2, h3, h4, h5, h6");
    if (questionHeading && cleanLabel(questionHeading.textContent)) return cleanLabel(questionHeading.textContent);
    const named = cleanLabel(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    return GENERIC_LABEL.test(named) && aria ? aria : named || aria;
  }
  function nearbyLabel(el) {
    const zoho = zohoTabular(el) ?? zohoRow(el);
    if (zoho) return zoho.label;
    const cf7 = el.closest(".wpcf7-form-control-wrap");
    if (cf7) {
      const label = cf7.parentElement?.querySelector("label");
      if (label && !cf7.contains(label)) return cleanLabel(label.textContent);
    }
    let node = el;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.matches("label, legend, [class*=label i]")) {
          const t = cleanLabel(sib.textContent);
          if (t && t.length <= 150) return t;
        }
        if (sib.querySelector("input, select, textarea") || sib.matches("input, select, textarea")) break;
      }
      const parent = node.parentElement;
      if (parent && parent.querySelectorAll("input, select, textarea").length > 1) break;
    }
    return "";
  }
  function reactSelectCaption(el) {
    if (!el.matches('input[role="combobox"]')) return "";
    const root = el.closest("div:has(> span[id$='-live-region'])");
    const text = cleanLabel(root?.previousElementSibling?.textContent);
    return text && text.length <= 150 && !root.previousElementSibling.querySelector("input, select, textarea") ? text : "";
  }
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
  function ashbyField(el) {
    const box = el.closest(".ashby-application-form-field-entry, .ashby-application-form-input-radio-group, .ashby-application-form-input-checkbox-group");
    const title = box?.querySelector(".ashby-application-form-question-title");
    if (!title) return null;
    return {
      label: cleanLabel(title.textContent),
      required: [...title.classList].some((name) => /(?:^|_)required(?:_|$)/.test(name)) || /\*/.test(title.textContent)
    };
  }
  function isRequired(el) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    if (el.matches('input[type="file" i]')) {
      const group = el.closest('[role="group"][aria-labelledby]');
      if (group && group.querySelectorAll('input[type="file" i]').length === 1 && (group.getAttribute("aria-required") === "true" || /\*/.test(textOfIds(el.ownerDocument, group.getAttribute("aria-labelledby"))))) return true;
    }
    if (ashbyField(el)?.required) return true;
    if (ripplingField(el)?.required) return true;
    if ((zohoTabular(el) ?? zohoRow(el))?.required) return true;
    if (el.closest(".wpcf7-validates-as-required")) return true;
    const cf7 = el.closest(".wpcf7-form-control-wrap");
    const cf7Label = cf7?.closest("label") || cf7?.parentElement?.querySelector("label");
    if (cf7 && /\*/.test(cf7Label?.textContent ?? "")) return true;
    const item = el.closest('[role="listitem"]');
    if (item?.querySelector('[aria-label="Required question"]')) return true;
    return starredLabelAbove(el) || starredGroupAbove(el);
  }
  function starredGroupAbove(el) {
    let wrapper = el.parentElement;
    for (let depth = 0; wrapper && depth < 5; depth += 1, wrapper = wrapper.parentElement) {
      if (wrapper.querySelectorAll("input:not([type=hidden]), textarea, select").length < 2) continue;
      for (const child of wrapper.children) {
        if (child.contains(el) || !child.matches("label, legend, [class*=label i]")) continue;
        if (/\*\s*$/.test(child.textContent ?? "") && !child.querySelector("input, textarea, select")) return true;
      }
    }
    return false;
  }
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
  function applicationControl(el) {
    return !el.closest('footer, nav, [role="contentinfo"], [role="navigation"], [role="search"]');
  }
  function isHoneypot(el) {
    const r = el.getBoundingClientRect?.();
    return Boolean(r && (r.width || r.height) && (r.right < -1e3 || r.bottom < -1e3));
  }
  function collectFields(doc, { checkLayout = true } = {}) {
    const fields = [];
    const visible = (el) => applicationControl(el) && isVisible(el, checkLayout);
    for (const el of doc.querySelectorAll(TEXT_INPUT)) {
      if (!visible(el) || !isEditable(el) || selectLikeInput(el) || isHoneypot(el)) continue;
      if (el.matches("input.editableFix") && el.parentElement?.querySelector('[role="textbox"][contenteditable]')) continue;
      if (el.matches('input[aria-hidden="true"][tabindex="-1"]') && el.parentElement?.querySelectorAll("input").length === 2 && el.parentElement?.querySelector('input[role="combobox"]')) continue;
      const label = labelOf(el);
      if (/captcha/i.test(`${label} ${el.name} ${el.id}`)) continue;
      fields.push({ kind: "text", el, label, required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll("select")) {
      if (!visible(el) || !isEditable(el)) continue;
      const options = [...el.options].filter((o) => o.value !== "").map((o) => ({ text: cleanLabel(o.text), el: o }));
      fields.push({ kind: "select", el, label: labelOf(el), required: isRequired(el), options });
    }
    const radioGroups = /* @__PURE__ */ new Map();
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
      fields.push({
        kind: "radio",
        el: group,
        label: labelOf(group),
        required: isRequired(group),
        options,
        aria: true,
        consent: group.matches('[data-testid="sms_opt_in"]')
      });
    }
    for (const group of doc.querySelectorAll(".ashby-application-form-input-yesno")) {
      if (!visible(group)) continue;
      const options = [...group.querySelectorAll("button[aria-pressed][data-option]")].filter(isEditable).map((el) => ({ text: optionText(el), el }));
      if (options.length !== 2) continue;
      fields.push({ kind: "radio", el: group, label: labelOf(group), required: isRequired(group), options, aria: true, pressed: true });
    }
    const seenCheckboxGroups = /* @__PURE__ */ new Set();
    for (const el of doc.querySelectorAll('input[type=checkbox], [role="checkbox"]')) {
      if (!visible(el)) continue;
      if (el.closest(".ashby-application-form-input-yesno")) continue;
      const cf7 = el.closest(".wpcf7-checkbox");
      const ashby = el.closest(".ashby-application-form-input-checkbox-group");
      const named = el.name ? [...(el.form ?? doc).querySelectorAll("input[type=checkbox]")].filter((other) => other.name === el.name && visible(other)) : [];
      const semantic = el.closest('fieldset, [role="group"][aria-labelledby], [role="group"][aria-label]');
      const candidates = semantic ? [...semantic.querySelectorAll("input[type=checkbox]")].filter(visible) : [];
      const semanticInputs = candidates.length > 1 && (candidates.every((input) => input.name && input.name === candidates[0].name) || /\?|\b(?:select|choose|pick)\b|all that apply/i.test(labelOf(semantic))) ? candidates : [];
      let common = named.length > 1 ? named[0].parentElement : null;
      while (common && !named.every((input) => common.contains(input))) common = common.parentElement;
      const shared = semanticInputs.length > 1 ? semantic : common;
      const group = cf7 || (ashby?.querySelectorAll("input[type=checkbox]").length > 1 ? ashby : null) || shared;
      if (group) {
        if (seenCheckboxGroups.has(group)) continue;
        seenCheckboxGroups.add(group);
        const inputs = group === shared ? semanticInputs.length > 1 ? semanticInputs : named : [...group.querySelectorAll("input[type=checkbox]")].filter(visible);
        const options = inputs.map((input) => ({ text: labelOfOption(input), el: input }));
        fields.push({ kind: "checkbox", el, label: ashby || semantic === group ? labelOf(group) : nearbyLabel(shared ?? el) || textAbove(shared ?? el), required: isRequired(group) || inputs.some(isRequired), options });
        continue;
      }
      fields.push({ kind: "checkbox", el, label: labelOf(el) || optionText(el), required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll("input[type=file]")) {
      if (el.disabled || !applicationControl(el)) continue;
      fields.push({ kind: "file", el, label: labelOf(el) || "File upload", required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll('[role="listbox"]')) {
      if (!visible(el) || el.closest("select")) continue;
      if (el.id && doc.querySelector(`[aria-controls~="${CSS.escape(el.id)}"], [aria-owns~="${CSS.escape(el.id)}"]`)) continue;
      const namer = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => id && doc.getElementById(id)).find((n) => n?.matches?.(CUSTOM_DROPDOWN));
      if (namer) continue;
      fields.push({ kind: "dropdown", el, label: labelOf(el), required: isRequired(el) });
    }
    const dropdowns = fields.filter((f) => f.kind === "dropdown").map((f) => f.el);
    for (const el of doc.querySelectorAll(CUSTOM_DROPDOWN)) {
      const input = selectLikeInput(el);
      if (!visible(el) || el.closest("select")) continue;
      if (input ? el.disabled : !isEditable(el) || el.matches("input, textarea, select")) continue;
      if (dropdowns.some((d) => d === el || d.contains(el) || el.contains(d))) continue;
      dropdowns.push(el);
      let label = dropdownLabel(el);
      if (!label && phoneInputFor(el, "")) label = "Phone country code";
      if (!label) continue;
      const marked = /\*/.test(el.getAttribute("aria-label") ?? "") || /\*/.test(el.textContent ?? "");
      fields.push({
        kind: "dropdown",
        custom: true,
        layout: checkLayout,
        el,
        label,
        explicitLabel: explicitDropdownLabel(el),
        required: isRequired(el) || el.hasAttribute("required") || marked
      });
    }
    linkPhoneGroups(fields);
    for (const item of doc.querySelectorAll('[role="listitem"]')) {
      const hasPickerButton = [...item.querySelectorAll('[role="button"]')].some((b) => /add file|upload/i.test(b.textContent));
      if (hasPickerButton && !item.querySelector("input[type=file]")) {
        const heading = item.querySelector('[role="heading"]');
        fields.push({ kind: "picker", el: item, label: cleanLabel(heading?.textContent) || "File upload", required: isRequired(heading ?? item) });
      }
    }
    for (const button of doc.querySelectorAll('button, [role="button"]')) {
      if (!visible(button) || !/drop files here or click to browse/i.test(button.textContent ?? "")) continue;
      let node = button;
      for (let depth = 0; node.parentElement && depth < 6; depth++, node = node.parentElement) {
        const parent = node.parentElement;
        if (parent.querySelector("input, textarea, select")) break;
        const caption = [...parent.children].filter((child) => !child.contains(button)).map((child) => child.textContent?.trim() ?? "").find((text) => /^(?:resume|résumé|cv)\b/i.test(text));
        if (!caption) continue;
        fields.push({ kind: "picker", el: button, label: cleanLabel(caption), required: /\*/.test(caption) || button.getAttribute("aria-required") === "true", dropzone: true });
        break;
      }
    }
    return fields.sort((a, b) => a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1);
  }
  function linkPhoneGroups(fields) {
    for (const f of fields) {
      if (f.kind !== "dropdown" && f.kind !== "select") continue;
      if (f.kind === "dropdown" && ripplingField(f.el)) continue;
      const tel = f.kind === "select" ? phoneInputFor(f.el, f.label) : phoneInputFor(f.el, f.explicitLabel ?? "");
      const telField = tel && fields.find((x) => x.el === tel && x.kind === "text");
      if (!telField || telField.phoneCountry) continue;
      f.phoneFor = telField;
      f.label = phoneCountryLabel(telField.label);
      f.required = Boolean(telField.required);
      telField.phoneCountry = f;
    }
  }
  function dropdownLabel(el) {
    return explicitDropdownLabel(el) || shownLabel(el);
  }
  function explicitDropdownLabel(el) {
    const doc = el.ownerDocument;
    const rippling = ripplingField(el);
    if (rippling) return rippling.label;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const own = ids.map((id2) => doc.getElementById(id2)).filter((n) => n && !el.contains(n));
    const fromIds = cleanLabel(own.map((n) => n.textContent).join(" "));
    if (fromIds) return fromIds;
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
    return nearbyLabel(el);
  }
  function shownLabel(el) {
    const shown = cleanLabel(visibleText(el));
    if (!shown || PICK_PLACEHOLDER.test(shown)) return textAbove(el) || shown;
    const chosen = ownedLists(el).flatMap((l) => [...l.querySelectorAll('[role="option"][aria-selected="true"]')]);
    return chosen.some((o) => normalise(o.textContent ?? "") === normalise(shown) || normalise(o.getAttribute("data-value") ?? "") === normalise(shown)) ? "" : shown;
  }
  function visibleText(node) {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1 || node.hidden || node.getAttribute("aria-hidden") === "true") return "";
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style && (style.display === "none" || style.visibility === "hidden")) return "";
    let out = "";
    let previous = "";
    for (const child of node.childNodes) {
      const text = visibleText(child);
      if (child.nodeType === 1) {
        const key = normalise(text);
        if (key && key === previous) continue;
        if (key && previous && !/\s$/.test(out)) out += " ";
        previous = key;
      } else if (text.trim()) {
        previous = "";
      }
      out += text;
    }
    return out;
  }
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
  function inputDropdownValue(el, { widgetOnly = false } = {}) {
    const own = widgetOnly ? "" : el.value?.trim();
    if (own) return PICK_PLACEHOLDER.test(own) ? "" : own;
    let box = el.parentElement;
    for (let i = 0; i < 3 && box && box !== el.ownerDocument.body; i++, box = box.parentElement) {
      if (box.querySelectorAll("input, select, textarea, label").length > 1 || box.querySelector('[role="option"], li')) break;
      const shown = cleanLabel(visibleText(box));
      if (shown) return PICK_PLACEHOLDER.test(shown) ? "" : shown;
    }
    box = el.parentElement;
    for (let i = 0; i < 6 && box && box !== el.ownerDocument.body; i++, box = box.parentElement) {
      if (box.querySelectorAll('input[role="combobox"], select').length > 1) break;
      const single = box.querySelector('[class*="single-value" i], [class*="singleValue" i]');
      const picked = single ? cleanLabel(single.textContent) : "";
      if (picked) return PICK_PLACEHOLDER.test(picked) ? "" : picked;
      const note = box.querySelector("[aria-live]")?.textContent?.match(/^\s*option\s+(.+?),\s*selected\.?\s*$/i);
      if (note) return cleanLabel(note[1]);
    }
    return "";
  }
  function widgetPick(el) {
    return el.matches?.("input") && el.matches('[role="combobox"]') ? inputDropdownValue(el, { widgetOnly: true }) : "";
  }
  function namedChoice(el) {
    if (el.getAttribute("role") !== "combobox" || el.matches("input, textarea, select")) return "";
    const doc = el.ownerDocument;
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).slice(1);
    const named = cleanLabel(ids.map((id) => doc.getElementById(id)?.textContent ?? "").join(" "));
    return !named || PICK_PLACEHOLDER.test(named) || EMPTY_OPTION.test(named) ? "" : named;
  }
  function dropdownValue(field, options = {}) {
    const el = field.el;
    if (el.matches("input")) return inputDropdownValue(el, options);
    const selected = el.querySelector('[role="option"][aria-selected="true"]');
    if (selected) {
      const text = selected.textContent.trim();
      return /^choose$/i.test(text) ? "" : selected.getAttribute("data-value") ?? text;
    }
    const named = namedChoice(el);
    if (named) return named;
    if (!field.custom) return "";
    if (el.matches(".mat-mdc-select-empty, .mat-select-empty") || el.querySelector(".mat-mdc-select-placeholder, .mat-select-placeholder")) return "";
    const valueText = el.querySelector(".mat-mdc-select-value-text, .mat-select-value-text");
    const shown = cleanLabel(valueText ? visibleText(valueText) : visibleText(el));
    const same = normalise(shown) === normalise(field.label ?? "");
    return !shown || same || EMPTY_OPTION.test(shown) ? "" : shown;
  }
  const INLINE = /* @__PURE__ */ new Set(["B", "I", "EM", "STRONG", "SMALL", "SPAN", "SVG", "IMG", "BR"]);
  const SHOWN_LIMIT = 4e3;
  function shownTexts(doc, checkLayout) {
    const out = /* @__PURE__ */ new Set();
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
  function appearedOptions(before, doc, checkLayout) {
    const groups = /* @__PURE__ */ new Map();
    for (const leaf of shownTexts(doc, checkLayout)) {
      if (before.has(leaf)) continue;
      let item = leaf;
      while (item.parentElement && item.parentElement !== doc.body && item.parentElement.childElementCount === 1) item = item.parentElement;
      const holder = item.parentElement;
      if (!holder) continue;
      if (!groups.has(holder)) groups.set(holder, /* @__PURE__ */ new Set());
      groups.get(holder).add(item);
    }
    let best = [];
    for (const items of groups.values()) if (items.size > best.length) best = [...items];
    return best.length >= 2 ? best.map((o) => ({ text: optionText(o), el: o })) : [];
  }
  function openOptions(field, before = null) {
    const el = field.el;
    const doc = el.ownerDocument;
    const named = el.id ? [`${el.id}-list`, `${el.id}-listbox`] : [];
    const owned = [...["aria-controls", "aria-owns"].map((a) => el.getAttribute(a)).filter(Boolean), ...named].map((id) => doc.getElementById(id)).filter(Boolean);
    const scopes = owned.length ? owned : [doc];
    const options = scopes.flatMap((s) => [...s.querySelectorAll('[role="option"], mat-option')]).filter((o) => isVisible(o, field.layout)).map((o) => ({ text: optionText(o), el: o }));
    return options.length || !before ? options : appearedOptions(before, doc, field.layout);
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function press(el, types) {
    const win = el.ownerDocument.defaultView;
    for (const type of types) el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win }));
  }
  function dismiss(el, stillOpen = () => false) {
    const win = el.ownerDocument.defaultView;
    for (const target of [el, el.ownerDocument.activeElement]) {
      target?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    if (stillOpen()) press(el.ownerDocument.body, ["mousedown", "mouseup", "click"]);
  }
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
    let option = options.length ? chooseOption(options, answer, { strict }) : null;
    if (!option && options.length) option = await scrollToOption(field, before, options, answer, strict, pollMs);
    if (!option) {
      dismiss(el, () => openOptions(field, before).length > 0);
      return null;
    }
    press(option.el, ["mousedown", "mouseup", "click"]);
    await sleep(pollMs);
    return option.text;
  }
  async function scrollToOption(field, before, options, answer, strict, pollMs) {
    let scroller = options[0].el.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
    if (!scroller) return null;
    scroller.scrollTop = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(pollMs);
      const found = chooseOption(openOptions(field, before), answer, { strict });
      if (found) return found;
      const at = scroller.scrollTop;
      scroller.scrollTop = at + Math.max(40, scroller.clientHeight * 0.8);
      if (scroller.scrollTop === at) return null;
    }
    return null;
  }
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
      for (let i = 0; i < polls && openOptions(field).length; i++) await sleep(pollMs);
      if (options.length) break;
    }
    const seen = /* @__PURE__ */ new Set();
    return options.map((o) => ({ text: cleanLabel(o.text) })).filter((o) => !isPlaceholderOption(o.text) && !seen.has(o.text) && seen.add(o.text));
  }
  function isInvalid(field) {
    const el = field.kind === "radio" && !field.aria ? field.options[0]?.el : field.el;
    if (!el?.getAttribute) return false;
    if (el.getAttribute("aria-invalid") === "true") return true;
    if (el.matches(".ng-invalid.ng-touched, .is-invalid, .mat-form-field-invalid *")) return true;
    if (field.kind === "text" && el.value && el.validity && !el.validity.valid) return true;
    return false;
  }
  function invalidReason(field) {
    const el = field.el;
    const doc = el.ownerDocument;
    const ids = `${el.getAttribute("aria-errormessage") ?? ""} ${el.getAttribute("aria-describedby") ?? ""}`;
    const described = cleanLabel(textOfIds(doc, ids.trim()));
    const box = el.closest("mat-form-field, .form-group, [class*=form-field i], [class*=field i]") ?? el.parentElement?.parentElement;
    const shown = box?.querySelector('mat-error, [role="alert"], .invalid-feedback, [class*=error i]');
    const text = described || cleanLabel(shown?.textContent ?? "") || (el.validationMessage ?? "");
    return text.length > 140 ? `${text.slice(0, 137)}\u2026` : text;
  }
  function numericVariants(value) {
    const s = String(value ?? "");
    const core = /\d[\d,]*(\.\d+)?/.exec(s)?.[0];
    if (!core || core === s || !/[a-z]/i.test(s)) return [];
    return [.../* @__PURE__ */ new Set([core, core.replace(/,/g, "")])].filter((v) => v !== s);
  }
  function labelOfOption(radio) {
    const id = radio.getAttribute("id");
    const doc = radio.ownerDocument;
    const label = id && doc.querySelector(`label[for="${CSS.escape(id)}"]`) || radio.closest("label");
    return cleanLabel(label?.textContent || radio.getAttribute("aria-label") || radio.value);
  }
  const MIN_NATIONAL_DIGITS = 6;
  const PHONE_BOX = /^(?:(?:your|primary|mobile|cell|contact|work|home|best) )*(?:phone|mobile|telephone|cell(?:phone)?|whatsapp)(?: ?(?:number|no\.?|#))?\W*$|^contact (?:number|no\.?)\W*$/i;
  const PHONE_COUNTRY_LABEL = /^(?:select |choose |your )?(?:(?:phone|mobile|telephone|tel|cell|whatsapp|contact)(?: (?:number|no\.?))? ?)?(?:country|region|flag|dial(?:l?ing)?|calling|international)?(?: ?(?:code|prefix|selector|picker|dropdown))?\W*$/i;
  function phoneProgress(value) {
    const t = String(value ?? "").trim();
    const digits = t.replace(/\D/g, "");
    if (!digits) return { state: "empty", code: null, national: "" };
    const intl = splitInternational(t);
    const national = intl ? intl.national : t.startsWith("+") && digits.length <= 4 ? "" : digits;
    const state = !national ? "prefix" : national.length < MIN_NATIONAL_DIGITS ? "partial" : "complete";
    return { state, code: intl?.code ?? null, national };
  }
  function dialOf(text) {
    const t = String(text ?? "");
    const explicit = /\+\s*(\d{1,4})(?!\d)/.exec(t)?.[1];
    if (explicit) return DIAL_COUNTRIES[explicit] ? `+${explicit}` : null;
    const n = ` ${normalise(t)} `;
    if (n.trim() === "") return null;
    for (const [code, names] of Object.entries(DIAL_COUNTRIES)) {
      if (names.some((name) => n.includes(` ${normalise(name)} `))) return `+${code}`;
    }
    return null;
  }
  function countriesFor(answer) {
    const code = /^\+\s*(\d{1,4})$/.exec(String(answer ?? "").trim())?.[1];
    return code ? DIAL_COUNTRIES[code] ?? [] : [];
  }
  function isPhoneBox(field) {
    const el = field.el;
    if (field.kind !== "text" || !el?.matches) return false;
    if (el.matches("input[type=tel]")) return true;
    return el.matches("input:not([type]), input[type=text]") && PHONE_BOX.test(field.label ?? "");
  }
  function phoneInputFor(control, explicitLabel) {
    if (control.matches("input[type=tel]") || !PHONE_COUNTRY_LABEL.test(cleanLabel(explicitLabel))) return null;
    const owned = new Set(ownedLists(control));
    const outside = (n) => n !== control && !control.contains(n) && ![...owned].some((l) => l.contains(n));
    for (let node = control.parentElement, depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const boxes = [...node.querySelectorAll("input")].filter((i) => outside(i) && isPhoneBox({ kind: "text", el: i, label: i.matches("input[type=tel]") ? "" : labelOf(i) }));
      const others = [...node.querySelectorAll(`${CUSTOM_DROPDOWN}, select`)].filter((n) => outside(n) && !n.matches("input"));
      if (others.length || boxes.length > 1) return null;
      if (boxes.length === 1) return boxes[0];
    }
    return null;
  }
  function ownedLists(el) {
    return ["aria-controls", "aria-owns"].map((a) => el.getAttribute(a)).filter(Boolean).flatMap((ids) => ids.split(/\s+/)).map((id) => el.ownerDocument.getElementById(id)).filter(Boolean);
  }
  function phoneCountryLabel(telLabel) {
    const base = cleanLabel(telLabel).replace(/\s*(?:number|no\.?|#)$/i, "").trim();
    return `${base || "Phone"} country code`;
  }
  function countryText(countryField) {
    if (countryField.kind === "select") {
      const chosen = countryField.el.options[countryField.el.selectedIndex];
      return chosen && !isPlaceholderOption(chosen.text) ? cleanLabel(chosen.text) : "";
    }
    return dropdownValue(countryField);
  }
  function phoneAgrees(telField, countryField) {
    const have = phoneProgress(telField.el.value);
    if (have.state !== "complete") return false;
    const shown = countryField ? dialOf(countryText(countryField)) : null;
    return !have.code || !shown || have.code === shown;
  }
  function phonePlan(field, answer) {
    const parsed = splitInternational(answer);
    const country = field.phoneCountry ?? null;
    const current = String(field.el.value ?? "").trim();
    const prefix = splitInternational(current)?.code ?? null;
    const international = current.startsWith("+");
    if (!parsed) {
      if (!country && !international) return { ok: true, text: String(answer).trim() };
      return { ok: false, reason: "Add your country code to the number" };
    }
    const widget = prefix ?? (country ? dialOf(countryText(country)) : null);
    if (widget && widget !== parsed.code) return { ok: false, needCountry: parsed.code, reason: `Choose ${parsed.code} as the country first` };
    if (!country && !international) return { ok: true, text: String(answer).trim() };
    return { ok: true, text: international ? `${parsed.code} ${parsed.national}` : parsed.national };
  }
  async function applyPhone(field, answer) {
    let plan = phonePlan(field, answer);
    const country = field.phoneCountry;
    if (!plan.ok && plan.needCountry && country) {
      const picked = country.kind === "select" ? apply(country, plan.needCountry) : await pickDropdown(country, plan.needCountry);
      if (picked === null) return { ok: false, reason: plan.reason };
      await sleep(150);
      plan = phonePlan(field, answer);
    }
    if (!plan.ok) return { ok: false, reason: plan.reason };
    if (apply(field, answer) === null) return { ok: false, reason: "This number doesn't fit the field." };
    await sleep(150);
    const want = splitInternational(answer)?.national ?? String(answer).replace(/\D/g, "");
    const got = phoneProgress(field.el.value);
    const keeps = got.national === want || got.national.endsWith(want) || want.endsWith(got.national);
    if (got.state !== "complete" || !keeps || country && !phoneAgrees(field, country)) {
      return { ok: false, reason: "The site didn't keep the phone number", value: field.el.value };
    }
    return { ok: true, value: field.el.value };
  }
  function setValue(el, value) {
    const win = el.ownerDocument.defaultView;
    el.focus?.();
    let nativeEdit = false;
    if (el.matches('[role="textbox"][contenteditable]')) {
      const selection = win.getSelection();
      if (selection && typeof el.ownerDocument.execCommand === "function") {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        nativeEdit = el.ownerDocument.execCommand("insertText", false, String(value));
      }
      if (!nativeEdit) el.textContent = value;
    } else {
      const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    }
    if (!nativeEdit) el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: String(value) }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    win.setTimeout(() => {
      if (el.isConnected && el.ownerDocument.activeElement === el) el.blur?.();
    }, 50);
  }
  function textValue(el) {
    return el.matches('[role="textbox"][contenteditable]') ? el.innerText ?? el.textContent ?? "" : el.value ?? "";
  }
  function normalise(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
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
    if (/^\+\s*\d{1,4}$/.test(String(answer).trim())) return chooseDialOption(options, answer);
    if (strict) return null;
    const days = durationDays(answer);
    if (days !== null) {
      const same = options.filter((o) => durationDays(o.text) === days);
      if (same.length === 1) return same[0];
    }
    const words = ` ${a} `;
    const tiers = [
      options.filter((o) => ` ${normalise(o.text)} `.includes(words)),
      options.filter((o) => normalise(o.text).startsWith(a))
    ];
    for (const tier of tiers) if (tier.length === 1) return tier[0];
    const plain = (t) => normalise(String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
    const parts = String(answer).split(",").map(plain).filter(Boolean);
    if (parts.length >= 2) {
      const placed = options.filter((o) => {
        const t = ` ${plain(o.text)} `;
        return parts.every((part) => t.includes(` ${part} `));
      });
      if (placed.length === 1) return placed[0];
    }
    const contained = options.filter((o) => {
      const t = normalise(o.text);
      return t && (a.includes(t) || t.includes(a));
    });
    return contained.length === 1 ? contained[0] : null;
  }
  function durationDays(text) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const units = [[/^(?:d|days?)$/, 1], [/^(?:w|wks?|weeks?)$/, 7], [/^(?:mos?|months?)$/, 30], [/^(?:y|yrs?|years?)$/, 365]];
    const m = /^\s*(?:about|around|approx\.?)?\s*(\d{1,3}|[a-z]+)\s*[- ]?\s*([a-z]+)\.?(?:\s+notice)?\s*$/i.exec(String(text ?? ""));
    if (!m) return null;
    const count = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
    const unit = units.find(([pattern]) => pattern.test(m[2].toLowerCase()));
    return count && unit ? count * unit[1] : null;
  }
  function chooseDialOption(options, answer) {
    const code = String(answer).replace(/\D/g, "");
    const listed = options.filter((o) => normalise(o.text).split(" ").includes(code) && /\+/.test(o.text));
    if (listed.length) return listed[0];
    for (const name of countriesFor(String(answer).trim())) {
      const hit = options.find((o) => ` ${normalise(o.text)} `.includes(` ${normalise(name)} `));
      if (hit) return hit;
    }
    return null;
  }
  function isEmpty(field) {
    switch (field.kind) {
      case "text":
        return isPhoneBox(field) ? phoneProgress(field.el.value).state !== "complete" : !textValue(field.el).trim() && !widgetPick(field.el);
      case "select":
        return !field.el.value || field.el.selectedIndex <= 0 && field.el.options[0]?.value === "" || isPlaceholderOption(field.el.options[field.el.selectedIndex]?.text) || (field.phoneFor ? !phoneAgrees(field.phoneFor, field) : false);
      case "radio":
        return field.aria ? !field.options.some((o) => o.el.getAttribute(field.pressed ? "aria-pressed" : "aria-checked") === "true") : !field.options.some((o) => o.el.checked);
      case "file":
        return !field.el.files?.length;
      case "dropdown":
        if (field.phoneFor) return !countryText(field) || !phoneAgrees(field.phoneFor, field);
        if (field.el.closest('[data-testid="phone_number-code"]') && !field.el.ownerDocument.querySelector('[data-input="phone_number"]')?.value?.trim()) return true;
        return !dropdownValue(field);
      default:
        return true;
    }
  }
  function apply(field, answer, { strict = false } = {}) {
    const win = field.el.ownerDocument.defaultView;
    if (field.kind === "text") {
      let value = answer;
      if (field.el.matches("input[type=date], input.ashby-application-form-input-date")) {
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
      } else if (isPhoneBox(field)) {
        const plan = phonePlan(field, answer);
        if (!plan.ok) return null;
        value = plan.text;
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
  function attachFile(input, file) {
    const win = input.ownerDocument.defaultView;
    const dt = new win.DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
  }
  const CONFIRMATION_SEGMENT = /^(?:thanks?|thank-?you|confirmation|confirmed|submitted|success|applied|complete[d]?|application-(?:submitted|received|complete[d]?))$/i;
  function confirmationPath(url) {
    try {
      return new URL(url).pathname.split("/").some((segment) => CONFIRMATION_SEGMENT.test(segment));
    } catch {
      return false;
    }
  }
  function looksSubmitted(doc, url) {
    const u = new URL(url);
    if (u.hostname === "docs.google.com" && u.pathname.endsWith("/formResponse")) {
      const hasQuestions = doc.querySelector('[role="listitem"] input:not([type=hidden]), [role="listitem"] textarea');
      return !hasQuestions;
    }
    return confirmationPath(url);
  }
  const SUBMIT_TEXT = /\b(submit|apply|send( my)? application)\b/i;
  const NOT_SUBMIT = /\b(next|continue|back|previous|save|draft|cancel|later|linkedin|indeed|google|sign ?in|log ?in|upload|attach)\b/i;
  function buttonText(el) {
    return cleanLabel(el.getAttribute("aria-label") || (el.tagName === "INPUT" ? el.value : el.textContent));
  }
  function findSubmitButton(doc, fields, { checkLayout = true, includeDisabled = false } = {}) {
    const forms = new Set(fields.map((f) => f.el.closest?.("form")).filter(Boolean));
    const scope = forms.size === 1 ? [...forms][0] : doc;
    const usable = (el) => isVisible(el, checkLayout) && (includeDisabled || !el.disabled && el.getAttribute("aria-disabled") !== "true");
    const candidates = [...scope.querySelectorAll('button, input[type=submit], [role="button"]')].filter((el) => {
      if (!usable(el) || el.type === "reset") return false;
      const text = buttonText(el);
      const formSend = forms.size === 1 && forms.has(el.form) && el.matches('input[type="submit"], button[type="submit"]') && /^send$/i.test(text);
      return (SUBMIT_TEXT.test(text) || formSend) && !NOT_SUBMIT.test(text);
    });
    const outermost = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
    return outermost.length === 1 ? outermost[0] : null;
  }
  function firstSentence(label) {
    const m = /^(.{6,}?[?.:])\s+\S/.exec(label);
    return m ? m[1] : label;
  }
  globalThis.JobHuntFill = {
    cleanLabel,
    isPlaceholderOption,
    firstSentence,
    labelOf,
    isRequired,
    collectFields,
    applicationControl,
    profileAnswer,
    chooseOption,
    isPhoneBox,
    phoneProgress,
    phoneAgrees,
    applyPhone,
    phonePlan,
    splitInternational,
    dialOf,
    countryText,
    visibleText,
    isEmpty,
    isInvalid,
    invalidReason,
    numericVariants,
    dropdownValue,
    widgetPick,
    pickDropdown,
    readDropdownOptions,
    shownTexts,
    appearedOptions,
    apply,
    textValue,
    attachFile,
    findSubmitButton,
    looksSubmitted,
    confirmationPath
  };
})();
