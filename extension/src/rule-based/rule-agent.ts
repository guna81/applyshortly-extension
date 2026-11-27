// Local deterministic rule-based form agent (0 LLM calls, 0 server step calls).
// Self-contained engine under src/rule-based/ (zero imports from src/agent-based/).
import { choiceState, isChoiceOption, matchChoice, optionsOf, scanFields } from "../page-control/commands.js";
import { hasApplicationFields } from "../page-control/loop.js";
import { durationDays, factMatches, profileFact } from "../shared/profile-facts.js";

// One action per step costs 0 LLM/network calls locally and lets the loop re-observe after every write
// so mid-run user edits and dynamic conditional fields are caught immediately.
const MAX_BATCH = 1;
const MAX_FIELD_ATTEMPTS = 2;
const NAV_BUTTON = /^\s*(?:apply(?: now| for this job)?|next(?:\s+step)?|continue|save\s*(?:and|&)\s*continue|proceed)\b/i;
const FORBIDDEN_CLICK = /\b(?:submit|send|finish|complete application|sign.?in|log.?in|register|accept|agree|authorize|confirm|pay|purchase)\b/i;
const COOKIE_DECLINE = /^(?:reject|decline|deny|refuse|opt[- ]?out)\b.*|\b(?:necessary|essential) (?:cookies )?only\b|\bonly (?:necessary|essential)\b/i;
const PLACEHOLDER = /^(?:select|choose|pick|please select|--|none selected)[…\s.-]*$/i;
const BOT_CHECK = /\b(?:not a (?:robot|bot)|i(?:'| a)?m human|i am human|verify (?:that )?you(?:'re| are) (?:a )?human|human verification)\b/i;
const NEWSLETTER_OR_ALERT = /\b(?:newsletter|subscribe|subscription|job\s+alerts?|weekly\s+digest|daily\s+digest|mailing\s+list|email\s+alerts?|notify\s+me)\b/i;
const CONSENT_OR_LEGAL = /\b(?:consent|certify|declare|swear|truthful|agree|accept|confirm|privacy policy|terms|visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|criminal|convict|felon|previously (?:employed|worked)|former(?:ly)? (?:employee|employed)|employment agreements?|post-employment restrictions?|non-?compete|conflict of interest)\b/i;
const YES_NO_QUESTION = /^\s*(?:are|do|does|did|have|has|had|will|would|can|could|should|is|were|was)\s+(?:you|there|this|it)\b/i;
const DIAL_COUNTRIES: Record<string, string> = { "+1": "United States", "+44": "United Kingdom", "+91": "India", "+61": "Australia", "+49": "Germany", "+33": "France", "+65": "Singapore", "+81": "Japan", "+86": "China", "+55": "Brazil" };

const normalizeObservation = (observation: any) => ({
  ...observation,
  elements: (observation?.elements ?? []).map((el: any) =>
    (el.role === "combobox" || (el.popup && el.role === "textbox")) ? { ...el, role: "combobox", popup: true } : el),
});

