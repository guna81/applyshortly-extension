// What the review panel and popup show, derived from fill results. Pure functions (no chrome.*,
// no rendering) so they're tested in jsdom. Exposed as globalThis.JobHuntPanel.
//
// A result is {field, status, value?, source?, needsReview?, reviewed?, reason?, suggestion?}:
//   status "filled"      the extension wrote a value
//   status "unresolved"  the user has to act
//   status "done"        was unresolved, and the user has since answered it (or marked it done)
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

  /**
   * What the chat should bring up next once the questions it can answer are done: an optional
   * question, then each step only the user can do. Null when nothing is left.
   */
  function nextPrompt(results) {
    const open = openQuestions(results);
    if (open.length) {
      const first = open[0];
      return {
        text: `${plural(open.length, "question")} ${open.length === 1 ? "needs" : "need"} your answer. Let's go one at a time. ${bare(first)}${first.field.required ? " (required)" : ""}?`,
        choices: (first.field.options ?? []).map((o) => o.text).filter(Boolean).slice(0, MAX_CHOICES),
      };
    }
    const optional = optionalTarget(results);
    if (optional) {
      const options = (optional.field.options ?? []).map((o) => o.text).filter(Boolean);
      return options.length
        ? { text: `Everything required is filled in. “${bare(optional)}” is optional: pick an answer, or leave it blank.`, choices: [...options.slice(0, MAX_CHOICES - 1), SKIP_REPLY] }
        : { text: `Everything required is filled in. “${bare(optional)}” is optional, but a good answer helps. Want me to draft one, or tell me what to say?`, choices: [DRAFT_REPLY, SKIP_REPLY] };
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
      text: 'Want to change anything? Tell me, e.g. "set notice period to 60 days", and I\'ll update the form. Review it before you submit.',
      choices: [],
    };
  }

  /** The conversation as the API takes it: no greeting or error lines, capped. */
  function chatHistory(lines) {
    return lines
      .filter((l) => !l.greeting && !l.error && (l.role === "user" || l.role === "assistant") && l.text?.trim())
      .map((l) => ({ role: l.role, text: l.text.trim().slice(0, MAX_TEXT) }))
      .slice(-MAX_TURNS);
  }

  /** Whether the Assistant tab should open first: there is a question it can help with. */
  const assistantFirst = (results) => Boolean(nextPrompt(results));

  globalThis.JobHuntPanel = {
    summarize, autoApplyBlockers, friendlyError, sourceLabel, assistantFields, assistantGreeting, chatHistory, assistantFirst,
    nextPrompt, promptTarget, openQuestions, LOCAL_REPLIES, DRAFT_REPLY, SKIP_REPLY, AGREE_REPLY, SHOW_REPLY, DONE_REPLY,
  };
})();
