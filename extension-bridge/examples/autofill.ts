// Example: what an extension does on a job page. It fills, it never submits.
// A real extension would run fill() in a content script and the bridge calls in its
// background worker (message passing omitted here for brevity).

import { JobHuntBridge, autofillIdFromUrl, type ExtensionProfile, type FieldReport } from "../client";

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // React-controlled inputs ignore plain `.value =`; use the native setter, then notify.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function labelOf(el: Element): string {
  const id = el.getAttribute("id");
  const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
  return (label?.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "").trim();
}

function valueFor(label: string, p: ExtensionProfile, coverLetter: string | null): string | null {
  const l = label.toLowerCase();
  const [first, ...rest] = (p.full_name ?? "").split(" ");
  if (/first name/.test(l)) return first || null;
  if (/last name|surname/.test(l)) return rest.join(" ") || null;
  if (/full name|^name/.test(l)) return p.full_name;
  if (/e-?mail/.test(l)) return p.email;
  if (/phone|mobile/.test(l)) return p.phone;
  if (/linkedin/.test(l)) return p.links.find((x) => /linkedin/i.test(x.url))?.url ?? null;
  if (/github/.test(l)) return p.links.find((x) => /github/i.test(x.url))?.url ?? null;
  if (/cover letter/.test(l)) return coverLetter;
  return null;
}

export async function autofill(bridge: JobHuntBridge): Promise<void> {
  const id = autofillIdFromUrl(location.href) ?? (await bridge.lookup(location.href))?.id;
  if (!id) return;
  const [profile, app] = await Promise.all([bridge.profile(), bridge.application(id)]);
  await bridge.report({ application_id: id, event: "opened", url: location.href });

  const filled: FieldReport[] = [];
  const unresolved: FieldReport[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input[type=text], input[type=email], input[type=tel], input[type=url], input:not([type]), textarea",
  )) {
    const label = labelOf(el);
    if (!label || el.value) continue;
    let value = valueFor(label, profile, app.cover_letter);
    if (value === null) {
      const s = await bridge.suggestAnswer({ question: label, application_id: id, allow_generate: false });
      value = s.answer;
    }
    if (value) {
      setValue(el, value);
      filled.push({ label, value });
    } else if (el.required) {
      unresolved.push({ label, reason: "no answer" });
    }
  }
  await bridge.report({ application_id: id, event: "filled", filled_fields: filled, unresolved_fields: unresolved });

  // The user reviews and clicks the site's own submit button. Report it afterwards.
  document.querySelector("form")?.addEventListener(
    "submit",
    () => void bridge.report({ application_id: id, event: "submitted", url: location.href }),
    { once: true },
  );
}