const questionKey = (text: any) => `q:${String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
const identityOf = (obs: any, el: any) => JSON.stringify([obs.url, el?.frame, el?.section, el?.identity ?? "", el?.name, el?.group, el?.role]);
const groupKeyOf = (obs: any, el: any) => (el?.group ? JSON.stringify([obs.url, el.frame, el.section, el.group, "choice"]) : null);
const onLastStep = (text: any) => {
  const body = String(text ?? "");
  const counted = /\bstep\s+(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(body);
  if (counted) return Number(counted[1]) >= Number(counted[2]);
  return /\b(?:final|last) step\b|\breview (?:and|&) submit\b/i.test(body);
};

const latestExperience = (profile: any) => {
  const jobs = [...(profile?.experience ?? [])];
  jobs.sort((a, b) => (a.is_current !== b.is_current ? (a.is_current ? -1 : 1) : String(b.end_date ?? "9999").localeCompare(String(a.end_date ?? "9999"))));
  return jobs[0] ?? null;
};

const highestEducation = (profile: any) => {
  const edu = [...(profile?.education ?? [])];
  edu.sort((a, b) => Number(b.end_year ?? 0) - Number(a.end_year ?? 0));
  return edu[0] ?? null;
};

const extractDialCode = (phone: any): string => (/^\s*(\+\d{1,3})\b/.exec(String(phone ?? ""))?.[1] ?? "");

const stripDialCode = (phone: any): string => String(phone ?? "").replace(/^\s*\+\d{1,3}[\s.-]*/, "").trim();

const fieldLabel = (el: any): string => String(el?.group || el?.name || "").trim();

const cleanFieldName = (el: any): string => fieldLabel(el)
  .replace(/\s*\((?:required|optional)\)\s*$/i, "")
  .replace(/[\s*:✱]+$/, "")
  .trim();

const fieldKindOf = (el: any): string => {
  if (["textarea", "select", "combobox", "radio", "checkbox", "file"].includes(el?.role)) return el.role;
  if (isChoiceOption(el)) return "radio";
  return "text";
};

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "with", "about", "your", "you", "us",
  "tell", "please", "describe", "share", "what", "how", "why", "where", "when", "who",
  "is", "are", "was", "were", "do", "does", "did", "have", "has", "had", "that", "this",
  "these", "those", "by", "from", "at", "as", "or", "and", "be", "been", "being", "can",
  "could", "would", "should", "will", "we", "our", "it", "its", "me", "my", "i", "any",
  "if", "so", "not", "no", "yes", "ve", "re", "ll", "m", "s", "t",
]);

const normalizeText = (text: any): string => String(text ?? "")
  .toLowerCase()
  .replace(/['’]/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const contentTokens = (text: any): string[] => normalizeText(text)
  .split(/\s+/)
  .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

function matchSavedAnswer(el: any, profile: any): { answer: string; answer_id?: number } | null {
  const answers = Array.isArray(profile?.answers) ? profile.answers : [];
  if (!answers.length) return null;
  const rawLabel = fieldLabel(el);
  if (!rawLabel) return null;
  const section = String(el.section ?? "");
  const l = rawLabel.toLowerCase();
  if (CONSENT_OR_LEGAL.test(l) || /\breference\b/.test(`${section} ${rawLabel}`.toLowerCase())) return null;

  const normLabel = normalizeText(rawLabel);
  if (!normLabel) return null;

  const patternsOf = (entry: any): string[] => [
    entry?.question_pattern,
    ...(Array.isArray(entry?.question_variants) ? entry.question_variants : []),
  ].filter((p: any) => typeof p === "string" && p.trim());

  // 1. Exact normalized match on question_pattern or any stored question_variants.
  for (const entry of answers) {
    const ans = String(entry?.answer ?? "").trim();
    if (!ans) continue;
    if (patternsOf(entry).some((p) => normalizeText(p) === normLabel)) {
      return { answer: ans, ...(typeof entry?.id === "number" ? { answer_id: entry.id } : {}) };
    }
  }

  // 2. High-confidence content-token overlap (deterministic, no LLM).
  // Never fuzzy-match Yes/No questions (exact match above is still allowed).
  if (YES_NO_QUESTION.test(l)) return null;
  const labelTokens = new Set(contentTokens(rawLabel));
  if (labelTokens.size < 2) return null;

  let best: { answer: string; answer_id?: number; score: number } | null = null;
  for (const entry of answers) {
    const ans = String(entry?.answer ?? "").trim();
    if (!ans) continue;
    for (const pat of patternsOf(entry)) {
      const patTokens = new Set(contentTokens(pat));
      if (patTokens.size < 2) continue;
      let shared = 0;
      for (const tok of labelTokens) if (patTokens.has(tok)) shared += 1;
      if (shared < 2) continue;
      const union = labelTokens.size + patTokens.size - shared;
      const jaccard = shared / union;
      if (jaccard >= 0.65) {
        if (!best || jaccard > best.score) {
          best = { answer: ans, ...(typeof entry?.id === "number" ? { answer_id: entry.id } : {}), score: jaccard };
        }
      }
    }
  }
  return best ? { answer: best.answer, ...(best.answer_id !== undefined ? { answer_id: best.answer_id } : {}) } : null;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatFilledSummary(entries: Array<{ kind: "fill" | "upload"; label: string }>): string {
  const filled: string[] = [];
  const attached: string[] = [];
  for (const e of entries) {
    if (!e.label) continue;
    if (e.kind === "upload") {
      if (!attached.includes(e.label)) attached.push(e.label);
    } else if (!filled.includes(e.label)) {
      filled.push(e.label);
    }
  }
  const parts: string[] = [];
  if (filled.length) {
    const shown = filled.length > 5
      ? `${filled.slice(0, 5).join(", ")}, and ${filled.length - 5} more field${filled.length - 5 === 1 ? "" : "s"}`
      : formatList(filled);
    parts.push(`Filled ${shown}`);
  }
  if (attached.length) {
    parts.push(`${parts.length ? "attached" : "Attached"} ${formatList(attached)}`);
  }
  if (!parts.length) return "";
  return `${parts.length === 2 ? `${parts[0]}, and ${parts[1]}` : parts[0]}.`;
}

const isEmptyField = (el: any): boolean => {
  if (!el || el.disabled || el.user_edited) return false;
  if (["checkbox", "radio"].includes(el.role) || isChoiceOption(el)) return !choiceState(el);
  const v = String(el.value ?? "").trim();
  return !v || PLACEHOLDER.test(v);
};

function matchProfileRule(el: any, profile: any, job: any, hasPhoneCountryField: boolean): string | null {
  const rawLabel = fieldLabel(el);
  if (!rawLabel) return null;
  const section = String(el.section ?? "");
  const l = rawLabel.toLowerCase();
  const ctx = `${section} ${rawLabel}`.toLowerCase();
  const [first, ...rest] = String(profile?.full_name ?? "").trim().split(/\s+/);
  const last = rest.join(" ");
  const link = (re: RegExp) => profile?.links?.find((x: any) => re.test(String(x.url ?? "")) || re.test(String(x.label ?? "")))?.url ?? null;

  // Never guess consent, legal declarations, or references.
  if (CONSENT_OR_LEGAL.test(l) || /\breference\b/.test(ctx)) {
    const fact = profileFact(rawLabel, profile, job);
    return fact;
  }

  // Profile-backed sensitive facts (gender, work auth, sponsorship when explicitly configured).
  const fact = profileFact(rawLabel, profile, job);
  if (fact) return fact;

  // Yes/No questions must never be filled with non-boolean profile strings (company, location, URL, etc.).
  const prefs = profile?.preferences ?? {};
  if (YES_NO_QUESTION.test(l)) {
    if (/\brelocat(?:e|ion)\b/.test(l) && typeof prefs.willing_to_relocate === "boolean") {
      return prefs.willing_to_relocate ? "Yes" : "No";
    }
    return null;
  }

  // Long open-ended essay prompts (e.g. "Tell us about something you've built... (GitHub, a demo...)") must not trigger short-label profile rules.
  if ((el.role === "textarea" && rawLabel.length > 60) || rawLabel.length > 105) {
    return null;
  }

  // Disambiguate company/school names before matching candidate's own name.
  const exp = latestExperience(profile);
  const edu = highestEducation(profile);
  const cleanL = cleanFieldName(el).toLowerCase();
  if (/^(?:current\s+)?(?:company|employer|organi[sz]ation)(?:\s+name)?$/.test(cleanL)
    || /\b(?:current\s+(?:company|employer|organi[sz]ation)|where are you currently working|full company name|company\s+name|employer\s+name)\b/.test(l)
    || (/\b(company|employer)\b/.test(section.toLowerCase()) && /\bname\b/.test(l))) {
    return exp?.company ? String(exp.company) : null;
  }
  if (/^(?:current\s+)?(?:school|university|college|institut(?:e|ion)|alma mater)(?:\s+name)?$/.test(cleanL)
    || /\b(?:school|university|college|institut(?:e|ion))\s+name\b|\balma mater\b/.test(l)
    || (/\b(education|school|university)\b/.test(section.toLowerCase()) && /\bname\b/.test(l))) {
    const school = edu?.school ?? edu?.institution;
    return school ? String(school) : null;
  }

  // Candidate name fields.
  if (/(?:first(?: name)?|given(?: name)?)\s*(?:and|&|\/)\s*(?:last(?: name)?|family(?: name)?|surname)/.test(l)) return profile?.full_name || null;
  if (/\bfirst\s*name\b|\bgiven\s*name\b/.test(l)) return first || null;
  if (/\blast\s*name\b|\bsurname\b|\bfamily\s*name\b/.test(l)) return last || null;
  if (/\bfull\s*name\b|^(?:your\s+)?name\b|\bcandidate\s*name\b|\bapplicant\s*name\b/.test(l)) return profile?.full_name || null;

  // Contact fields.
  if (/\be-?mail\b/.test(l)) return profile?.email || null;
  const isPhoneCountrySelect = (["select", "combobox"].includes(el.role) || el.popup)
    && (/\bphone\b|\bcountry\s*code\b|\bdial(?:l?ing)?\s*code\b|\bcalling\s*code\b|\bisd\b/.test(l)
      || (/\bphone\b/i.test(section) && /^country\b/i.test(cleanL))
      || (Array.isArray(el.options) && el.options.some((o: string) => /\(\+\d{1,3}\)|\+\d{1,3}\b/.test(o))));
  if (isPhoneCountrySelect || /\bphone\s*country\b|\bcountry\s*code\b|\bdial(?:l?ing)?\s*code\b|\bcalling\s*code\b|\bisd\b/.test(l)) {
    const code = extractDialCode(profile?.phone);
    if (!code) return null;
    const country = DIAL_COUNTRIES[code];
    if (Array.isArray(el.options) && el.options.length) {
      const hit = el.options.find((o: string) => o.includes(code) && (!country || o.toLowerCase().includes(country.toLowerCase())))
        ?? el.options.find((o: string) => o.includes(code));
      if (hit) return hit;
    }
    // Return the raw dial code ("+1", "+91") for async comboboxes so chooseDialOption matches
    // both "United States (+1)" and "USA (+1)" without filtering the dropdown to zero options.
    return code;
  }
  if (/\bphone\b|\bmobile\b|\btelephone\b|\bwhatsapp\b|\bcontact\s*number\b/.test(l)) {
    if (!profile?.phone) return null;
    const raw = hasPhoneCountryField ? stripDialCode(profile.phone) : String(profile.phone);
    if (typeof el.maxlength === "number" && el.maxlength > 0 && raw.length > el.maxlength) {
      const localDigits = stripDialCode(profile.phone).replace(/\D/g, "");
      if (localDigits && localDigits.length <= el.maxlength) return localDigits;
    }
    return raw;
  }

  // Profile links.
  if (/\blinkedin\b/.test(l)) return link(/linkedin/i);
  if (/\bgithub\b/.test(l)) return link(/github/i);
  if (/\bportfolio\b|\bpersonal\s*(?:web)?site\b|^website\b/.test(l)) return link(/portfolio|website|^https?:\/\/(?!.*(?:linkedin|github))/i);

  // Location / Country.
  const loc = String(profile?.location ?? "").trim();
  const locParts = loc.split(",").map((s) => s.trim()).filter(Boolean);
  if (/^country\b|\bcountry of residence\b|\bcurrent country\b/.test(cleanL)) {
    return locParts.length >= 2 ? locParts[locParts.length - 1] : loc || null;
  }
  if (/\bcurrent\s*city\b|^city\b/.test(cleanL)) {
    return locParts[0] || loc || null;
  }
  if (/^(?:your\s+|current\s+)?(?:location|city)(?:\s*\([^)]*\))?$/.test(cleanL)
    || /\b(?:current\s+location|your\s+location|where are you (?:currently )?(?:based|located)|location\s*\(city\)|city\s*\/\s*state|city,\s*state)\b/.test(l)) {
    return loc || null;
  }

  // Experience & preferences.
  if (/\bcurrent\s*(?:job\s*)?(?:title|designation|role|position)\b/.test(l)) return exp?.title ? String(exp.title) : null;
  if ((/\byears?\s+of\s+(?:total\s+|overall\s+|professional\s+|work\s+|full[- ]time\s+)?experience\b|\btotal\s+experience\b/.test(l))
    && !/\bexperience\b.*\b(?:working\s+with|using|with|in|managing|building|leading|developing)\s+(?!(?:total|overall|your\s+career|this\s+field)\b)[a-z]/i.test(l)) {
    if (profile?.total_experience_years == null) return null;
    const yrs = Number(profile.total_experience_years);
    // Split Years/Months dropdowns (e.g. RippleHire "Total experience" with options 0..11 for months).
    if (Array.isArray(el.options) && el.options.length === 12
      && el.options.every((o: string, i: number) => o.trim() === String(i))) {
      return Number.isFinite(yrs) ? String(Math.round((yrs - Math.floor(yrs)) * 12) % 12) : "0";
    }
    return Number.isFinite(yrs) && Array.isArray(el.options) && el.options.length > 12 && el.options.every((o: string) => /^\d+$/.test(o.trim()))
      ? String(Math.floor(yrs))
      : String(profile.total_experience_years);
  }
  if (/\b(?:expected|desired)\s*(?:annual\s*)?(?:salary|ctc|compensation|pay)\b/.test(l)) {
    return prefs.expected_ctc != null ? String(prefs.expected_ctc) : null;
  }
  if (/\b(?:current|last\s*drawn)\s*(?:annual\s*)?(?:salary|ctc|compensation|pay)\b/.test(l)) {
    return prefs.current_ctc != null ? String(prefs.current_ctc) : null;
  }
  if (/\bstart\s*date\b|\bavailable\s*from\b/.test(l)) {
    if (prefs.available_from) return String(prefs.available_from);
    if (el.input_type === "date" && typeof prefs.notice_period_days === "number") {
      const d = new Date();
      d.setDate(d.getDate() + prefs.notice_period_days);
      return d.toISOString().slice(0, 10);
    }
  }
  if (/\bnotice\s*period\b/.test(l) && typeof prefs.notice_period_days === "number") {
    return prefs.notice_period_days === 0 ? "Immediately" : `${prefs.notice_period_days} days`;
  }
  if (/\brelocat(?:e|ion)\b/.test(l) && typeof prefs.willing_to_relocate === "boolean") {
    return prefs.willing_to_relocate ? "Yes" : "No";
  }
  if (/\bdegree\b|\bqualification\b/.test(l) && edu?.degree) return String(edu.degree);

  return null;
}

function buildActionForAnswer(el: any, answer: string, obs: any): any | null {
  if (!el || !answer) return null;
  if (isChoiceOption(el) || el.role === "radio" || (el.role === "checkbox" && el.group)) {
    const opts = optionsOf(obs.elements, el);
    const chosen = matchChoice(opts, answer) ?? opts.find((m: any) => factMatches(answer, m.name));
    if (!chosen) return null;
    return { type: "check", ref: chosen.ref, checked: true, label: `Choose ${chosen.name}` };
  }
  if (el.role === "checkbox") {
    const yes = /^(?:yes|true|agree|confirm|checked|1)$/i.test(answer.trim());
    const no = /^(?:no|false|unchecked|0)$/i.test(answer.trim());
    if (!yes && !no) return null;
    return { type: "check", ref: el.ref, checked: yes, label: `${yes ? "Check" : "Uncheck"} ${el.name}` };
  }
  if (["select", "combobox"].includes(el.role) || el.popup) {
    let pick = answer;
    if (Array.isArray(el.options) && el.options.length) {
      const exact = el.options.find((o: string) => o.toLowerCase() === answer.toLowerCase());
      const factHit = el.options.find((o: string) => factMatches(answer, o));
      const days = durationDays(answer);
      const durationHit = days != null
        ? el.options.find((o: string) => durationDays(o) === days)
        : /^immediate/i.test(answer.trim()) ? el.options.find((o: string) => /^immediate/i.test(o.trim())) : undefined;
      const numericHit = /^\d+(?:\.\d+)?$/.test(answer.trim()) ? (() => {
        const n = Math.floor(Number(answer.trim()));
        return n === 0
          ? el.options.find((o: string) => /^no\s+experience\b|^0\b/i.test(o.trim()))
          : el.options.find((o: string) => new RegExp(`^${n}\\+?\\s*years?\\b`, "i").test(o.trim()));
      })() : undefined;
      const partial = el.options.find((o: string) => o.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.toLowerCase()));
      pick = exact ?? factHit ?? durationHit ?? numericHit ?? partial ?? answer;
    }
    return { type: "select", ref: el.ref, text: pick, label: `Select ${el.name}` };
  }
  if (el.input_type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(answer.trim())) {
    const days = durationDays(answer);
    if (days != null) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return { type: "type", ref: el.ref, text: d.toISOString().slice(0, 10), label: `Fill ${el.name}` };
    }
  }
  return { type: "type", ref: el.ref, text: answer, label: `Fill ${el.name}` };
}

/** Local deterministic rules_led form planner (0 LLM calls). */
export function ruleAgent(
  profile: any,
  job: any,
  options: {
    fillOptional?: boolean;
    lookupSaved?: (question: string) => Promise<{ answer: string; answer_id?: number } | null>;
    handoffOnly?: boolean;
  } = {},
) {
  const st: any = {
    session: crypto.randomUUID(),
    revision: 0,
    skipped: new Set<string>(),
    pending: null,
    asked: new Set<string>(),
    attempted: new Map<string, number>(),
    lookedUp: new Map<string, { answer: string; answer_id?: number } | null>(),
    navClicks: new Set<string>(),
    lastActions: [] as any[],
    filled: {} as Record<string, { label: string; value: string; kind: string; source: "user" | "profile" | "answer_bank"; needs_review: boolean; answer_id?: number }>,
    filledBatch: [] as Array<{ kind: "fill" | "upload"; label: string; command_id: string }>,
    wrote: [] as string[],
    writeValues: {} as Record<string, any>,
    failedFields: [] as Array<{ ref: string; label: string; detail?: string }>,
    waits: 0,
  };

  const flushFilledSummary = (): string => {
    const summary = formatFilledSummary(st.filledBatch);
    st.filledBatch = [];
    return summary;
  };

  const canUpload = (obs: any, el: any): "resume" | "cover_letter" | null => {
    if (el.role !== "file") return null;
    const label = fieldLabel(el);
    if (/cover.?letter/i.test(label)) return job?.cover_letter ? "cover_letter" : null;
    const resume = /resume|résumé|\bcv\b|curriculum/i.test(label);
    const sole = obs.elements.filter((e: any) => e.role === "file" && !e.disabled).length === 1
      && !/cover|letter|photo|picture|portfolio|certificate|id\b|passport|transcript/i.test(label);
    return profile?.resume_url && (resume || sole) ? "resume" : null;
  };

  const isSkipped = (obs: any, el: any) => Boolean(el) && (
    st.skipped.has(identityOf(obs, el))
    || st.skipped.has(questionKey(fieldLabel(el)))
    || (groupKeyOf(obs, el) !== null && st.skipped.has(groupKeyOf(obs, el)))
  );

  const markSkipped = (obs: any, ref: string, question: string) => {
    const el = obs.elements.find((e: any) => e.ref === ref);
    if (el) {
      st.skipped.add(identityOf(obs, el));
      const gk = groupKeyOf(obs, el);
      if (gk) st.skipped.add(gk);
      st.skipped.add(questionKey(fieldLabel(el)));
    }
    if (question) st.skipped.add(questionKey(question));
  };

  const isSafeClick = (obs: any, el: any): boolean => {
    if (!el || el.disabled || el.submit_like) return false;
    const name = String(el.name ?? "");
    if (BOT_CHECK.test(`${el.group ?? ""} ${name}`)) return false;
    if (COOKIE_DECLINE.test(name)) return true;
    if (FORBIDDEN_CLICK.test(name)) return false;
    if (NAV_BUTTON.test(name) && onLastStep(obs.text)) return false;
    return true;
  };

  const missingRequired = (obs: any) => scanFields(obs).missing.filter((field: any) => {
    const el = obs.elements.find((e: any) => e.ref === field.ref);
    if (!el) return true;
    return !(isSkipped(obs, el) || BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`) || (el.role === "file" && !canUpload(obs, el)));
  });

  const emptyOptional = (obs: any) => scanFields(obs).fields.filter((field: any) => {
    if (field.required || !["textbox", "textarea", "select", "combobox", "radio", "file"].includes(field.role)) return false;
    const el = obs.elements.find((e: any) => e.ref === field.ref);
    if (!el || el.disabled || el.user_edited || isSkipped(obs, el)) return false;
    if (BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`)) return false;
    if (el.role === "file" && !canUpload(obs, el)) return false;
    const isChoice = isChoiceOption(el) || el.role === "radio";
    if (isChoice) return !optionsOf(obs.elements, el).some((m: any) => choiceState(m) === true);
    return isEmptyField(el);
  });

  return async function step(body: any): Promise<any> {
    st.revision += 1;
    const obs = normalizeObservation(body?.observation ?? { url: "", elements: [] });
    const base = { session_id: st.session, revision: st.revision, guarded_commands: true, agent_engine: "rules_led", want_screenshot: false, filled: Object.values(st.filled) };

    // 1. Record outcomes of previous turn's actions.
    if (Array.isArray(body?.results) && st.lastActions.length) {
      for (const r of body.results) {
        const act = st.lastActions[r.index];
        if (!act?.ref) continue;
        const el = obs.elements.find((e: any) => e.ref === act.ref);
        const id = el ? identityOf(obs, el) : act.identity;
        const ok = r.ok !== false && r.result?.verified !== false;
        if (ok) {
          if (id && act.fillMeta) {
            const uploadedName = act.type === "upload" ? String(r.result?.committed ?? r.result?.value ?? "").trim() : "";
            st.filled[id] = uploadedName ? { ...act.fillMeta, value: uploadedName.slice(0, 1000) } : act.fillMeta;
          }
          if (id) {
            if (!st.wrote.includes(id)) st.wrote.push(id);
            if (el) st.writeValues[id] = choiceState(el) ?? el.value ?? "";
          }
        } else {
          if (id) st.attempted.set(id, (st.attempted.get(id) ?? 0) + 1);
          st.filledBatch = st.filledBatch.filter((e: any) => e.command_id !== act.command_id);
          if (!st.failedFields.some((f: any) => f.ref === act.ref)) {
            st.failedFields.push({
              ref: act.ref,
              label: act.fillMeta?.label || act.label || act.ref,
              ...(typeof r.detail === "string" && r.detail ? { detail: r.detail.slice(0, 200) } : {}),
            });
          }
        }
      }
      st.lastActions = [];
      base.filled = Object.values(st.filled);
    }

    // 2. Process user reply / skip / continue if we were waiting on a question.
    let pendingReply: { ref: string; label: string; answer: string } | null = null;
    if (st.pending?.kind === "ask") {
      const p = st.pending;
      st.pending = null;
      if (body?.skip_question) {
        markSkipped(obs, p.ref, p.question);
      } else if (body?.user_reply) {
        pendingReply = { ref: p.ref, label: p.label, answer: String(body.user_reply).trim() };
      } else {
        // User tapped Continue without typing an answer: treat as handled/skipped so we don't loop.
        markSkipped(obs, p.ref, p.question);
      }
    }

    // 3. Blockers: stop on sign-in walls or standalone CAPTCHAs.
    const blockers = (obs.blockers ?? []).map((b: any) => String(b).toLowerCase());
    if (blockers.some((b: string) => ["login", "sign_in", "signin"].includes(b))) {
      return { ...base, status: "ask_user", actions: [], message: "Sign-in is required on this page.", question: { kind: "blocker", text: "Please sign in to continue.", optional: false } };
    }
    if (blockers.includes("captcha") && !hasApplicationFields(obs)) {
      return { ...base, status: "ask_user", actions: [], message: "Please complete the CAPTCHA on this page.", question: { kind: "blocker", text: "Please complete the CAPTCHA to continue.", optional: false } };
    }

    // 3a. Follow an application tab opened by our own recent click when the current page has no form fields.
    // A job-listing page with an Apply button/link and only a lone email box (e.g. newsletter/job-alert signup)
    // is not an application form; treat it as having no application fields so we navigate instead of filling it.
    const editableFields = obs.elements.filter((e: any) =>
      ["textbox", "textarea", "combobox", "select", "radio", "checkbox", "file", "spinbutton"].includes(e.role) &&
      !e.disabled && !["password", "hidden", "search"].includes(e.input_type) &&
      !BOT_CHECK.test(`${e.group ?? ""} ${e.name ?? ""}`));
    const hasApplyLink = obs.elements.some((e: any) =>
      !e.disabled && ["button", "link"].includes(e.role) &&
      /^apply(?:\s+(?:now|for\s+this\s+job))?$/i.test(String(e.name ?? "").trim()));
    const onlyLoneEmailOnListing = hasApplyLink && editableFields.length === 1
      && editableFields[0].role === "textbox" && /\be-?mail\b/i.test(fieldLabel(editableFields[0]));
    const hasFields = hasApplicationFields(obs) && !onlyLoneEmailOnListing;
    if (!hasFields && Array.isArray(obs.tabs) && obs.tabs.length > 0 && obs.observation_id) {
      const targetTab = obs.tabs[obs.tabs.length - 1];
      const tabKey = `tab|${targetTab.id}|${targetTab.url}`;
      if (targetTab?.id && !st.navClicks.has(tabKey)) {
        st.navClicks.add(tabKey);
        const action = {
          type: "switch_tab",
          tab_id: targetTab.id,
          label: "Switch to application tab",
          observation_id: obs.observation_id,
          command_id: crypto.randomUUID(),
        };
        return { ...base, status: "continue", actions: [action], message: "" };
      }
    }

    // 3b. Dismiss cookie-consent modals (decline/reject/essential-only) that hide the form behind an open dialog.
    if (obs.dialog || !hasFields) {
      const decline = obs.elements.find((e: any) => !e.disabled && ["button", "link"].includes(e.role) && COOKIE_DECLINE.test(String(e.name ?? "")));
      if (decline && isSafeClick(obs, decline)) {
        const navKey = `cookie|${obs.url}|${decline.ref}|${decline.name}`;
        if (!st.navClicks.has(navKey)) {
          st.navClicks.add(navKey);
          const action = { type: "click", ref: decline.ref, label: `Click ${decline.name}`, observation_id: obs.observation_id, command_id: crypto.randomUUID() };
          return { ...base, status: "continue", actions: [action], message: "" };
        }
      }
    }

    // 3c. Async-rendered forms (e.g. Workable): wait briefly when no form fields or navigation/gate buttons have mounted yet.
    const hasGateOrNav = obs.elements.some((e: any) => !e.disabled && !e.submit_like && ["button", "link"].includes(e.role)
      && (NAV_BUTTON.test(String(e.name ?? "")) || /\b(?:agree|accept)\b/i.test(String(e.name ?? ""))));
    if (hasFields) {
      st.waits = 0;
    } else if (obs.observation_id && st.waits < (options.handoffOnly ? 1 : 3) && !hasGateOrNav) {
      st.waits += 1;
      const action = { type: "wait", ms: 1500, label: "Waiting for the form to load", observation_id: obs.observation_id, command_id: crypto.randomUUID() };
      return { ...base, status: "continue", actions: [action], message: "" };
    }

    // 4. Apply an immediate user reply if one just arrived.
    if (pendingReply) {
      const el = obs.elements.find((e: any) => e.ref === pendingReply!.ref)
        ?? obs.elements.find((e: any) => fieldLabel(e).toLowerCase() === pendingReply!.label.toLowerCase());
      if (el && !el.disabled && !el.user_edited && el.input_type !== "password" && !BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`)) {
        const raw = buildActionForAnswer(el, pendingReply.answer, obs);
        if (raw) {
          const action = { ...raw, observation_id: obs.observation_id, command_id: crypto.randomUUID() };
          const fillMeta = {
            label: cleanFieldName(el).slice(0, 500),
            value: String(pendingReply.answer).slice(0, 1000),
            kind: fieldKindOf(el),
            source: "user" as const,
            needs_review: false,
          };
          st.lastActions = [{ ...action, identity: identityOf(obs, el), fillMeta }];
          return { ...base, status: "continue", actions: [action], message: "" };
        }
      }
    }

    // 5. Pass 1: deterministically fill all supported profile fields in page order.
    const hasPhoneCountryField = obs.elements.some((e: any) => (["select", "combobox"].includes(e.role) || e.popup)
      && (/\bphone\b|\bcountry\s*code\b|\bdial(?:l?ing)?\s*code\b/i.test(fieldLabel(e))
        || (/\bphone\b/i.test(String(e.section ?? "")) && /^country\b/i.test(cleanFieldName(e)))
        || (Array.isArray(e.options) && e.options.some((o: string) => /\(\+\d{1,3}\)|\+\d{1,3}\b/.test(o)))));
    const maxAttempts = options.handoffOnly ? 1 : MAX_FIELD_ATTEMPTS;
    const seenGroups = new Set<string>();
    const actions: any[] = [];
    const tracked: any[] = [];

    for (const el of (onlyLoneEmailOnListing ? [] : obs.elements)) {
      if (actions.length >= MAX_BATCH) break;
      if (el.disabled || el.user_edited || el.input_type === "password" || isSkipped(obs, el)) continue;
      if (BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`)) continue;
      if (NEWSLETTER_OR_ALERT.test(`${el.section ?? ""} ${fieldLabel(el)}`)) continue;
      if (el.required === false && options.fillOptional === false) continue;

      const isChoice = isChoiceOption(el) || el.role === "radio" || (el.role === "checkbox" && Boolean(el.group));
      if (isChoice && el.group) {
        const gk = `${el.frame ?? 0}|${el.section ?? ""}|${el.group}`;
        if (seenGroups.has(gk)) continue;
        seenGroups.add(gk);
        const group = optionsOf(obs.elements, el);
        if (group.some((m: any) => choiceState(m) === true)) continue;
      } else if (!isEmptyField(el)) {
        continue;
      }

      const id = identityOf(obs, el);
      if ((st.attempted.get(id) ?? 0) >= maxAttempts) continue;

      let raw: any = null;
      let fillMeta: any = null;
      if (el.role === "file") {
        const file = canUpload(obs, el);
        if (file) {
          raw = { type: "upload", ref: el.ref, file, label: file === "cover_letter" ? "Upload cover letter" : "Upload resume" };
          fillMeta = {
            label: cleanFieldName(el).slice(0, 500) || (file === "cover_letter" ? "Cover letter" : "Resume"),
            value: file === "cover_letter" ? "Cover letter attached" : "Resume attached",
            kind: "file",
            source: "profile" as const,
            needs_review: false,
          };
        }
      } else if (["textbox", "textarea", "select", "combobox", "spinbutton", "radio", "checkbox"].includes(el.role) || isChoice) {
        const profileAnswer = matchProfileRule(el, profile, job, hasPhoneCountryField);
        let savedHit = profileAnswer ? null : matchSavedAnswer(el, profile);
        // In Auto mode (handoffOnly), skip backend semantic lookupSaved during the fast rule pass:
        // Agent already has the answer bank + LLM reasoning to verify semantic matches and dropdown fit.
        if (!profileAnswer && !savedHit && options.lookupSaved && !options.handoffOnly) {
          const rawLabel = fieldLabel(el);
          const l = rawLabel.toLowerCase();
          const ctx = `${el.section ?? ""} ${rawLabel}`.toLowerCase();
          if (rawLabel && !CONSENT_OR_LEGAL.test(l) && !/\breference\b/.test(ctx)) {
            const lk = normalizeText(rawLabel);
            if (lk) {
              if (!st.lookedUp.has(lk)) {
                st.lookedUp.set(lk, await options.lookupSaved(rawLabel).catch(() => null));
              }
              savedHit = st.lookedUp.get(lk) ?? null;
            }
          }
        }
        const answer = profileAnswer ?? savedHit?.answer ?? null;
        if (answer) {
          raw = buildActionForAnswer(el, answer, obs);
          if (raw) {
            fillMeta = {
              label: cleanFieldName(el).slice(0, 500),
              value: String(answer).slice(0, 1000),
              kind: fieldKindOf(el),
              source: profileAnswer ? ("profile" as const) : ("answer_bank" as const),
              needs_review: false,
              ...(!profileAnswer && savedHit?.answer_id !== undefined ? { answer_id: savedHit.answer_id } : {}),
            };
          }
        }
      }

      if (!raw) continue;
      const action = { ...raw, observation_id: obs.observation_id, command_id: crypto.randomUUID() };
      actions.push(action);
      tracked.push({ ...action, identity: id, ...(fillMeta ? { fillMeta } : {}) });
      st.filledBatch.push(action.type === "upload"
        ? { kind: "upload", label: action.file === "cover_letter" ? "your cover letter" : "your resume", command_id: action.command_id }
        : { kind: "fill", label: cleanFieldName(el), command_id: action.command_id });
      if (action.type === "upload") break;
    }

    if (actions.length) {
      st.lastActions = tracked;
      return { ...base, ...(options.handoffOnly ? { local_rule_step: true } : {}), status: "continue", actions, message: "" };
    }

    // 6. Pass 2: ask the user one question at a time for remaining required (then enabled optional) fields.
    const required = onlyLoneEmailOnListing ? [] : missingRequired(obs);
    const optional = (onlyLoneEmailOnListing || options.fillOptional === false) ? [] : emptyOptional(obs);

    if (options.handoffOnly) {
      const hasNavButton = !required.length && obs.elements.some((el: any) =>
        ["button", "link"].includes(el.role) && NAV_BUTTON.test(String(el.name ?? ""))
        && !(hasFields && /^apply(?:\s+(?:now|for\s+this\s+job))?$/i.test(String(el.name ?? "").trim()))
        && isSafeClick(obs, el));
      const hasErrors = Boolean((obs.errors?.length ?? 0) > 0 || obs.elements.some((e: any) => e.invalid || e.error));
      return {
        ...base,
        status: "handoff",
        actions: [],
        message: flushFilledSummary(),
        handoff: {
          filled: { ...st.filled },
          wrote: [...st.wrote],
          writeValues: { ...st.writeValues },
          failedFields: [...st.failedFields],
          missingRequiredCount: required.length,
          emptyOptionalCount: optional.length,
          hasNavButton,
          hasErrors,
          hasFields,
        },
      };
    }
    const queue = [...required.map((f: any) => ({ ...f, required: true })), ...optional.map((f: any) => ({ ...f, required: false }))];

    for (const field of queue) {
      const el = obs.elements.find((e: any) => e.ref === field.ref);
      if (!el || el.disabled || el.user_edited || el.input_type === "password") continue;
      const label = fieldLabel(el) || String(field.name ?? "").trim();
      if (!label) continue;
      const askKey = `${obs.url}|${el.section ?? ""}|${questionKey(label)}`;
      if (st.asked.has(askKey)) continue;
      st.asked.add(askKey);

      const isChoice = isChoiceOption(el) || el.role === "radio" || (el.role === "checkbox" && Boolean(el.group));
      const choices = isChoice
        ? optionsOf(obs.elements, el).map((m: any) => m.name).filter(Boolean)
        : Array.isArray(el.options) ? el.options : [];
      const summary = flushFilledSummary();
      st.pending = { kind: "ask", ref: el.ref, question: label, label };
      return {
        ...base,
        status: "ask_user",
        actions: [],
        message: summary || label,
        question: { kind: "question", ref: el.ref, text: label, label, role: el.role, choices, optional: !field.required },
      };
    }

    // 7. Pass 3: advance multi-step wizards (only when no required fields are empty and never clicking final submit).
    if (!required.length) {
      for (const el of obs.elements) {
        if (!["button", "link"].includes(el.role)) continue;
        if (!NAV_BUTTON.test(String(el.name ?? ""))) continue;
        // On single-page forms (e.g. Greenhouse), an "Apply" button at the top of the job description
        // just scrolls to the form that is already visible on the page.
        if (hasFields && /^apply(?:\s+(?:now|for\s+this\s+job))?$/i.test(String(el.name ?? "").trim())) continue;
        if (!isSafeClick(obs, el)) continue;
        const navKey = `${obs.url}|${el.ref}|${el.name}`;
        if (st.navClicks.has(navKey)) continue;
        st.navClicks.add(navKey);
        const summary = flushFilledSummary();
        const action = { type: "click", ref: el.ref, label: `Click ${el.name}`, observation_id: obs.observation_id, command_id: crypto.randomUUID() };
        st.lastActions = [{ ...action, identity: identityOf(obs, el) }];
        return { ...base, status: "continue", actions: [action], message: summary ? `${summary} Continuing to the next step (${el.name}).` : `Continuing to the next step (${el.name}).` };
      }
    }

    // 8. Pass 4: ready for review (never submits).
    const summary = flushFilledSummary();
    return { ...base, status: "ready_for_review", actions: [], message: summary ? `${summary} Please review and submit your application.` : "Please review and submit your application." };
  };
}
