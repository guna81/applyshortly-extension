// What the review panel and popup show, derived from fill results. Pure functions (no chrome.*,
// no rendering) so they're tested in jsdom. Exposed as globalThis.JobHuntPanel.
//
// A result is {field, status, value?, source?, needsReview?, reviewed?, reason?, suggestion?}:
//   status "filled"      the extension wrote a value
//   status "unresolved"  the user has to act
//   status "done"        already answered on the page, or the user answered/marked it done
//   status "optional"    an optional field nothing could answer; listed, never counted as a to-do

(() => {
  const SOURCES = { profile: "From profile", answer_bank: "From answer bank", generated: "AI draft", assistant: "From chat", you: "Your answer" };

  function sourceLabel(source) {
    return SOURCES[source] ?? source ?? "";
  }

  const isUpload = (r) => r.field.kind === "picker" || r.field.kind === "file";
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /**
   * Counts, the headline, and the ordered "next steps" checklist. A step is listed only when
   * the form has something for it; `remaining` reaching 0 ticks it off.
   */
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
      remaining: submitted ? 0 : 1,
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
      steps,
    };
  }

  // Application statuses that mean nothing has been sent yet (matches the popup's check).
  const OPEN_STATUSES = ["saved", "queued", "filling", "ready_for_review"];

  /**
   * Why "Auto apply" must not click Submit yet; empty when it may. Every required question
   * has to be answered on the page, and a tracked application must not already be sent or
   * waiting for verification (retrying one could submit twice).
   */
  function autoApplyBlockers(results, app) {
    const blockers = [];
    if (app?.status === "submission_unconfirmed") {
      blockers.push("A previous attempt needs verification in ApplyShortly first");
    } else if (app?.status && !OPEN_STATUSES.includes(app.status)) {
      blockers.push(`This application is already ${String(app.status).replace(/_/g, " ")}`);
    }
    if (!results.length) blockers.push("No form fields found on this page");
    const unresolved = results.filter((r) => r.status === "unresolved");
    if (unresolved.length) blockers.push(`${plural(unresolved.length, "required field")} still ${unresolved.length === 1 ? "needs" : "need"} you`);
    return blockers;
  }

  // The same sign-in paths the form agent treats as a login wall (agent/page.js).
  const LOGIN_URL = /\/(login|signin|sign_in|sign-in)\b|\/auth\//i;

  /**
   * Whether the page is asking the user to sign in: a password box is showing, or the path is a
   * sign-in one. Auto apply never submits there; the user signs in first.
   * @param {string} pathname @param {boolean} passwordShown
   */
  function loginWall(pathname, passwordShown) {
    return passwordShown || LOGIN_URL.test(pathname ?? "");
  }

  /** Turns an error from the background worker into words and the one action that fixes it. */
  function friendlyError(message, status, baseUrl, code) {
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

  const canAssist = (r) => ASSISTABLE.includes(r.field.kind);
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
  const isDraftRequest = (message) => DRAFT_ASK.test(String(message ?? "").trim());

  // The chat is the one agent: it fills what the profile covers, and when the page needs clicking
  // through (an Apply pop-up, Next steps, a form in a frame) it carries on driving the tab itself.
  const ON_PAGE_REPLY = "I'll fill it on the page";
  const CONTINUE_REPLY = "Continue";
  // "do the rest", "go to the next page", "continue the form": the user asks it to carry on.
  const NAVIGATE_ASK = /^(?:please\s+)?(?:(?:go|move|click)(?:\s+on)?(?:\s+to)?\s+(?:the\s+)?next(?:\s+(?:page|step))?|next(?:\s+(?:page|step))|(?:do|fill|finish|complete)\s+the\s+rest(?:\s+of\s+(?:it|the form))?|continue(?:\s+(?:the|this)\s+form|\s+to\s+the\s+next\s+(?:page|step)))[\s.!]*$/i;
  const isNavigateRequest = (message) => NAVIGATE_ASK.test(String(message ?? "").trim());

  /**
   * Why this page needs stepping through rather than filling in place, or null. `total` counts the
   * fields found, `hasSubmit` whether the form's one Submit button is on screen, `hasNext` a visible
   * Next/Continue button, `bigFrame` a large embedded frame (the form may be inside it).
   */
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
    asked: "OK, I'll carry on through the form.",
  };

  /** What the chat says as it starts driving the tab. */
  function handoffText(reason, { autoSubmit = false } = {}) {
    return [
      HANDOFF[reason] ?? HANDOFF.asked,
      "I'll ask here when I need you. Chrome shows a “started debugging” bar while I click through, and it uses one apply run of credits.",
      autoSubmit ? "Auto apply can't submit a form with several steps, so I'll stop before the end for you to check and submit." : "",
    ].filter(Boolean).join(" ");
  }

  /** The chat line for the agent waiting on the user: its question, or what to do on the page. */
  function agentAsk(question) {
    if (!question) return null;
    if (question.kind === "question") {
      const choices = (question.choices ?? []).slice(0, MAX_CHOICES);
      const draft = !choices.length && draftable({ kind: "text", label: question.text });
      return {
        text: "",
        question: { label: question.text, note: draft ? "Type your answer, or I can draft one." : undefined },
        choices: [...choices, ...(draft ? [DRAFT_REPLY] : []), ON_PAGE_REPLY],
        draftable: draft,
      };
    }
    return { text: `${question.text} Tap Continue when it's done.`, choices: [CONTINUE_REPLY] };
  }

  /** The optional question the assistant offers to help with, until it is answered or skipped. */
  const optionalTarget = (results) => results.find((r) => r.status === "optional" && canAssist(r) && !r.skipped) ?? null;
  /** Steps the chat can't answer for the user: ticking a checkbox, attaching a file. */
  const manualSteps = (results) => results.filter((r) => r.status === "unresolved" && !canAssist(r));
  const openQuestions = (results) => results.filter((r) => r.status === "unresolved" && canAssist(r));

  /** The row the chat's local quick replies act on: the optional question, then a manual step. */
  function promptTarget(results) {
    if (openQuestions(results).length) return null;
    return optionalTarget(results) ?? manualSteps(results)[0] ?? null;
  }
  const questionLabel = (r) => r.field.label || "Untitled question";

  /**
   * The value a chat reply gives the question the chat just asked (`row`), or null when it isn't a
   * plain answer to it: one of its options, or any text for a free-text question. The panel writes
   * it into the form itself, with no assistant call and no AI credit.
   */
  function directAnswer(row, message) {
    if (!row || !["unresolved", "optional"].includes(row.status) || !canAssist(row) || LOCAL_REPLIES.includes(message) || isDraftRequest(message)) return null;
    const options = (row.field.options ?? []).map((o) => String(o.text ?? "").trim()).filter(Boolean);
    if (options.length) return options.find((o) => o.toLowerCase() === message.toLowerCase()) ?? null;
    return row.field.kind === "text" ? message : null;
  }

  /**
   * The fields sent to the assistant, keyed `f<index>` for this turn only, with what is on the
   * page now. `rows` maps each key back to its result so the reply's updates can be written.
   */
  function assistantFields(results) {
    const fields = [];
    const current = {};
    const rows = {};
    results.forEach((r, i) => {
      if (!canAssist(r)) return;
      const key = `f${i}`;
      fields.push({
        key,
        label: questionLabel(r).slice(0, 1000),
        kind: r.field.kind,
        options: (r.field.options ?? []).map((o) => String(o.text ?? "").slice(0, 500)).filter(Boolean).slice(0, 100),
        required: Boolean(r.field.required),
      });
      current[key] = r.status === "unresolved" ? "" : String(r.value ?? "").slice(0, MAX_TEXT);
      rows[key] = r;
    });
    return { fields, current, rows };
  }

  const short = (text, n = 140) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);
  const bare = (r) => short(questionLabel(r).replace(/[\s?:*]+$/, ""));

  // Personal facts only the user knows: never offered as an AI draft.
  const PERSONAL = /\b(?:first|middle|last|given|family|full|legal|maiden|preferred) name\b|\bsurname\b|^\s*name\b|your name|date of birth|\bdob\b|^\s*age\b|gender|pronoun|nationality|citizenship|marital|aadhaa?r|\bpan (?:number|card|no)\b|passport|\bssn\b|(?:phone|mobile|contact|id|whatsapp) (?:number|no)\b|e-?mail address|^\s*e-?mail\b|^\s*(?:phone|mobile|address|city|country|state|location|website|linkedin|github)\b|(?:current|home|postal|permanent) (?:address|location|city)|pin ?code|zip ?code|postal code|salary|\bctc\b|expected compensation|notice period|authori[sz]ed to work|right to work|work permit|(?:visa|require|need|needs) sponsorship|\bvisa\b|criminal|convicted|disabilit|veteran|ethnicity|^\s*race\b|years of (?:\w+ )?experience|experience \(?in years|how many years|(?:how soon|when) can you (?:join|start)|joining date|start date|(?:worked|employed) (?:for|at|with) us|previously (?:worked|employed)/i;

  const OPEN_ENDED = /statement|cover letter|summary|\bbio\b|motivation|about (?:you|yourself)|describe|explain|tell us|\bwhy\b|additional information|comments?\b/i;

  /**
   * Whether "Draft it for me" fits: an open-ended question (a textarea, or a question of a few
   * words or more), not a short field or a personal fact about the user.
   */
  function draftable(field) {
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
  function likelyFirst(options, suggestion) {
    const hint = String(suggestion ?? "").toLowerCase().trim();
    if (!hint || options.length <= MAX_CHOICES) return options;
    const hit = (o) => {
      const t = o.toLowerCase();
      return t === hint || hint.startsWith(t) || t.includes(hint);
    };
    return [...options.filter(hit), ...options.filter((o) => !hit(o))];
  }

  function nextPrompt(results) {
    const open = openQuestions(results);
    if (open.length) {
      const first = open[0];
      const all = likelyFirst((first.field.options ?? []).map((o) => o.text).filter(Boolean), first.suggestion);
      const options = all.slice(0, MAX_CHOICES);
      const draft = !options.length && draftable(first.field);
      const required = open.some((r) => r.field.required);
      // Worded like the web app's review chat: a short line, then the question as a card.
      return {
        text: `${open.length === 1 ? "One question needs" : `${open.length} questions need`} your answer${required ? " before you can submit" : ""}.`,
        question: {
          label: `${bare(first)}?`,
          step: first.field.required ? "Required" : undefined,
          note: draft ? "Type your answer, or I can draft one." : all.length > MAX_CHOICES ? "Pick one, or type yours." : undefined,
        },
        choices: draft ? [DRAFT_REPLY] : options,
        target: first,
      };
    }
    const optional = optionalTarget(results);
    if (optional) {
      const options = (optional.field.options ?? []).map((o) => o.text).filter(Boolean);
      const prompt = options.length
        ? { text: `Everything required is filled in. “${bare(optional)}” is optional: pick an answer, or leave it blank.`, choices: [...options.slice(0, MAX_CHOICES - 1), SKIP_REPLY] }
        : draftable(optional.field)
          ? { text: `Everything required is filled in. “${bare(optional)}” is optional, but a good answer helps. Want me to draft one, or tell me what to say?`, choices: [DRAFT_REPLY, SKIP_REPLY] }
          : { text: `Everything required is filled in. “${bare(optional)}” is optional: tell me what to put, or leave it blank.`, choices: [SKIP_REPLY] };
      return { ...prompt, target: optional };
    }
    const steps = manualSteps(results);
    if (steps.length) {
      const step = steps[0];
      const lead = steps.length === 1 ? "One thing only you can do:" : `${steps.length} things only you can do. First:`;
      return step.field.kind === "checkbox" && !step.field.options?.length
        ? { text: `${lead} “${bare(step)}”. Tick it yourself if you agree, or tap “${AGREE_REPLY}”.`, choices: [AGREE_REPLY, SHOW_REPLY] }
        : { text: `${lead} ${bare(step)}. ${step.reason ?? ""}`.trim(), choices: [SHOW_REPLY, DONE_REPLY] };
    }
    return null;
  }

  /** Opening message and quick replies, like the web app's review assistant. */
  function assistantGreeting(results) {
    return nextPrompt(results) ?? {
      text: 'Want to change anything? Tell me, e.g. "set notice period to 60 days", and I\'ll update the fields.',
      choices: [],
    };
  }

  /** A line as the AI reads it: its text, then the question card it asks, if any. */
  const lineText = (l) => [l.text, l.question?.label].filter((t) => t?.trim()).join(" ").trim();

  /** The conversation as the API takes it: no greeting or error lines, capped. */
  function chatHistory(lines) {
    return lines
      .filter((l) => !l.greeting && !l.error && (l.role === "user" || l.role === "assistant") && lineText(l))
      .map((l) => ({ role: l.role, text: lineText(l).slice(0, MAX_TEXT) }))
      .slice(-MAX_TURNS);
  }

  globalThis.JobHuntPanel = {
    summarize, autoApplyBlockers, loginWall, friendlyError, sourceLabel, assistantFields, assistantGreeting, chatHistory,
    nextPrompt, promptTarget, directAnswer, openQuestions, draftable, isDraftRequest, isNavigateRequest, navigationNeeded, handoffText, agentAsk, ON_PAGE_REPLY, CONTINUE_REPLY, LOCAL_REPLIES, DRAFT_REPLY, SKIP_REPLY, AGREE_REPLY, SHOW_REPLY, DONE_REPLY,
  };
})();
