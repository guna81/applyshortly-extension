// Field discovery and filling. Pure DOM logic with no chrome.* calls, so test/fill.test.mjs can
// run it in jsdom. Exposed as globalThis.JobHuntFill for content.js (content scripts aren't modules).
//
// Rules shared with the server-side filler: fill only empty fields, never tick a checkbox (consent
// boxes are always the user's call), never click submit.

(() => {
  const TEXT_INPUT = 'input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input:not([type]), textarea';

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

  /** The human-readable question for a field, trying the usual ways forms attach one. */
  function labelOf(el) {
    const doc = el.ownerDocument;
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
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, option").forEach((n) => n.remove());
      if (cleanLabel(clone.textContent)) return cleanLabel(clone.textContent);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && cleanLabel(aria)) return cleanLabel(aria);
    // Google Forms and similar: the question heading lives in the enclosing list item.
    const heading = el.closest('[role="listitem"]')?.querySelector('[role="heading"]');
    if (heading && cleanLabel(heading.textContent)) return cleanLabel(heading.textContent);
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend && cleanLabel(legend.textContent)) return cleanLabel(legend.textContent);
    const nearby = nearbyLabel(el);
    if (nearby) return nearby;
    return cleanLabel(el.getAttribute("placeholder") || el.getAttribute("name") || "");
  }

  /**
   * A label that sits next to the field without being linked to it (no for/id, not wrapping):
   * the closest preceding label-like sibling, checked at the field and then up to two ancestors.
   * Placeholders are sample values on many forms ("Arjun"), so this must win over them.
   */
  function nearbyLabel(el) {
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

  function isRequired(el) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    const item = el.closest('[role="listitem"]');
    return Boolean(item?.querySelector('[aria-label="Required question"]'));
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
    return cleanLabel(el.getAttribute("data-value") || el.getAttribute("aria-label") || el.textContent || el.value);
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
      if (!visible(el) || !isEditable(el)) continue;
      fields.push({ kind: "text", el, label: labelOf(el), required: isRequired(el) });
    }
    for (const el of doc.querySelectorAll("select")) {
      if (!visible(el) || !isEditable(el)) continue;
      const options = [...el.options].filter((o) => o.value !== "").map((o) => ({ text: cleanLabel(o.text), el: o }));
      fields.push({ kind: "select", el, label: labelOf(el), required: isRequired(el), options });
    }
    const radioGroups = new Map();
    for (const el of doc.querySelectorAll("input[type=radio]")) {
      if (!visible(el) || !isEditable(el)) continue;
      const key = el.name || el.closest("fieldset") || el;
      if (!radioGroups.has(key)) radioGroups.set(key, []);
      radioGroups.get(key).push(el);
    }
    for (const radios of radioGroups.values()) {
      const first = radios[0];
      const group = first.closest('fieldset, [role="radiogroup"]');
      const label = group ? labelOf(group) || labelOf(first) : labelOf(first);
      const options = radios.map((r) => ({ text: labelOfOption(r), el: r }));
      fields.push({ kind: "radio", el: first, label, required: radios.some(isRequired), options });
    }
    for (const group of doc.querySelectorAll('[role="radiogroup"]')) {
      const options = [...group.querySelectorAll('[role="radio"]')].map((r) => ({ text: optionText(r), el: r }));
      if (!options.length || !visible(group)) continue;
      fields.push({ kind: "radio", el: group, label: labelOf(group), required: isRequired(group), options, aria: true });
    }
    for (const el of doc.querySelectorAll('input[type=checkbox], [role="checkbox"]')) {
      if (!visible(el)) continue;
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

    if (/first name|given name/.test(l)) return sure(first);
    if (/last name|surname|family name/.test(l)) return sure(rest.join(" "));
    if (/full name|^(your )?name\b|candidate name|applicant name/.test(l)) return sure(profile.full_name);
    if (/e-?mail/.test(l)) return sure(profile.email);
    if (/phone|mobile|contact (number|no)|whatsapp|telephone/.test(l)) return sure(profile.phone);
    if (/linkedin/.test(l)) return sure(link(/linkedin/i));
    if (/github/.test(l)) return sure(link(/github/i));
    if (/portfolio|personal (web)?site|^website/.test(l)) return sure(link(/portfolio|website|^https?:\/\/(?!.*(linkedin|github))/i));
    if (/^(current )?(location|city)\b|current (city|location)|where are you (currently )?(based|located)/.test(l)) {
      return sure(profile.location);
    }
    if (/\b(total|overall)\b.{0,40}\bexperience\b|^(how many )?years of (total |overall |professional |work |full[- ]time )?experience\W*$/.test(l)) {
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
    if (/highest (educational |education )?(qualification|degree|education)/.test(l)) {
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
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    el.dispatchEvent(new win.FocusEvent("blur", { bubbles: false }));
  }

  function normalise(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /** The option an answer refers to: exact, then yes/no, then containment either way. */
  function chooseOption(options, answer) {
    const a = normalise(answer);
    if (!a) return null;
    const exact = options.find((o) => normalise(o.text) === a);
    if (exact) return exact;
    const yesNo = /^(yes|no)\b/.exec(a)?.[1];
    if (yesNo) {
      const match = options.find((o) => new RegExp(`^${yesNo}\\b`).test(normalise(o.text)));
      if (match) return match;
    }
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
        return !field.el.value || field.el.selectedIndex <= 0 && field.el.options[0]?.value === "";
      case "radio":
        return field.aria
          ? !field.options.some((o) => o.el.getAttribute("aria-checked") === "true")
          : !field.options.some((o) => o.el.checked);
      case "file":
        return !field.el.files?.length;
      default:
        return true;
    }
  }

  /** Applies an answer to a field. Returns the value actually written, or null if none fit. */
  function apply(field, answer) {
    const win = field.el.ownerDocument.defaultView;
    if (field.kind === "text") {
      let value = answer;
      if (field.el.type === "number") {
        const n = /-?\d+(\.\d+)?/.exec(answer)?.[0];
        if (!n) return null;
        value = n;
      }
      setValue(field.el, value);
      return value;
    }
    if (field.kind === "select") {
      const option = chooseOption(field.options, answer);
      if (!option) return null;
      field.el.value = option.el.value;
      field.el.dispatchEvent(new win.Event("input", { bubbles: true }));
      field.el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return option.text;
    }
    if (field.kind === "radio") {
      const option = chooseOption(field.options, answer);
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

  /** "Current CTC? Mention fixed and variable…" → "Current CTC?" */
  function firstSentence(label) {
    const m = /^(.{6,}?[?.:])\s+\S/.exec(label);
    return m ? m[1] : label;
  }

  globalThis.JobHuntFill = {
    cleanLabel,
    firstSentence,
    labelOf,
    collectFields,
    profileAnswer,
    chooseOption,
    isEmpty,
    apply,
    attachFile,
    looksSubmitted,
  };
})();
