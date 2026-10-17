// What the review panel and popup show, derived from fill results. Pure functions (no chrome.*,
// no rendering) so they're tested in jsdom. Exposed as globalThis.JobHuntPanel.
//
// A result is {field, status, value?, source?, needsReview?, reviewed?, reason?, suggestion?}:
//   status "filled"      the extension wrote a value
//   status "unresolved"  the user has to act
//   status "done"        was unresolved, and the user has since answered it (or marked it done)

(() => {
  const SOURCES = { profile: "From profile", answer_bank: "From answer bank", generated: "AI draft", you: "Your answer" };

  function sourceLabel(source) {
    return SOURCES[source] ?? source ?? "";
  }

  const isUpload = (r) => r.field.kind === "picker" || r.field.kind === "file";
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /**
   * Counts, the headline, and the ordered "next steps" checklist. A step is listed only when
   * the form has something for it; `remaining` reaching 0 ticks it off.
   */
  function summarize(results, { submitted = false } = {}) {
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
      counts: { filled: filled.length, unresolved: unresolved.length, done: done.length, toCheck: toCheck.length },
      headline,
      steps,
    };
  }

  /** Turns an error from the background worker into words and the one action that fixes it. */
  function friendlyError(message, status, baseUrl) {
    const msg = String(message ?? "");
    const where = baseUrl || "the platform";
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

  globalThis.JobHuntPanel = { summarize, friendlyError, sourceLabel };
})();
