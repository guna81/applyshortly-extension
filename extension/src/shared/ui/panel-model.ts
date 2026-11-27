// What the review panel shows, derived from fill results. Pure functions (no chrome.*,
// no rendering) so they're tested in jsdom. Exposed as globalThis.JobHuntPanel.
//
// A result is {field, status, value?, source?, needsReview?, reviewed?, reason?, suggestion?}:
//   status "filled"      the extension wrote a value
//   status "unresolved"  the user has to act
//   status "done"        already answered on the page, or the user answered/marked it done
//   status "optional"    an optional field nothing could answer; listed, never counted as a to-do

(() => {
  const SOURCES: Record<string, string> = { profile: "From profile", answer_bank: "From answer bank", generated: "AI draft", assistant: "From chat", you: "Your answer" };

  function sourceLabel(source: string): string {
    return SOURCES[source] ?? source ?? "";
  }

  const isUpload = (r: any) => r.field.kind === "picker" || r.field.kind === "file";
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /**
   * Counts, the headline, and the ordered "next steps" checklist. A step is listed only when
   * the form has something for it; `remaining` reaching 0 ticks it off.
   */
  function summarize(all: any[], { submitted = false }: any = {}) {
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
      remaining: submitted ? 0 : 1,
    });

    const total = results.length;
    const answered = filled.length + done.length;
    const todo = unresolved.length + toCheck.length;
    let headline: string;
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
      steps,
    };
  }

  // Application statuses that mean nothing has been sent yet.
  const OPEN_STATUSES = ["saved", "queued", "filling", "ready_for_review"];

  /** Merge the live top-page scan with required fields found only by the frame-aware scan. */
  function missingRequired(results: any[], readiness: any = null) {
    const local = results.filter((r) => r.status === "unresolved");
    const extra = (readiness?.missing ?? []).filter((m: any) => m.framed ||
      results.filter((r) => r.field?.required && r.field.label === m.name).length !== 1);
    return { local, extra, count: local.length + extra.length };
  }

  /**
   * Why "Auto apply" must not click Submit yet; empty when it may. Every required question
   * has to be answered on the page, and a tracked application must not already be sent or
   * waiting for verification (retrying one could submit twice).
   * @param {any[]} results @param {any} app
   * @param {{ total?: number, framed?: number, missing?: {name: string, framed?: boolean}[] } | null} [readiness]
   * @param {boolean} [captchaPending]
   */
  function autoApplyBlockers(results: any[], app: any, readiness: any = null, captchaPending = false) {
    const blockers: string[] = [];
    if (app?.status === "submission_unconfirmed") {
      blockers.push("A previous attempt needs verification in ApplyShortly first");
    } else if (app?.status && !OPEN_STATUSES.includes(app.status)) {
      blockers.push(`This application is already ${String(app.status).replace(/_/g, " ")}`);
    }
    if (!results.length && !(readiness?.total > 0)) blockers.push("No form fields found on this page");
    const { local: unresolved, extra } = missingRequired(results, readiness);
    const topMissing = unresolved.length + extra.filter((m: any) => !m.framed).length;
    if (topMissing) blockers.push(`${plural(topMissing, "required field")} still ${topMissing === 1 ? "needs" : "need"} you`);
    // Fields inside a frame are not on this page's own list, so count the ones the agent found empty.
    const framedMissing = extra.filter((m: any) => m.framed);
    if (framedMissing.length) blockers.push(`${plural(framedMissing.length, "required field")} in the embedded form still ${framedMissing.length === 1 ? "needs" : "need"} you`);
    // Auto apply can only check and press what this page holds; a form in a frame is for the user to send.
    if (readiness?.framed > 0) blockers.push("This form is embedded in the page, so I can't check all of it from here. Review it and submit it yourself");
    if (captchaPending) blockers.push("The site still needs you to complete its CAPTCHA. Do that, then submit it yourself");
    return blockers;
  }

  /** One line for the chat when the agent found required fields it could not leave filled. */
  function readinessNote(readiness: any): string {
    const missing = readiness?.missing ?? [];
    if (!missing.length) return "";
    const names = missing.slice(0, 3).map((m: any) => `“${m.name}”`).join(", ");
    const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
    return `Still empty and required: ${names}${more}.`;
  }

  // The same sign-in paths the form agent treats as a login wall (page-control/page.js).
  const LOGIN_URL = /\/(login|signin|sign_in|sign-in)\b|\/auth\//i;

  /**
   * Whether the page is asking the user to sign in: a password box is showing, or the path is a
   * sign-in one. Auto apply never submits there; the user signs in first.
   */
  function loginWall(pathname: string, passwordShown: boolean): boolean {
    return passwordShown || LOGIN_URL.test(pathname ?? "");
  }

  const RESUME_FIELD = /\b(resume|r[eé]sum[eé]|cv|curriculum vitae|cover letter|lebenslauf|anschreiben)\b/i;
  const JOB_FIELD = /\b(linkedin|github|xing|portfolio|work authorization|authorized to work|sponsorship|visa|notice period|expected salary|desired salary|current salary|compensation|years of experience|current company|current title|willing to relocate|relocation|how did you hear|referred by|start date|availability|pronouns|veteran|disability|eeo|equal opportunity|gehaltsvorstellung|eintrittsdatum|kündigungsfrist|verfügbarkeit|arbeitserlaubnis)\b/i;
  const CONTACT_FIELD = /\b(first name|last name|full name|your name|email|e-mail|phone|mobile|telephone|vorname|nachname|telefon|handy|mobilnummer)\b/i;
  const JOB_CONTEXT = /\b(apply|application|job|jobs|career|careers|position|role|candidate|hiring|recruit|opening|vacancy|karriere|stelle|stellenangebot|jobs?angebot)\b/i;
  // Stronger than JOB_CONTEXT: every page on a job site says "jobs", far fewer say "apply".
  const APPLY_CONTEXT = /\b(apply|applying|application|bewerbung|bewerben)\b/i;
  const APPLY_SUBMIT = /\b(submit application|apply now|apply for|submit your application|complete application|send application|jetzt bewerben|bewerbung (?:absenden|senden|abschicken))\b/i;
  const APPLY_WORD = /\b(apply|bewerben)\b/i;
  // Buttons that sign up for something rather than send an application ("Sign up & apply" still applies).
  const SIGNUP_SUBMIT = /\b(subscribe|sign up|notify me|job alerts?|create alert)\b/i;
  // Buttons of a search or filter form: the boxes next to them are not an application.
  const FILTER_SUBMIT = /\b(filters?|search|find jobs|refine)\b/i;
  const PAYMENT_FIELD = /\b(credit card|card number|cvv|cvc|expir(?:y|ation)|billing address|shipping address|promo code|coupon)\b/i;
  // Boxes that are on the page but are not application questions: search, filters, chat and newsletter boxes.
  // The whole label must be one of these, so a question that only mentions "search" or "message" still counts.
  const NOISE_FIELD = /^\s*(?:search\b.{0,30}|keywords?|filters?|sort(?: by)?\b.{0,20}|type (?:your |a )?(?:message|answer|reply)|write a message|ask a question|newsletter\b.{0,30}|subscribe\b.{0,30})[\s.…:*]*$/i;

  /**
   * Whether a page currently displays a job application form, used only when the user enables
   * the optional floating "Start applying" launcher. Purely local — no network or AI calls.
   *
   * `fields` should be the fields that belong with the submit button (its form, when it has one).
   * A resume/CV upload decides on its own; otherwise the page is scored and must reach 4 points,
   * with at least two real fields and a sign that this is a job application: a job question, an
   * upload, or "apply" on the button or in the address, title or heading.
   */
  function looksLikeApplicationForm({
    fields = [],
    pathname = "",
    title = "",
    hasSubmit = false,
    passwordShown = false,
    submitText = "",
    pageHeading = "",
  }: any = {}): boolean {
    if (loginWall(pathname, Boolean(passwordShown))) return false;
    if (!Array.isArray(fields) || !fields.length) return false;
    if (fields.some((f: any) => PAYMENT_FIELD.test(String(f?.label ?? "")))) return false;

    const submit = String(submitText ?? "");
    // The submit button belongs to a search or filter form ("Apply filters"), not an application.
    if (FILTER_SUBMIT.test(submit)) return false;

    const isUpload = (f: any) => f?.kind === "file" || f?.kind === "picker";
    const applicantDetail = (label: string) => JOB_FIELD.test(label) || CONTACT_FIELD.test(label) || RESUME_FIELD.test(label);
    const real = fields.filter((f: any) => {
      const label = String(f?.label ?? "");
      if (f?.search) return false;
      return applicantDetail(label) || !NOISE_FIELD.test(label);
    });
    const labels = real.map((f: any) => String(f?.label ?? ""));

    if (real.some((f: any) => isUpload(f) && RESUME_FIELD.test(String(f?.label ?? "")))) return true;
    if (real.length < 2) return false;

    const jobFields = labels.filter((l) => JOB_FIELD.test(l)).length;
    const contactFields = labels.filter((l) => CONTACT_FIELD.test(l)).length;
    const hasUpload = real.some(isUpload);
    const contextText = `${pathname} ${title} ${pageHeading}`;
    const applySubmit = APPLY_SUBMIT.test(submit);
    const applyContext = APPLY_CONTEXT.test(contextText);
    const applyButton = applySubmit || APPLY_WORD.test(submit);
    // A contact form (name, email, message) is not an application unless a job question, an
    // upload or the word "apply" says so. A last step of only custom questions counts when both
    // the button and the page say "apply".
    if (!jobFields && !hasUpload && !applyButton && !applyContext) return false;
    if (!jobFields && !contactFields && !hasUpload && !(applyButton && applyContext)) return false;

    const signUp = SIGNUP_SUBMIT.test(submit) && !APPLY_WORD.test(submit);

    let score = Math.min(jobFields, 2) * 2;
    score += contactFields >= 2 ? 2 : contactFields;
    if (hasUpload) score += 1;
    if (applySubmit) score += 2;
    score += applyContext ? 2 : JOB_CONTEXT.test(contextText) ? 1 : 0;
    if (real.length >= 3) score += 1;
    if (hasSubmit && !signUp) score += 1;
    if (signUp) score -= 3;
    return score >= 4;
  }

  /** Turns an error from the background worker into words and the one action that fixes it. */
  function friendlyError(message: any, status: any, baseUrl: any, code: any) {
    const msg = String(message ?? "");
    const where = baseUrl || "the platform";
    if (code === "profile_missing") {
      return {
        title: "Finish setting up your profile",
        detail: "This account has no profile yet. Upload your resume on the ApplyShortly website, then try again.",
        action: "profile",
      };
    }
    if (status === 401 || status === 403 || /api key|unauthori[sz]ed|forbidden/i.test(msg)) {
      return {
        title: "ApplyShortly didn't accept the API key",
        detail: "Open settings and paste a current key.",
        action: "settings",
      };
    }
    if (/failed to fetch|networkerror|load failed|err_connection|network/i.test(msg)) {
      return {
        title: `Can't reach ApplyShortly at ${where}`,
        detail: "Check that the platform is running, then try again.",
        action: "retry",
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

  // ---- Assistant tab ----

  // Questions the chat may answer. Checkboxes (usually consent) and uploads stay with the user.
  const ASSISTABLE = ["text", "select", "radio", "dropdown"];
  const MAX_CHOICES = 8;
  const MAX_TURNS = 60;
  const MAX_TEXT = 4000;

  const canAssist = (r: any) => ASSISTABLE.includes(r.field.kind);
  // Quick replies the panel answers itself (no assistant call): an optional question, and the
  // steps only the user can do (a consent checkbox, an upload).
  const DRAFT_REPLY = "Draft it for me";
  const SKIP_REPLY = "Leave it blank";
  const AGREE_REPLY = "I agree, tick it";
  const SHOW_REPLY = "Show me";
  const DONE_REPLY = "I've done it";
  const LOCAL_REPLIES = [DRAFT_REPLY, SKIP_REPLY, AGREE_REPLY, SHOW_REPLY, DONE_REPLY];
  const DRAFT_ASK = /^(?:(?:please|can you|could you|pls)\s+)?(?:draft|write)(?:\s+(?:it|one|this|that|something|an? answer|the answer|an? draft))?(?:\s+for me)?(?:\s+please)?[\s.!?]*$/i;
  /** "Draft it for me", tapped or typed in the user's own words ("draft one", "write it for me"). */
  const isDraftRequest = (message: any) => DRAFT_ASK.test(String(message ?? "").trim());

  // The chat is the one agent: it fills what the profile covers, and when the page needs clicking
  // through (an Apply pop-up, Next steps, a form in a frame) it carries on driving the tab itself.
  const ON_PAGE_REPLY = "I'll fill it on the page";
  const CONTINUE_REPLY = "Continue";
  // "do the rest", "go to the next page", "continue the form": the user asks it to carry on.
  const NAVIGATE_ASK = /^(?:please\s+)?(?:(?:go|move|click)(?:\s+on)?(?:\s+to)?\s+(?:the\s+)?next(?:\s+(?:page|step))?|next(?:\s+(?:page|step))|(?:do|fill|finish|complete)\s+the\s+rest(?:\s+of\s+(?:it|the form))?|continue(?:\s+(?:the|this)\s+form|\s+to\s+the\s+next\s+(?:page|step)))[\s.!]*$/i;
  const isNavigateRequest = (message: any) => NAVIGATE_ASK.test(String(message ?? "").trim());

  /**
   * Why this page needs stepping through rather than filling in place, or null. `total` counts the
   * fields found, `hasSubmit` whether the form's one Submit button is on screen, `hasNext` a visible
   * Next/Continue button, `bigFrame` a large embedded frame (the form may be inside it).
   */
  function navigationNeeded({ total = 0, hasSubmit = false, hasNext = false, bigFrame = false }: any = {}) {
    if (!total && !bigFrame) return "none";
    if (bigFrame && total < 3) return "frame";
    if (!hasSubmit && hasNext) return "steps";
    return null;
  }

  const HANDOFF: Record<string, string> = {
    none: "I can't see a form on this page yet, so I'll open it (it may sit behind an Apply button or in a pop-up) and fill it.",
    frame: "The form is inside a frame, so I'll fill it from there.",
    steps: "This form has more than one step. I'll go through them and fill each one.",
    asked: "OK, I'll carry on through the form.",
  };

  /** What the chat says as it starts driving the tab. */
  function handoffText(reason: string, { autoSubmit = false }: any = {}): string {
    return [
      HANDOFF[reason] ?? HANDOFF.asked,
      "I'll ask here when I need you. Chrome shows a “started debugging” bar while I click through, and it uses one apply run of credits.",
      autoSubmit ? "Once every required answer is complete, Auto submit will resume with its cancellable countdown." : "",
    ].filter(Boolean).join(" ");
  }

  const PAGE_ACTION = /\b(?:links?|urls?|web ?sites?|pages?|tabs?|buttons?|click|open|navigate|sign[- ]?in|log[- ]?in|captcha|upload|attach|tick|untick|check ?box(?:es)?|consent)\b/i;
  // A question about one of these is answered by choosing or doing, never by drafted text.

  // A message that opens like a question or a command is for the agent to act on, not the answer to its question.
  // "fetch data from https://…" must reach it as an instruction, or the sentence itself is typed into the form.
  const INSTRUCTION = /^(?:please\s+)?(?:can|could|do|does|why|what|how|where|is|are|fill|set|change|select|choose|upload|click|continue|open|scroll|update|replace|fetch|read|look|visit|browse|pull|take|get|go|see|check)\b/i;

  /** True when the message answers the agent's question rather than telling it to do something. */
  const isPlainAnswer = (message: any) => !INSTRUCTION.test(String(message).trim());

  // A free-text "describe your situation" question that touches a legal fact (visa, work authorization).
  // A generic AI draft is refused for these; the agent may still write it from the profile and the
  // user's own earlier answers, so the button is offered and answered by the agent, not by `suggest`.
  const SITUATION = /\b(?:describe|explain|briefly|situation|tell us|elaborate|details?)\b/i;
  const GROUNDED_TOPIC = /visa|sponsor|work (?:permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work/i;
  /** An open question about the user's own legal situation, drafted only from their profile and answers. */
  const groundedDraft = (text: any) => SITUATION.test(text ?? "") && GROUNDED_TOPIC.test(text ?? "") && !PAGE_ACTION.test(text ?? "");

  /** The chat line for the agent waiting on the user: its question, or what to do on the page. */
  function agentAsk(question: any, engine: string) {
    if (!question) return null;
    if (question.kind === "question" && engine === "ai_led") {
      // The agent chose its buttons itself (ask_user actions); nothing is added or explained by code.
      const named: Record<string, string> = { draft: DRAFT_REPLY, skip: SKIP_REPLY, on_page: ON_PAGE_REPLY };
      const actions = (question.actions ?? []).map((a: string) => named[a]).filter(Boolean);
      return { text: "", question: { label: question.text }, choices: [...(question.choices ?? []), ...actions], draftable: actions.includes(DRAFT_REPLY) };
    }
    if (question.kind === "question") {
      const choices = (question.choices ?? []).slice(0, MAX_CHOICES);
      // A request to open a page, link or button is for the user to act on, never an answer to draft.
      const draft = false;
      // An optional field never blocks: it can be left blank (the agent moves on), not just "filled on the page".
      if (question.optional) {
        const note = choices.length ? "Optional: pick an answer, or leave it blank." : draft ? "Optional: type an answer, I can draft one, or leave it blank." : "Optional: type an answer, or leave it blank.";
        return {
          text: "",
          question: { label: question.text, note },
          choices: [...choices, ...(draft ? [DRAFT_REPLY] : []), SKIP_REPLY],
          draftable: draft,
        };
      }
      return {
        text: "",
        question: { label: question.text, note: draft ? "Type your answer, or I can draft one." : undefined },
        choices: [...choices, ...(draft ? [DRAFT_REPLY] : []), ON_PAGE_REPLY],
        draftable: draft,
      };
    }
    const text = String(question.text ?? "").trim();
    if (!text) return null;
    return { text: `${text} Tap Continue when it's done.`, choices: [CONTINUE_REPLY] };
  }

  /** The optional question the assistant offers to help with, until it is answered or skipped. */
  const optionalTarget = (results: any[]) => {
    const available = results.filter((r) => r.status === "optional" && canAssist(r) && !r.skipped);
    return available.find((r) => draftable(r.field)) ?? available[0] ?? null;
  };
  /** Steps the chat can't answer for the user: ticking a checkbox, attaching a file. */
  const manualSteps = (results: any[]) => results.filter((r) => r.status === "unresolved" && !canAssist(r));
  const openQuestions = (results: any[]) => results.filter((r) => r.status === "unresolved" && canAssist(r));

  /** The row the chat's local quick replies act on: the optional question, then a manual step. */
  function promptTarget(results: any[]) {
    if (openQuestions(results).length) return null;
    return manualSteps(results)[0] ?? optionalTarget(results) ?? null;
  }
  const questionLabel = (r: any) => r.field.label || "Untitled question";

  /**
   * The value a chat reply gives the question the chat just asked (`row`), or null when it isn't a
   * plain answer to it: one of its options, or any text for a free-text question. The panel writes
   * it into the form itself, with no assistant call and no AI credit.
   */
  function directAnswer(row: any, message: string) {
    if (!row || !["unresolved", "optional"].includes(row.status) || !canAssist(row) || LOCAL_REPLIES.includes(message) || isDraftRequest(message)) return null;
    const options = (row.field.options ?? []).map((o: any) => String(o.text ?? "").trim()).filter(Boolean);
    if (options.length) return options.find((o: string) => o.toLowerCase() === message.toLowerCase()) ?? null;
    // Editing instructions belong to the assistant, not verbatim in the current answer.
    if (/^(?:please\s+)?(?:set|change|update|correct|replace|use my|fill (?:these|this|the|my))\b/i.test(message.trim())) return null;
    if (row.field.kind !== "text") return null;
    // A phone/number/email field only takes a value of that shape; anything else (a question
    // about the page, say) goes to the assistant instead of being typed into the form.
    const type = String(row.field.el?.type ?? "").toLowerCase();
    const text = message.trim();
    if ((row.field.phoneCountry || type === "tel") && !/^\+?[\d\s().-]{6,20}$/.test(text)) return null;
    if (type === "number" && !/^-?[\d.,\s]+$/.test(text)) return null;
    if (type === "email" && !/^\S+@\S+\.\S+$/.test(text)) return null;
    return message;
  }

  /**
   * The fields sent to the assistant, keyed `f<index>` for this turn only, with what is on the
   * page now. `rows` maps each key back to its result so the reply's updates can be written.
   */
  function assistantFields(results: any[]) {
    const fields: any[] = [];
    const current: Record<string, string> = {};
    const rows: Record<string, any> = {};
    results.forEach((r, i) => {
      if (!canAssist(r)) return;
      const key = `f${i}`;
      fields.push({
        key,
        label: questionLabel(r).slice(0, 1000),
        kind: r.field.kind,
        options: (r.field.options ?? []).map((o: any) => String(o.text ?? "").slice(0, 500)).filter(Boolean).slice(0, 100),
        required: Boolean(r.field.required),
      });
      current[key] = r.status === "unresolved" ? "" : String(r.value ?? "").slice(0, MAX_TEXT);
      rows[key] = r;
    });
    return { fields, current, rows };
  }

  const short = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);
  const bare = (r: any) => short(questionLabel(r).replace(/[\s?:*]+$/, ""));

  // Personal facts only the user knows: never offered as an AI draft.
  const PERSONAL = /\b(?:first|middle|last|given|family|full|legal|maiden|preferred) name\b|\bsurname\b|^\s*name\b|your name|date of birth|\bdob\b|^\s*age\b|gender|pronoun|nationality|citizenship|marital|aadhaa?r|\bpan (?:number|card|no)\b|passport|\bssn\b|(?:phone|mobile|contact|id|whatsapp) (?:number|no)\b|e-?mail address|^\s*e-?mail\b|^\s*(?:phone|mobile|address|city|country|state|location|website|linkedin|github)\b|(?:current|home|postal|permanent) (?:address|location|city)|pin ?code|zip ?code|postal code|salary|\bctc\b|expected compensation|notice period|authori[sz]ed to work|right to work|work permit|(?:visa|require|need|needs) sponsorship|\bvisa\b|criminal|convicted|disabilit|veteran|ethnicity|^\s*race\b|years of (?:\w+ )?experience|experience \(?in years|how many years|(?:how soon|when) can you (?:join|start)|joining date|start date|(?:worked|employed) (?:for|at|with) us|previously (?:worked|employed)/i;

  const OPEN_ENDED = /statement|cover letter|summary|\bbio\b|motivation|about (?:you|yourself)|describe|explain|tell us|\bwhy\b|additional information|comments?\b/i;

  /**
   * Whether "Draft it for me" fits: an open-ended question (a textarea, or a question of a few
   * words or more), not a short field or a personal fact about the user.
   */
  function draftable(field: any): boolean {
    if (field?.kind !== "text") return false;
    const type = String(field.el?.type ?? "").toLowerCase();
    if (["email", "tel", "url", "number", "date"].includes(type)) return false;
    const label = (field.label ?? "").trim();
    if (PERSONAL.test(label)) return false;
    return field.el?.tagName === "TEXTAREA" || label.split(/\s+/).length >= 5 || /\?\s*\*?$/.test(label) || OPEN_ENDED.test(label);
  }

  /**
   * What the chat should bring up next once the questions it can answer are done: an optional
   * question, then each step only the user can do. Null when nothing is left.
   */
  /** Long option lists (country codes, countries) show the ones matching the suggestion first. */
  function likelyFirst(options: string[], suggestion: any): string[] {
    const hint = String(suggestion ?? "").toLowerCase().trim();
    if (!hint || options.length <= MAX_CHOICES) return options;
    const hit = (o: string) => {
      const t = o.toLowerCase();
      return t === hint || hint.startsWith(t) || t.includes(hint);
    };
    return [...options.filter(hit), ...options.filter((o) => !hit(o))];
  }

  /** A phone number (or its country code) is asked as the number, never as the selector's text. */
  function phoneLabel(row: any): string | null {
    if (row.field.phoneFor) return "Which country code does your phone number use";
    if (row.field.phoneCountry || row.field.el?.type === "tel") return "What phone number should we use";
    return null;
  }

  function nextPrompt(results: any[]) {
    const all0 = openQuestions(results);
    // A number and its country selector both open: ask for the number once, with its country code.
    const open = all0.filter((r) => !(r.field.phoneFor && all0.some((o) => o.field === r.field.phoneFor)));
    if (open.length) {
      const first = open[0];
      const all = likelyFirst((first.field.options ?? []).map((o: any) => o.text).filter(Boolean), first.suggestion);
      const options = all.slice(0, MAX_CHOICES);
      const draft = false;
      const required = open.some((r) => r.field.required);
      // Worded like the web app's review chat: a short line, then the question as a card.
      return {
        text: `${open.length === 1 ? "One question needs" : `${open.length} questions need`} your answer${required ? " before you can submit" : ""}.`,
        question: {
          label: `${phoneLabel(first) ?? bare(first)}?`,
          step: first.field.required ? "Required" : undefined,
          note: draft ? "Type your answer, or I can draft one." : all.length > MAX_CHOICES ? "Pick one, or type yours." : undefined,
        },
        choices: draft ? [DRAFT_REPLY] : options,
        target: first,
      };
    }
    const steps = manualSteps(results);
    if (steps.length) {
      const step = steps[0];
      const lead = steps.length === 1 ? "One thing only you can do:" : `${steps.length} things only you can do. First:`;
      return step.field.kind === "checkbox" && !step.field.options?.length
        ? { text: `${lead} “${bare(step)}”. Tick it yourself if you agree, or tap “${AGREE_REPLY}”.`, choices: [AGREE_REPLY, SHOW_REPLY] }
        : { text: `${lead} ${bare(step)}. ${step.reason ?? ""}`.trim(), choices: [SHOW_REPLY, DONE_REPLY] };
    }
    const optional = optionalTarget(results);
    if (optional) {
      const options = (optional.field.options ?? []).map((o: any) => o.text).filter(Boolean);
      const prompt = options.length
        ? { text: `Everything required is filled in. “${bare(optional)}” is optional: pick an answer, or leave it blank.`, choices: [...options.slice(0, MAX_CHOICES - 1), SKIP_REPLY] }
        : { text: `Everything required is filled in. “${bare(optional)}” is optional: tell me what to put, or leave it blank.`, choices: [SKIP_REPLY] };
      return { ...prompt, target: optional };
    }
    return null;
  }

  /**
   * Opening message and quick replies, like the web app's review assistant: the next question,
   * else a line about this form's answers, else nothing (a page without questions gets no chat
   * line; the input's placeholder already says it takes changes).
   */
  function assistantGreeting(results: any[]) {
    const prompt = nextPrompt(results);
    if (prompt) return prompt;
    const n = results.filter((r) => r.status === "filled" && canAssist(r)).length;
    return n ? { text: `${n === 1 ? "The answer is" : `All ${n} answers are`} filled in. Check the form, and tell me here if one should change.`, choices: [] } : null;
  }

  /** A line as the AI reads it: its text, then the question card it asks, if any. */
  const lineText = (l: any) => [l.text, l.question?.label].filter((t: any) => t?.trim()).join(" ").trim();

  /** The conversation as the API takes it: no greeting or error lines, capped. */
  function chatHistory(lines: any[]) {
    return lines
      .filter((l) => !l.greeting && !l.error && !l.step && (l.role === "user" || l.role === "assistant") && lineText(l))
      .map((l) => ({ role: l.role, text: lineText(l).slice(0, MAX_TEXT) }))
      .slice(-MAX_TURNS);
  }

  (globalThis as any).JobHuntPanel = {
    summarize, autoApplyBlockers, missingRequired, readinessNote, loginWall, looksLikeApplicationForm, friendlyError, sourceLabel, assistantFields, assistantGreeting, chatHistory,
    groundedDraft, nextPrompt, promptTarget, directAnswer, openQuestions, draftable, isDraftRequest, isPlainAnswer, isNavigateRequest, navigationNeeded, handoffText, agentAsk, ON_PAGE_REPLY, CONTINUE_REPLY, LOCAL_REPLIES, DRAFT_REPLY, SKIP_REPLY, AGREE_REPLY, SHOW_REPLY, DONE_REPLY,
  };
})();
