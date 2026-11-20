// Local deterministic rule-based form agent (0 LLM calls, 0 server step calls).
// Self-contained engine under src/rule-based/ (zero imports from src/agent-based/).
import { choiceGroup, choiceState, isChoiceOption, matchChoice, optionsOf, scanFields } from "../page-control/commands.js";
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
const CONSENT_OR_LEGAL = /\b(?:consent|certify|declare|swear|truthful|agree|accept|confirm|privacy policy|terms|visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|criminal|convict|felon|previously (?:employed|worked)|former(?:ly)? (?:employee|employed))\b/i;
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

  // Disambiguate company/school names before matching candidate's own name.
  const exp = latestExperience(profile);
  const edu = highestEducation(profile);
  if (/\b(company|employer|organi[sz]ation)\b/.test(l) || (/\b(company|employer)\b/.test(section.toLowerCase()) && /\bname\b/.test(l))) {
    return exp?.company ? String(exp.company) : null;
  }
  if (/\b(school|university|college|institut(e|ion)|alma mater)\b/.test(l) || (/\b(education|school|university)\b/.test(section.toLowerCase()) && /\bname\b/.test(l))) {
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
    return country ? `${country} (${code})` : code;
  }
  if (/\bphone\b|\bmobile\b|\btelephone\b|\bwhatsapp\b/.test(l)) {
    if (!profile?.phone) return null;
    return hasPhoneCountryField ? stripDialCode(profile.phone) : String(profile.phone);
  }

  // Profile links.
  if (/\blinkedin\b/.test(l)) return link(/linkedin/i);
  if (/\bgithub\b/.test(l)) return link(/github/i);
  if (/\bportfolio\b|\bpersonal\s*(?:web)?site\b|^website\b/.test(l)) return link(/portfolio|website|^https?:\/\/(?!.*(?:linkedin|github))/i);

  // Location / Country.
  const loc = String(profile?.location ?? "").trim();
  const locParts = loc.split(",").map((s) => s.trim()).filter(Boolean);
  if (/^country\b|\bcountry of residence\b|\bcurrent country\b/.test(l)) {
    return locParts.length >= 2 ? locParts[locParts.length - 1] : loc || null;
  }
  if (/\bcurrent\s*city\b|^city\b/.test(l)) {
    return locParts[0] || loc || null;
  }
  if (/\blocation\b|\bcity\b|where are you (?:currently )?(?:based|located)/.test(l)) {
    return loc || null;
  }

  // Experience & preferences.
  if (/\bcurrent\s*(?:job\s*)?(?:title|designation|role|position)\b/.test(l)) return exp?.title ? String(exp.title) : null;
  if (/\byears?\s+of\s+(?:total\s+|overall\s+|professional\s+|work\s+|full[- ]time\s+)?experience\b|\btotal\s+experience\b/.test(l)) {
    return profile?.total_experience_years != null ? String(profile.total_experience_years) : null;
  }
  const prefs = profile?.preferences ?? {};
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
      const partial = el.options.find((o: string) => o.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(o.toLowerCase()));
      pick = exact ?? factHit ?? partial ?? answer;
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
export function ruleAgent(profile: any, job: any, options: { fillOptional?: boolean } = {}) {
  const st: any = {
    session: crypto.randomUUID(),
    revision: 0,
    skipped: new Set<string>(),
    pending: null,
    asked: new Set<string>(),
    attempted: new Map<string, number>(),
    navClicks: new Set<string>(),
    lastActions: [] as any[],
    waits: 0,
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
    const base = { session_id: st.session, revision: st.revision, guarded_commands: true, agent_engine: "rules_led", want_screenshot: false };

    // 1. Record outcomes of previous turn's actions.
    if (Array.isArray(body?.results) && st.lastActions.length) {
      for (const r of body.results) {
        const act = st.lastActions[r.index];
        if (!act?.ref) continue;
        const el = obs.elements.find((e: any) => e.ref === act.ref);
        const id = el ? identityOf(obs, el) : act.identity;
        const ok = r.ok !== false && r.result?.verified !== false;
        if (!ok && id) st.attempted.set(id, (st.attempted.get(id) ?? 0) + 1);
      }
      st.lastActions = [];
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

    // 3a. Dismiss cookie-consent modals (decline/reject/essential-only) that hide the form behind an open dialog.
    if (obs.dialog || !hasApplicationFields(obs)) {
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

    // 3b. Async-rendered forms (e.g. Workable): wait briefly when no form fields or navigation buttons have mounted yet.
    const hasFields = hasApplicationFields(obs);
    if (hasFields) {
      st.waits = 0;
    } else if (obs.observation_id && st.waits < 3 && !obs.elements.some((e: any) => !e.disabled && !e.submit_like && ["button", "link"].includes(e.role) && NAV_BUTTON.test(String(e.name ?? "")))) {
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
          st.lastActions = [{ ...action, identity: identityOf(obs, el) }];
          return { ...base, status: "continue", actions: [action], message: "" };
        }
      }
    }

    // 5. Pass 1: deterministically fill all supported profile fields in page order.
    const hasPhoneCountryField = obs.elements.some((e: any) => (["select", "combobox"].includes(e.role) || e.popup)
      && (/\bphone\b|\bcountry\s*code\b|\bdial(?:l?ing)?\s*code\b/i.test(fieldLabel(e))
        || (Array.isArray(e.options) && e.options.some((o: string) => /\(\+\d{1,3}\)|\+\d{1,3}\b/.test(o)))));
    const seenGroups = new Set<string>();
    const actions: any[] = [];
    const tracked: any[] = [];

    for (const el of obs.elements) {
      if (actions.length >= MAX_BATCH) break;
      if (el.disabled || el.user_edited || el.input_type === "password" || isSkipped(obs, el)) continue;
      if (BOT_CHECK.test(`${el.group ?? ""} ${el.name ?? ""}`)) continue;
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
      if ((st.attempted.get(id) ?? 0) >= MAX_FIELD_ATTEMPTS) continue;

      let raw: any = null;
      if (el.role === "file") {
        const file = canUpload(obs, el);
        if (file) raw = { type: "upload", ref: el.ref, file, label: file === "cover_letter" ? "Upload cover letter" : "Upload resume" };
      } else if (["textbox", "textarea", "select", "combobox", "spinbutton", "radio", "checkbox"].includes(el.role) || isChoice) {
        const answer = matchProfileRule(el, profile, job, hasPhoneCountryField);
        if (answer) raw = buildActionForAnswer(el, answer, obs);
      }

      if (!raw) continue;
      const action = { ...raw, observation_id: obs.observation_id, command_id: crypto.randomUUID() };
      actions.push(action);
      tracked.push({ ...action, identity: id });
      if (action.type === "upload") break;
    }

    if (actions.length) {
      st.lastActions = tracked;
      return { ...base, status: "continue", actions, message: "Filled known profile fields." };
    }

    // 6. Pass 2: ask the user one question at a time for remaining required (then enabled optional) fields.
    const required = missingRequired(obs);
    const optional = options.fillOptional === false ? [] : emptyOptional(obs);
    const queue = [...required.map((f: any) => ({ ...f, required: true })), ...optional.map((f: any) => ({ ...f, required: false }))];

    for (const field of queue) {
      const el = obs.elements.find((e: any) => e.ref === field.ref);
      if (!el || el.disabled || el.user_edited || el.input_type === "password") continue;
      const label = fieldLabel(el) || String(field.name ?? "").trim();
      if (!label) continue;
      const askKey = `${obs.url}|${el.section ?? ""}|${questionKey(label)}`;
      if (st.asked.has(askKey)) continue;
      st.asked.add(askKey);

      const isChoice = isChoiceOption(el) || el.role === "radio";
      const choices = isChoice
        ? choiceGroup(obs.elements, el).map((m: any) => m.name).filter(Boolean)
        : Array.isArray(el.options) ? el.options : [];
      st.pending = { kind: "ask", ref: el.ref, question: label, label };
      return {
        ...base,
        status: "ask_user",
        actions: [],
        message: label,
        question: { kind: "question", ref: el.ref, text: label, label, role: el.role, choices, optional: !field.required },
      };
    }

    // 7. Pass 3: advance multi-step wizards (only when no required fields are empty and never clicking final submit).
    if (!required.length) {
      for (const el of obs.elements) {
        if (!["button", "link"].includes(el.role)) continue;
        if (!NAV_BUTTON.test(String(el.name ?? ""))) continue;
        if (!isSafeClick(obs, el)) continue;
        const navKey = `${obs.url}|${el.ref}|${el.name}`;
        if (st.navClicks.has(navKey)) continue;
        st.navClicks.add(navKey);
        const action = { type: "click", ref: el.ref, label: `Click ${el.name}`, observation_id: obs.observation_id, command_id: crypto.randomUUID() };
        st.lastActions = [{ ...action, identity: identityOf(obs, el) }];
        return { ...base, status: "continue", actions: [action], message: `Continuing to the next step (${el.name}).` };
      }
    }

    // 8. Pass 4: ready for review (never submits).
    return { ...base, status: "ready_for_review", actions: [], message: "Please review and submit your application." };
  };
}
