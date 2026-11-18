(() => {
  const SOURCES = { profile: "From profile", answer_bank: "From answer bank", generated: "AI draft", assistant: "From chat", you: "Your answer" };
  function sourceLabel(source) {
    return SOURCES[source] ?? source ?? "";
  }
  const isUpload = (r) => r.field.kind === "picker" || r.field.kind === "file";
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function summarize(all, { submitted = false } = {}) {
    const optional = all.filter((r) => r.status === "optional");
    const results = all.filter((r) => r.status !== "optional");
    const filled = results.filter((r) => r.status === "filled");
    const unresolved = results.filter((r) => r.status === "unresolved");
    const done = results.filter((r) => r.status === "done");
    const toCheck = filled.filter((r) => r.needsReview && !r.reviewed);
    const questions = results.filter((r) => r.status !== "filled" && !isUpload(r));
    const uploads = results.filter((r) => r.status !== "filled" && isUpload(r));
    const checks = filled.filter((r) => r.needsReview);
    const steps = [];
    if (questions.length) {
      const n = questions.filter((r) => r.status === "unresolved").length;
      steps.push({ id: "answer", label: n ? `Answer ${plural(n, "question")}` : "Questions answered", remaining: n });
    }
    if (uploads.length) {
      const n = uploads.filter((r) => r.status === "unresolved").length;
      steps.push({ id: "upload", label: n ? "Attach your CV" : "CV attached", remaining: n });
    }
    if (checks.length) {
      const n = toCheck.length;
      steps.push({ id: "check", label: n ? `Double-check ${plural(n, "answer")}` : "Answers checked", remaining: n });
    }
    steps.push({
      id: "submit",
      label: submitted ? "Submitted" : "Click the form's own Submit button",
      remaining: submitted ? 0 : 1
    });
    const total = results.length;
    const answered = filled.length + done.length;
    const todo = unresolved.length + toCheck.length;
    let headline;
    if (submitted) headline = "Submitted. Nice work!";
    else if (!total) headline = "No fields found on this page yet";
    else if (unresolved.length) headline = `${plural(todo, "thing")} left for you`;
    else if (toCheck.length) headline = `Almost there: check ${plural(toCheck.length, "answer")}`;
    else headline = "All set: review and submit";
    return {
      total,
      answered,
      todo,
      progress: total ? answered / total : 0,
      counts: { filled: filled.length, unresolved: unresolved.length, done: done.length, toCheck: toCheck.length, optional: optional.length },
      headline,
      steps
    };
  }
  const OPEN_STATUSES = ["saved", "queued", "filling", "ready_for_review"];
  function autoApplyBlockers(results, app, readiness = null, captchaPending = false) {
    const blockers = [];
    if (app?.status === "submission_unconfirmed") {
      blockers.push("A previous attempt needs verification in ApplyShortly first");
    } else if (app?.status && !OPEN_STATUSES.includes(app.status)) {
      blockers.push(`This application is already ${String(app.status).replace(/_/g, " ")}`);
    }
    if (!results.length && !(readiness?.total > 0)) blockers.push("No form fields found on this page");
    const unresolved = results.filter((r) => r.status === "unresolved");
    if (unresolved.length) blockers.push(`${plural(unresolved.length, "required field")} still ${unresolved.length === 1 ? "needs" : "need"} you`);
    const framedMissing = (readiness?.missing ?? []).filter((m) => m.framed);
    if (framedMissing.length) blockers.push(`${plural(framedMissing.length, "required field")} in the embedded form still ${framedMissing.length === 1 ? "needs" : "need"} you`);
    if (readiness?.framed > 0) blockers.push("This form is embedded in the page, so I can't check all of it from here. Review it and submit it yourself");
    if (captchaPending) blockers.push("The site still needs you to complete its CAPTCHA. Do that, then submit it yourself");
    return blockers;
  }
  function readinessNote(readiness) {
    const missing = readiness?.missing ?? [];
    if (!missing.length) return "";
    const names = missing.slice(0, 3).map((m) => `\u201C${m.name}\u201D`).join(", ");
    const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
    return `Still empty and required: ${names}${more}.`;
  }
  const LOGIN_URL = /\/(login|signin|sign_in|sign-in)\b|\/auth\//i;
  function loginWall(pathname, passwordShown) {
    return passwordShown || LOGIN_URL.test(pathname ?? "");
  }
  function friendlyError(message, status, baseUrl, code) {
    const msg = String(message ?? "");
    const where = baseUrl || "the platform";
    if (code === "profile_missing") {
      return {
        title: "Finish setting up your profile",
        detail: "This account has no profile yet. Upload your resume on the ApplyShortly website, then try again.",
        action: "profile"
      };
    }
    if (status === 401 || status === 403 || /api key|unauthori[sz]ed|forbidden/i.test(msg)) {
      return {
        title: "ApplyShortly didn't accept the API key",
        detail: "Open settings and paste a current key.",
        action: "settings"
      };
    }
    if (/failed to fetch|networkerror|load failed|err_connection|network/i.test(msg)) {
      return {
        title: `Can't reach ApplyShortly at ${where}`,
        detail: "Check that the platform is running, then try again.",
        action: "retry"
      };
    }
    if (status === 409) {
      return { title: "Needs verification or updated settings", detail: msg, action: "settings" };
    }
    if (status === 404) {
      return { title: "This application no longer exists in ApplyShortly", detail: msg, action: "retry" };
    }
    if (/receiving end does not exist|extension context invalidated/i.test(msg)) {
      return { title: "The extension was updated", detail: "Reload this page to reconnect.", action: "reload" };
    }
    return { title: "Something went wrong", detail: msg || "No details.", action: "retry" };
  }
  const ASSISTABLE = ["text", "select", "radio", "dropdown"];
  const MAX_CHOICES = 8;
  const MAX_TURNS = 60;
  const MAX_TEXT = 4e3;
  const canAssist = (r) => ASSISTABLE.includes(r.field.kind);
  const DRAFT_REPLY = "Draft it for me";
  const SKIP_REPLY = "Leave it blank";
  const AGREE_REPLY = "I agree, tick it";
  const SHOW_REPLY = "Show me";
  const DONE_REPLY = "I've done it";
  const LOCAL_REPLIES = [DRAFT_REPLY, SKIP_REPLY, AGREE_REPLY, SHOW_REPLY, DONE_REPLY];
  const DRAFT_ASK = /^(?:(?:please|can you|could you|pls)\s+)?(?:draft|write)(?:\s+(?:it|one|this|that|something|an? answer|the answer|an? draft))?(?:\s+for me)?(?:\s+please)?[\s.!?]*$/i;
  const isDraftRequest = (message) => DRAFT_ASK.test(String(message ?? "").trim());
  const ON_PAGE_REPLY = "I'll fill it on the page";
  const CONTINUE_REPLY = "Continue";
  const NAVIGATE_ASK = /^(?:please\s+)?(?:(?:go|move|click)(?:\s+on)?(?:\s+to)?\s+(?:the\s+)?next(?:\s+(?:page|step))?|next(?:\s+(?:page|step))|(?:do|fill|finish|complete)\s+the\s+rest(?:\s+of\s+(?:it|the form))?|continue(?:\s+(?:the|this)\s+form|\s+to\s+the\s+next\s+(?:page|step)))[\s.!]*$/i;
  const isNavigateRequest = (message) => NAVIGATE_ASK.test(String(message ?? "").trim());
  function navigationNeeded({ total = 0, hasSubmit = false, hasNext = false, bigFrame = false } = {}) {
    if (!total && !bigFrame) return "none";
    if (bigFrame && total < 3) return "frame";
    if (!hasSubmit && hasNext) return "steps";
    return null;
  }
  const HANDOFF = {
    none: "I can't see a form on this page yet, so I'll open it (it may sit behind an Apply button or in a pop-up) and fill it.",
    frame: "The form is inside a frame, so I'll fill it from there.",
    steps: "This form has more than one step. I'll go through them and fill each one.",
    asked: "OK, I'll carry on through the form."
  };
  function handoffText(reason, { autoSubmit = false } = {}) {
    return [
      HANDOFF[reason] ?? HANDOFF.asked,
      "I'll ask here when I need you. Chrome shows a \u201Cstarted debugging\u201D bar while I click through, and it uses one apply run of credits.",
      autoSubmit ? "Once every required answer is complete, Auto apply will resume with its cancellable countdown." : ""
    ].filter(Boolean).join(" ");
  }
  const PAGE_ACTION = /\b(?:links?|urls?|web ?sites?|pages?|tabs?|buttons?|click|open|navigate|sign[- ]?in|log[- ]?in|captcha|upload|attach|tick|untick|check ?box(?:es)?|consent)\b/i;
  const TYPED_ROLES = ["textbox", "textarea", "searchbox"];
  const INSTRUCTION = /^(?:please\s+)?(?:can|could|do|does|why|what|how|where|is|are|fill|set|change|select|choose|upload|click|continue|open|scroll|update|replace|fetch|read|look|visit|browse|pull|take|get|go|see|check)\b/i;
  const isPlainAnswer = (message) => !INSTRUCTION.test(String(message).trim());
  const SITUATION = /\b(?:describe|explain|briefly|situation|tell us|elaborate|details?)\b/i;
  const GROUNDED_TOPIC = /visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work/i;
  const groundedDraft = (text) => SITUATION.test(text ?? "") && GROUNDED_TOPIC.test(text ?? "") && !PAGE_ACTION.test(text ?? "");
  function agentAsk(question, engine) {
    if (!question) return null;
    if (question.kind === "question" && engine === "ai_led") {
      const named = { draft: DRAFT_REPLY, skip: SKIP_REPLY, on_page: ON_PAGE_REPLY };
      const actions = (question.actions ?? []).map((a) => named[a]).filter(Boolean);
      return { text: "", question: { label: question.text }, choices: [...(question.choices ?? []).slice(0, MAX_CHOICES), ...actions], draftable: actions.includes(DRAFT_REPLY) };
    }
    if (question.kind === "question") {
      const choices = (question.choices ?? []).slice(0, MAX_CHOICES);
      const typed = !question.role || TYPED_ROLES.includes(question.role);
      const draft = typed && !choices.length && !PAGE_ACTION.test(question.text ?? "") && (draftable({ kind: "text", label: question.text }) || groundedDraft(question.text));
      if (question.optional) {
        const note = choices.length ? "Optional: pick an answer, or leave it blank." : draft ? "Optional: type an answer, I can draft one, or leave it blank." : "Optional: type an answer, or leave it blank.";
        return {
          text: "",
          question: { label: question.text, note },
          choices: [...choices, ...draft ? [DRAFT_REPLY] : [], SKIP_REPLY],
          draftable: draft
        };
      }
      return {
        text: "",
        question: { label: question.text, note: draft ? "Type your answer, or I can draft one." : void 0 },
        choices: [...choices, ...draft ? [DRAFT_REPLY] : [], ON_PAGE_REPLY],
        draftable: draft
      };
    }
    return { text: `${question.text} Tap Continue when it's done.`, choices: [CONTINUE_REPLY] };
  }
  const optionalTarget = (results) => {
    const available = results.filter((r) => r.status === "optional" && canAssist(r) && !r.skipped);
    return available.find((r) => draftable(r.field)) ?? available[0] ?? null;
  };
  const manualSteps = (results) => results.filter((r) => r.status === "unresolved" && !canAssist(r));
  const openQuestions = (results) => results.filter((r) => r.status === "unresolved" && canAssist(r));
  function promptTarget(results) {
    if (openQuestions(results).length) return null;
    return manualSteps(results)[0] ?? optionalTarget(results) ?? null;
  }
  const questionLabel = (r) => r.field.label || "Untitled question";
  function directAnswer(row, message) {
    if (!row || !["unresolved", "optional"].includes(row.status) || !canAssist(row) || LOCAL_REPLIES.includes(message) || isDraftRequest(message)) return null;
    const options = (row.field.options ?? []).map((o) => String(o.text ?? "").trim()).filter(Boolean);
    if (options.length) return options.find((o) => o.toLowerCase() === message.toLowerCase()) ?? null;
    if (/^(?:please\s+)?(?:set|change|update|correct|replace|use my|fill (?:these|this|the|my))\b/i.test(message.trim())) return null;
    if (row.field.kind !== "text") return null;
    const type = String(row.field.el?.type ?? "").toLowerCase();
    const text = message.trim();
    if ((row.field.phoneCountry || type === "tel") && !/^\+?[\d\s().-]{6,20}$/.test(text)) return null;
    if (type === "number" && !/^-?[\d.,\s]+$/.test(text)) return null;
    if (type === "email" && !/^\S+@\S+\.\S+$/.test(text)) return null;
    return message;
  }
  function assistantFields(results) {
    const fields = [];
    const current = {};
    const rows = {};
    results.forEach((r, i) => {
      if (!canAssist(r)) return;
      const key = `f${i}`;
      fields.push({
        key,
        label: questionLabel(r).slice(0, 1e3),
        kind: r.field.kind,
        options: (r.field.options ?? []).map((o) => String(o.text ?? "").slice(0, 500)).filter(Boolean).slice(0, 100),
        required: Boolean(r.field.required)
      });
      current[key] = r.status === "unresolved" ? "" : String(r.value ?? "").slice(0, MAX_TEXT);
      rows[key] = r;
    });
    return { fields, current, rows };
  }
  const short = (text, n = 140) => text.length > n ? `${text.slice(0, n).trimEnd()}\u2026` : text;
  const bare = (r) => short(questionLabel(r).replace(/[\s?:*]+$/, ""));
  const PERSONAL = /\b(?:first|middle|last|given|family|full|legal|maiden|preferred) name\b|\bsurname\b|^\s*name\b|your name|date of birth|\bdob\b|^\s*age\b|gender|pronoun|nationality|citizenship|marital|aadhaa?r|\bpan (?:number|card|no)\b|passport|\bssn\b|(?:phone|mobile|contact|id|whatsapp) (?:number|no)\b|e-?mail address|^\s*e-?mail\b|^\s*(?:phone|mobile|address|city|country|state|location|website|linkedin|github)\b|(?:current|home|postal|permanent) (?:address|location|city)|pin ?code|zip ?code|postal code|salary|\bctc\b|expected compensation|notice period|authori[sz]ed to work|right to work|work permit|(?:visa|require|need|needs) sponsorship|\bvisa\b|criminal|convicted|disabilit|veteran|ethnicity|^\s*race\b|years of (?:\w+ )?experience|experience \(?in years|how many years|(?:how soon|when) can you (?:join|start)|joining date|start date|(?:worked|employed) (?:for|at|with) us|previously (?:worked|employed)/i;
  const OPEN_ENDED = /statement|cover letter|summary|\bbio\b|motivation|about (?:you|yourself)|describe|explain|tell us|\bwhy\b|additional information|comments?\b/i;
  function draftable(field) {
    if (field?.kind !== "text") return false;
    const type = String(field.el?.type ?? "").toLowerCase();
    if (["email", "tel", "url", "number", "date"].includes(type)) return false;
    const label = (field.label ?? "").trim();
    if (PERSONAL.test(label)) return false;
    return field.el?.tagName === "TEXTAREA" || label.split(/\s+/).length >= 5 || /\?\s*\*?$/.test(label) || OPEN_ENDED.test(label);
  }
  function likelyFirst(options, suggestion) {
    const hint = String(suggestion ?? "").toLowerCase().trim();
    if (!hint || options.length <= MAX_CHOICES) return options;
    const hit = (o) => {
      const t = o.toLowerCase();
      return t === hint || hint.startsWith(t) || t.includes(hint);
    };
    return [...options.filter(hit), ...options.filter((o) => !hit(o))];
  }
  function phoneLabel(row) {
    if (row.field.phoneFor) return "Which country code does your phone number use";
    if (row.field.phoneCountry || row.field.el?.type === "tel") return "What phone number should we use";
    return null;
  }
  function nextPrompt(results) {
    const all0 = openQuestions(results);
    const open = all0.filter((r) => !(r.field.phoneFor && all0.some((o) => o.field === r.field.phoneFor)));
    if (open.length) {
      const first = open[0];
      const all = likelyFirst((first.field.options ?? []).map((o) => o.text).filter(Boolean), first.suggestion);
      const options = all.slice(0, MAX_CHOICES);
      const draft = !options.length && draftable(first.field);
      const required = open.some((r) => r.field.required);
      return {
        text: `${open.length === 1 ? "One question needs" : `${open.length} questions need`} your answer${required ? " before you can submit" : ""}.`,
        question: {
          label: `${phoneLabel(first) ?? bare(first)}?`,
          step: first.field.required ? "Required" : void 0,
          note: draft ? "Type your answer, or I can draft one." : all.length > MAX_CHOICES ? "Pick one, or type yours." : void 0
        },
        choices: draft ? [DRAFT_REPLY] : options,
        target: first
      };
    }
    const steps = manualSteps(results);
    if (steps.length) {
      const step = steps[0];
      const lead = steps.length === 1 ? "One thing only you can do:" : `${steps.length} things only you can do. First:`;
      return step.field.kind === "checkbox" && !step.field.options?.length ? { text: `${lead} \u201C${bare(step)}\u201D. Tick it yourself if you agree, or tap \u201C${AGREE_REPLY}\u201D.`, choices: [AGREE_REPLY, SHOW_REPLY] } : { text: `${lead} ${bare(step)}. ${step.reason ?? ""}`.trim(), choices: [SHOW_REPLY, DONE_REPLY] };
    }
    const optional = optionalTarget(results);
    if (optional) {
      const options = (optional.field.options ?? []).map((o) => o.text).filter(Boolean);
      const prompt = options.length ? { text: `Everything required is filled in. \u201C${bare(optional)}\u201D is optional: pick an answer, or leave it blank.`, choices: [...options.slice(0, MAX_CHOICES - 1), SKIP_REPLY] } : optional.draftAttempted ? { text: `I couldn't draft \u201C${bare(optional)}\u201D. Tell me the details, try drafting again, or leave it blank.`, choices: [DRAFT_REPLY, SKIP_REPLY] } : draftable(optional.field) ? { text: `Everything required is filled in. \u201C${bare(optional)}\u201D is optional, but a good answer helps. Want me to draft one, or tell me what to say?`, choices: [DRAFT_REPLY, SKIP_REPLY] } : { text: `Everything required is filled in. \u201C${bare(optional)}\u201D is optional: tell me what to put, or leave it blank.`, choices: [SKIP_REPLY] };
      return { ...prompt, target: optional };
    }
    return null;
  }
  function assistantGreeting(results) {
    const prompt = nextPrompt(results);
    if (prompt) return prompt;
    const n = results.filter((r) => r.status === "filled" && canAssist(r)).length;
    return n ? { text: `${n === 1 ? "The answer is" : `All ${n} answers are`} filled in. Check the form, and tell me here if one should change.`, choices: [] } : null;
  }
  const lineText = (l) => [l.text, l.question?.label].filter((t) => t?.trim()).join(" ").trim();
  function chatHistory(lines) {
    return lines.filter((l) => !l.greeting && !l.error && !l.step && (l.role === "user" || l.role === "assistant") && lineText(l)).map((l) => ({ role: l.role, text: lineText(l).slice(0, MAX_TEXT) })).slice(-MAX_TURNS);
  }
  globalThis.JobHuntPanel = {
    summarize,
    autoApplyBlockers,
    readinessNote,
    loginWall,
    friendlyError,
    sourceLabel,
    assistantFields,
    assistantGreeting,
    chatHistory,
    groundedDraft,
    nextPrompt,
    promptTarget,
    directAnswer,
    openQuestions,
    draftable,
    isDraftRequest,
    isPlainAnswer,
    isNavigateRequest,
    navigationNeeded,
    handoffText,
    agentAsk,
    ON_PAGE_REPLY,
    CONTINUE_REPLY,
    LOCAL_REPLIES,
    DRAFT_REPLY,
    SKIP_REPLY,
    AGREE_REPLY,
    SHOW_REPLY,
    DONE_REPLY
  };
})();
