// Runs on every page but stays idle unless the page was opened with #jobhunt-autofill=<id>,
// is a later page of a form already being filled in this tab, or the popup says "Autofill".
// It fills and reports. It submits only on the user's explicit "Auto apply", once every required
// field is answered and after a cancellable countdown; otherwise the user clicks the site's button.

(() => {
  if (globalThis.__jobhuntContentLoaded) return;
  globalThis.__jobhuntContentLoaded = true;

  const F = globalThis.JobHuntFill;
  const P = globalThis.JobHuntPanel;
  let state = null; // {appId, ctx, resume, results}
  let submittedReported = false;
  let autoSubmitting = false; // Auto apply clicked Submit; its own report covers the submit event
  const AUTO_APPLY_DELAY_S = 3;
  // The Assistant tab's conversation for this page; reset with `state`.
  const newChat = () => ({ lines: [], draft: "", pending: false });
  let chat = newChat();
  // The form agent's latest update for this tab (it runs in the background; see agent/loop.js).
  let agent = null;

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) {
          const err = new Error(res?.error ?? "No response from the extension");
          err.status = res?.status;
          err.code = res?.code;
          return reject(err);
        }
        resolve(res.data);
      });
    });
  }

  function report(event, extra = {}) {
    if (state?.appId == null) return Promise.resolve(null);
    // The API caps url at 2000 and note at 1000 characters.
    const payload = { application_id: state.appId, event, url: location.href.slice(0, 2000), ...extra };
    if (payload.note) payload.note = String(payload.note).slice(0, 1000);
    return send({ type: "report", event: payload }).catch(
      (err) => console.warn("[JobHunt] report failed:", err.message),
    );
  }

  function reportFilled() {
    const filled = state.results.filter((r) => r.status === "filled");
    const unresolved = state.results.filter((r) => r.status === "unresolved");
    return report("filled", {
      filled_fields: filled.map((r) => ({
        label: r.field.label,
        value: r.value,
        source: r.source,
        needs_review: Boolean(r.needsReview),
      })),
      unresolved_fields: unresolved.map((r) => ({ label: r.field.label, reason: r.reason })),
    });
  }

  async function resolveAnswer(field, allowGenerate) {
    const local = F.profileAnswer(field.label, state.ctx.profile, state.ctx.app);
    if (local) return { value: local.value, source: "profile", needsReview: local.needsReview };
    if (!field.label) return null;
    // Long questions ("Current CTC? Mention fixed and variable components separately.") match the
    // answer bank poorly as a whole, so retry with just the first sentence before drafting with AI.
    const head = F.firstSentence(field.label);
    const attempts = head !== field.label ? [[field.label, false], [head, false]] : [[field.label, false]];
    if (allowGenerate) attempts.push([field.label, true]);
    for (const [question, generate] of attempts) {
      try {
        const s = await send({ type: "suggest", question, appId: state.appId, allowGenerate: generate });
        if (s.answer) return { value: s.answer, source: s.source, needsReview: s.needs_review };
      } catch (err) {
        console.warn("[JobHunt] suggest failed:", err.message);
        return null;
      }
    }
    return null;
  }

  function isResumeInput(field, fileFields) {
    if (/cover/i.test(field.label)) return false;
    return /resume|résumé|\bcv\b|curriculum/i.test(field.label) || fileFields.length === 1;
  }

  /** Writes one answer into a field and returns its result row. */
  async function applyAnswer(field, answer) {
    if (!answer) {
      if (field.required) return { field, status: "unresolved", reason: "Not in your profile or answer bank yet" };
      // Optional and still empty: listed (and offered to the assistant) without counting as a to-do.
      return { field, status: "optional", optional: true, reason: "Optional" };
    }
    // An AI draft only counts for a choice question when it names an option outright.
    const strict = answer.source === "generated";
    if (field.kind === "dropdown") {
      const picked = field.custom ? await F.pickDropdown(field, answer.value, { strict }) : null;
      if (picked === null) {
        return { field, status: "unresolved", reason: `Pick “${answer.value}” from the list`, suggestion: answer.value };
      }
      return { field, status: "filled", value: picked, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
    }
    const written = F.apply(field, answer.value, { strict });
    if (written === null) {
      return { field, status: "unresolved", reason: `None of the options match “${answer.value}”`, suggestion: answer.value };
    }
    return { field, status: "filled", value: written, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
  }

  async function fillAll({ allowGenerate }) {
    const fields = F.collectFields(document);
    const fileFields = fields.filter((f) => f.kind === "file");
    const results = [];

    const answerable = fields.filter((f) => ["text", "select", "radio", "dropdown"].includes(f.kind) && F.isEmpty(f));
    const answers = await Promise.all(answerable.map((f) => resolveAnswer(f, allowGenerate)));
    const answerFor = new Map(answerable.map((f, i) => [f, answers[i]]));

    for (const field of fields) {
      if (field.kind === "checkbox") {
        if (field.required && !answeredNow(field)) {
          results.push({ field, status: "unresolved", reason: field.options?.length ? "Select the options that apply on the form" : "Tick it yourself if you agree" });
        }
        continue;
      }
      if (field.kind === "picker") {
        if (!answeredNow(field)) {
          results.push({ field, status: "unresolved", reason: "Download your CV, then use the form's Add file button" });
        }
        continue;
      }
      if (field.kind === "file") {
        if (!F.isEmpty(field)) continue;
        if (isResumeInput(field, fileFields) && state.resume) {
          try {
            F.attachFile(field.el, state.resume);
            results.push({ field, status: "filled", value: state.resume.name, source: "profile" });
          } catch {
            results.push({ field, status: "unresolved", reason: "Attach your CV yourself" });
          }
        } else if (field.required) {
          results.push({ field, status: "unresolved", reason: "Required file" });
        }
        continue;
      }
      if (!answerFor.has(field)) continue; // already had a value
      const row = await applyAnswer(field, answerFor.get(field));
      if (row) results.push(row);
    }
    const checked = await validate(results, fields);
    await readChoices(checked);
    return checked;
  }

  /**
   * Custom dropdowns only show their options while open, so the ones still waiting on the user get
   * them read once here: the panel offers them as choices and the assistant must pick one of them.
   */
  async function readChoices(results) {
    for (const row of results) {
      const { field } = row;
      if (!field.custom || field.options?.length || !["unresolved", "optional"].includes(row.status)) continue;
      field.options = await F.readDropdownOptions(field);
    }
  }

  const SETTLE_MS = 300; // pages re-validate a moment after a value is written

  /**
   * Looks at what the page itself says about the filled values: a value the site rejects is retried
   * as a plain number ("5.6 years" → "5.6") and otherwise handed back to the user with the site's
   * message. Fields that were already filled but are flagged invalid join the list too.
   */
  async function validate(results, fields) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    for (const row of results) {
      if (row.status !== "filled" || !F.isInvalid(row.field)) continue;
      if (!(await repair(row))) {
        const why = F.invalidReason(row.field);
        Object.assign(row, { status: "unresolved", reason: why ? `The site says: “${why}”` : "The site doesn't accept this answer", suggestion: row.value });
      }
    }
    const known = new Set(results.map((r) => r.field.el));
    for (const field of fields) {
      if (known.has(field.el) || !["text", "select", "radio", "dropdown"].includes(field.kind) || F.isEmpty(field) || !F.isInvalid(field)) continue;
      const why = F.invalidReason(field);
      results.push({ field, status: "unresolved", reason: why ? `The site says: “${why}”` : "The site doesn't accept this answer" });
    }
    return results;
  }

  /** Tries the number-only spellings of a rejected text answer; true when the site accepts one. */
  async function repair(row) {
    if (row.field.kind !== "text") return false;
    const original = row.value;
    for (const candidate of F.numericVariants(original)) {
      F.apply(row.field, candidate);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (!F.isInvalid(row.field)) {
        row.value = candidate;
        return true;
      }
    }
    F.apply(row.field, original);
    return false;
  }

  async function loadResume() {
    try {
      const r = await send({ type: "resume" });
      if (!r) return null;
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      return new File([bytes], r.name, { type: r.type });
    } catch {
      return null;
    }
  }

  function merge(previous, next) {
    // Keep earlier "filled" and "done" rows (their fields aren't empty, so a re-run skips them).
    const byEl = new Map(previous.map((r) => [r.field.el, r]));
    for (const r of next) byEl.set(r.field.el, r);
    return [...byEl.values()].sort((a, b) => (a.field.el.compareDocumentPosition(b.field.el) & 4 ? -1 : 1));
  }

  async function run(appId, { allowGenerate } = {}) {
    try {
      if (!state || state.appId !== appId) {
        panel.busy("Loading your profile…");
        const [ctx, resume] = await Promise.all([send({ type: "context", appId }), loadResume()]);
        state = { appId, ctx, resume, results: [] };
        chat = newChat();
        await report("opened");
      }
      const generate = allowGenerate ?? state.ctx.aiDrafts;
      panel.busy(generate ? "Drafting answers with AI… this can take a few seconds" : "Matching your answers to the form…");
      state.results = merge(state.results, await fillAll({ allowGenerate: generate }));
      outline();
      await reportFilled();
      panel.idle();
      return true;
    } catch (err) {
      panel.fail(err);
      await report("failed", { note: err.message });
      return false;
    }
  }

  /** Per-row "Draft with AI": one field only. */
  async function draftOne(row) {
    row.drafting = true;
    panel.idle();
    const answer = await resolveAnswer(row.field, true);
    row.drafting = false;
    const next = answer ? await applyAnswer(row.field, answer) : null;
    if (next?.status === "filled") {
      state.results = merge(state.results, [next]);
      outline();
      panel.toast("Drafted. Read it over before you submit.");
      await reportFilled();
    } else {
      panel.toast(next?.suggestion ? next.reason : "AI couldn't draft this one. Please answer it yourself.");
    }
    panel.idle();
  }

  // ------------------------------------------------------------------ assistant tab

  /** Writes the assistant's validated values into the page; returns the labels it filled. */
  async function applyAssistantUpdates(updates, rows) {
    const changed = [];
    for (const [key, value] of Object.entries(updates ?? {})) {
      const r = rows[key];
      if (!r || typeof value !== "string" || !value.trim()) continue;
      const next = await applyAnswer(r.field, { value, source: "assistant", needsReview: false });
      if (next) changed.push(next);
    }
    if (!changed.length) return [];
    state.results = merge(state.results, changed);
    outline();
    void reportFilled();
    return changed.filter((r) => r.status === "filled").map((r) => r.field.label || "answer");
  }

  const DONE_TEXT = "That's everything. Review the form and click its own Submit button when you're ready.";

  /** "Draft it for me": the per-field AI draft (profile + job), started from the chat. */
  async function assistantDraft(row) {
    const answer = await resolveAnswer(row.field, true);
    const next = answer ? await applyAnswer(row.field, answer) : null;
    if (next?.status !== "filled") return { text: "I couldn't draft this one. Tell me what you'd like to say and I'll put it in." };
    state.results = merge(state.results, [next]);
    outline();
    void reportFilled();
    return { text: "Here's a draft based on your profile and this job. Read it over in the form, or tell me what to change.", filled: [row.field.label || "answer"], next: true };
  }

  /** Quick replies the panel handles itself: nothing is sent to the assistant. */
  async function localReply(message, row) {
    const markDone = () => {
      Object.assign(row, { status: "done", manual: true, source: "you" });
      outline();
    };
    if (message === P.DRAFT_REPLY && row.status === "optional") {
      return P.draftable(row.field)
        ? assistantDraft(row)
        : { text: "That's a detail only you know, so I won't draft it. Tell me what to put, or leave it blank." };
    }
    if (message === P.SKIP_REPLY && row.status === "optional") {
      row.skipped = true;
      return { text: "OK, leaving it blank.", next: true };
    }
    if (message === P.AGREE_REPLY && row.field.kind === "checkbox" && !row.field.options?.length) {
      // A deterministic click on the user's explicit "I agree", never a model decision.
      if (!answeredNow(row.field)) row.field.el.click();
      if (!answeredNow(row.field)) return { text: "I couldn't tick it. Please tick it on the form yourself." };
      markDone();
      return { text: "Ticked.", next: true };
    }
    if (message === P.SHOW_REPLY) {
      panel.focus(row.field);
      return { text: "It's highlighted on the page.", choices: row.field.kind === "checkbox" && !row.field.options?.length ? [P.AGREE_REPLY] : [P.DONE_REPLY] };
    }
    if (message === P.DONE_REPLY && row.status === "unresolved") {
      if (row.field.options?.length && row.field.kind === "checkbox" && !answeredNow(row.field)) {
        return { text: "Select at least one option on the form first.", choices: [P.SHOW_REPLY, P.DONE_REPLY] };
      }
      markDone();
      return { text: "Great.", next: true };
    }
    return null;
  }

  /** The reply line, followed by whatever the chat should bring up next. */
  function withNext(reply) {
    if (!reply.next) return reply;
    const next = P.nextPrompt(state.results);
    return { ...reply, text: `${reply.text} ${next ? next.text : DONE_TEXT}`, choices: next?.choices ?? [] };
  }

  /** One chat turn. Like the web app's review assistant: it fills fields, the user submits. */
  async function askAssistant(text) {
    const message = text.trim();
    if (!message || chat.pending || !state?.ctx) return;
    const target = P.LOCAL_REPLIES.includes(message) ? P.promptTarget(state.results) : null;
    if (target) {
      const turn = chat;
      if (!turn.lines.length) turn.lines.push({ role: "assistant", greeting: true, ...P.assistantGreeting(state.results) });
      turn.lines.push({ role: "user", text: message });
      turn.pending = true;
      panel.idle();
      try {
        const reply = await localReply(message, target);
        if (turn !== chat) return;
        turn.lines.push({ role: "assistant", local: true, ...withNext(reply ?? { text: "Tell me what you'd like to do." }) });
      } finally {
        turn.pending = false;
        panel.idle();
      }
      return;
    }
    const { fields, current, rows } = P.assistantFields(state.results);
    if (!fields.length) {
      panel.toast("There are no questions on this page the assistant can answer.");
      return;
    }
    const turn = chat;
    if (!turn.lines.length) turn.lines.push({ role: "assistant", greeting: true, ...P.assistantGreeting(state.results) });
    turn.lines.push({ role: "user", text: message });
    turn.draft = "";
    turn.pending = true;
    panel.idle();
    try {
      const res = await send({ type: "assist", appId: state.appId, messages: P.chatHistory(turn.lines), fields, current });
      if (turn !== chat) return; // another application started meanwhile
      const filled = await applyAssistantUpdates(res.updates, rows);
      // Once the questions it can answer are done, bring up the optional and manual steps.
      const moveOn = !P.openQuestions(state.results).length && (res.done || !res.choices?.length);
      const reply = { text: res.reply, filled, warnings: res.warnings ?? [], choices: res.done ? [] : res.choices ?? [], next: moveOn };
      turn.lines.push({ role: "assistant", ...withNext(reply) });
    } catch (err) {
      turn.lines.pop();
      if (turn.lines.length === 1) turn.lines = [];
      turn.draft = message;
      panel.toast(`Assistant unavailable: ${err.message}`);
    } finally {
      turn.pending = false;
      panel.idle();
    }
  }

  // ------------------------------------------------------------------ live re-check

  /** Whether the user has answered a field, by looking at the page as it is now. */
  function answeredNow(field) {
    switch (field.kind) {
      case "checkbox":
        if (field.options?.length) return field.options.some((o) => o.el.checked === true);
        return field.el.checked === true || field.el.getAttribute("aria-checked") === "true";
      case "dropdown":
        return Boolean(F.dropdownValue(field)) && !F.isInvalid(field);
      case "picker": // Google Forms hides "Add file" once the file is attached
        return ![...field.el.querySelectorAll('[role="button"]')].some(
          (b) => /add file|upload/i.test(b.textContent) && b.getClientRects().length > 0,
        );
      default:
        return !F.isEmpty(field) && !F.isInvalid(field);
    }
  }

  function currentValue(field) {
    if (field.kind === "text") return field.el.value;
    if (field.kind === "select") return field.el.selectedOptions[0]?.text ?? "";
    if (field.kind === "dropdown" && field.custom) return F.dropdownValue(field);
    return null;
  }

  /** Ticks off what the user answered by hand, without another fill pass. */
  function recheck() {
    if (!state?.results.length) return;
    let changed = false;
    for (const r of state.results) {
      if ((r.status === "unresolved" || r.status === "optional") && answeredNow(r.field)) {
        Object.assign(r, { status: "done", source: "you", value: currentValue(r.field) });
        changed = true;
      } else if (r.status === "done" && (!r.manual || r.field.kind === "checkbox" && r.field.options?.length) && !answeredNow(r.field)) {
        r.status = r.optional ? "optional" : "unresolved";
        changed = true;
      } else if (r.status === "filled" && F.isInvalid(r.field)) {
        const why = F.invalidReason(r.field);
        Object.assign(r, { status: "unresolved", reason: why ? `The site says: “${why}”` : "The site doesn't accept this answer" });
        changed = true;
      } else if (r.status === "filled" || r.status === "done") {
        const now = currentValue(r.field);
        if (now !== null && now !== r.value) {
          Object.assign(r, { value: now, source: "you", reviewed: true });
          changed = true;
        }
      }
    }
    if (changed) {
      outline();
      panel.idle();
    }
  }

  let recheckTimer = 0;
  for (const type of ["input", "change", "click"]) {
    document.addEventListener(
      type,
      (e) => {
        if (e.target?.tagName === "JOBHUNT-AUTOFILL-PANEL") return;
        clearTimeout(recheckTimer);
        recheckTimer = setTimeout(recheck, 350);
      },
      true,
    );
  }

  // ------------------------------------------------------------------ field outlines

  const COLORS = {
    filled: ["#16a34a", "rgba(22,163,74,.12)", "ApplyShortly filled this"],
    check: ["#d97706", "rgba(217,119,6,.14)", "ApplyShortly filled this: please check it"],
    todo: ["#dc2626", "rgba(220,38,38,.10)", "ApplyShortly: this needs your answer"],
  };

  function outlineTarget(field) {
    if (field.kind === "radio" && !field.aria) return field.el.closest("fieldset") ?? field.el;
    return field.el;
  }

  function outline() {
    for (const r of state.results) {
      if (r.status === "optional") continue; // optional and empty: nothing to flag on the page
      const el = outlineTarget(r.field);
      if (!el?.style) continue;
      const kind = r.status === "unresolved" ? "todo" : r.status === "filled" && r.needsReview && !r.reviewed ? "check" : "filled";
      const [color, tint, tip] = COLORS[kind];
      el.style.outline = `2px ${kind === "todo" ? "dashed" : "solid"} ${color}`;
      el.style.outlineOffset = "3px";
      el.style.borderRadius ||= "4px";
      el.style.boxShadow = `0 0 0 6px ${tint}`;
      if (!el.title || el.dataset.jobhuntTip) {
        el.title = tip;
        el.dataset.jobhuntTip = "1";
      }
    }
  }

  async function markSubmitted(note) {
    if (submittedReported || state?.appId == null) return;
    submittedReported = true;
    await report("submitted", note ? { note } : {});
    panel.idle();
  }

  /**
   * "Auto apply": clicks the form's own Submit button, but only when every required field is
   * answered, there is exactly one submit button, and the user doesn't cancel the countdown.
   */
  async function autoApply() {
    if (!state?.ctx || autoSubmitting || submittedReported) return;
    recheck();
    const blocked = P.autoApplyBlockers(state.results, state.ctx.app);
    if (blocked.length) return panel.stop(`Not submitted: ${blocked.join(". ")}.`);
    const button = F.findSubmitButton(document, state.results.map((r) => r.field), { includeDisabled: true });
    if (!button) return panel.stop("Not submitted: couldn't find a single Submit button. Click the form's own Submit button.");
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return panel.stop("Not submitted: the form's Submit button is still disabled, so something on the form isn't complete yet.");
    }
    const form = button.form ?? button.closest("form");
    if (form && !form.checkValidity()) {
      form.reportValidity();
      return panel.stop("Not submitted: the form says a field isn't valid yet.");
    }
    if (!(await panel.countdown(AUTO_APPLY_DELAY_S))) return panel.toast("Submit cancelled. Nothing was submitted.");
    // The user may have edited the form during the countdown.
    recheck();
    const currentFields = F.collectFields(document);
    const currentButton = F.findSubmitButton(document, currentFields, { includeDisabled: true });
    if (P.autoApplyBlockers(state.results, state.ctx.app).length ||
        currentFields.some((field) => (field.required && !answeredNow(field)) || F.isInvalid(field)) ||
        currentButton !== button || !button.isConnected || button.disabled ||
        button.getAttribute("aria-disabled") === "true" || (form && !form.checkValidity())) {
      return panel.stop("Not submitted: the form changed. Check it and try again.");
    }
    autoSubmitting = true;
    await report("submission_attempted", { note: "auto apply clicked the form's submit button; confirmation not yet detected" });
    if (state.ctx.app) state.ctx.app = { ...state.ctx.app, status: "submission_unconfirmed" };
    button.click();
    panel.idle();
    panel.toast("Submission attempted. Check the page for the site's confirmation.");
    // Keep this page locked after an attempt; another click must not submit it twice.
  }

  // ------------------------------------------------------------------ panel (shadow DOM)

  const panel = (() => {
    let host = null;
    let root = null;
    // What the panel shows besides the results: one of busy / error, plus UI state.
    const view = {
      busy: null,
      error: null,
      toast: null,
      minimized: false,
      confirmSubmit: false,
      countdown: null, // {left, cancel} while Submit waits to click the form's button
      tab: null, // "assistant" (chat and the agent) | "form"; null until chosen: Assistant first when it can help
      agentDraft: "",
      chatSeen: 0,
      open: { todo: true, check: true, optional: true, filled: false },
      expanded: new WeakSet(),
    };
    let toastTimer = 0;

    const css = `
      :host { all: initial; }
      .wrap {
        --bg: #ffffff; --fg: #18181b; --muted: #6b7280; --line: #e5e7eb; --soft: #f4f4f6; --hover: #ececf1;
        --accent: #4f46e5; --accent-soft: #eef2ff; --good: #15803d; --good-soft: #dcfce7;
        --warn: #b45309; --warn-soft: #fef3c7; --bad: #b91c1c; --bad-soft: #fee2e2;
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      }
      @media (prefers-color-scheme: dark) {
        .wrap {
          --bg: #17181e; --fg: #ececf1; --muted: #9ca3af; --line: #2c2d36; --soft: #20212a; --hover: #2a2b35;
          --accent: #818cf8; --accent-soft: #272a4a; --good: #86efac; --good-soft: #14532d55;
          --warn: #fcd34d; --warn-soft: #78350f66; --bad: #fca5a5; --bad-soft: #7f1d1d55;
        }
      }
      .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 440px;
        max-width: calc(100vw - 32px); min-height: min(560px, calc(100vh - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column;
        background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
        box-shadow: 0 18px 48px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.08); overflow: hidden;
        }
      .p.enter { animation: in .18s ease-out; }
      @keyframes in { from { opacity: 0; transform: translateY(8px); } }
      .h { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 14px; }
      .mark { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
        /* Embedded from frontend/public/favicon.svg so the panel needs no exposed extension resources. */
        background: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%0A%20%20%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%234f46e5%22%2F%3E%0A%20%20%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%0A%20%20%20%20%3Cpath%20d%3D%22M8%2024%2015%208h2l4%209%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M12%2019h13m-4-4%204%204-4%204%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%3C%2Fsvg%3E%0A") center / contain no-repeat; }
      .t { flex: 1; min-width: 0; }
      .t b { display: block; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t small { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icon { border: 0; background: transparent; color: var(--muted); width: 28px; height: 28px; border-radius: 8px;
        font-size: 18px; line-height: 1; cursor: pointer; display: grid; place-items: center; padding: 0; }
      .icon:hover { background: var(--soft); color: var(--fg); }
      .hero { padding: 0 14px 12px; }
      .hero strong { display: block; font-size: 15px; }
      .bar { height: 6px; border-radius: 99px; background: var(--soft); margin: 8px 0 4px; overflow: hidden; }
      .bar i { display: block; height: 100%; border-radius: 99px; background: var(--accent); transition: width .3s; }
      .bar.full i { background: var(--good); }
      .meta { color: var(--muted); font-size: 12px; }
      .body { flex: 1 1 auto; overflow: auto; border-top: 1px solid var(--line); padding: 10px 12px 12px; }
      .steps { list-style: none; margin: 2px 0 6px; padding: 0; }
      .steps li { display: flex; gap: 10px; align-items: flex-start; padding: 6px 4px; }
      .dot { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line);
        display: grid; place-items: center; font-size: 11px; font-weight: 700; color: var(--muted); margin-top: 1px; }
      .steps li.done .dot { border-color: var(--good); background: var(--good); color: var(--bg); }
      .steps li.done .lbl { color: var(--muted); text-decoration: line-through; }
      .steps li.now .dot { border-color: var(--accent); color: var(--accent); }
      .steps li.now .lbl { font-weight: 600; }
      .lbl { flex: 1; }
      .steps .extra { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
      .sec { display: flex; align-items: center; gap: 6px; width: 100%; margin: 12px 0 6px; padding: 4px; border: 0;
        background: transparent; color: var(--muted); font: inherit; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: .05em; cursor: pointer; border-radius: 6px; }
      .sec:hover { color: var(--fg); }
      .sec .n { background: var(--soft); color: var(--fg); border-radius: 99px; padding: 0 7px; font-size: 11px; }
      .sec .chev { margin-left: auto; transition: transform .15s; }
      .sec.closed .chev { transform: rotate(-90deg); }
      .row { padding: 9px 10px; border-radius: 10px; background: var(--soft); margin-bottom: 6px;
        border-left: 3px solid transparent; }
      .row.todo { border-left-color: var(--bad); }
      .row.check { border-left-color: var(--warn); }
      .row.ok { border-left-color: var(--good); }
      .q { font-size: 12.5px; color: var(--muted); display: flex; gap: 6px; align-items: baseline; }
      .q span:first-child { flex: 1; }
      .v { margin-top: 2px; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; cursor: pointer; }
      .v.open { display: block; }
      .why { margin-top: 2px; color: var(--bad); font-size: 13px; }
      .chip { flex: none; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; background: var(--bg);
        color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
      .chip.check { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
      .chip.ai { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
      .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      button.b { font: inherit; font-size: 12.5px; border-radius: 8px; padding: 5px 10px; border: 1px solid var(--line);
        background: var(--bg); color: var(--fg); cursor: pointer; white-space: nowrap; }
      button.b:hover:not(:disabled) { background: var(--hover); }
      button.b:disabled { opacity: .6; cursor: default; }
      button.b.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      button.b.primary:hover { filter: brightness(1.08); background: var(--accent); }
      button.b:disabled { opacity: .45; cursor: not-allowed; filter: none; }
      button.b.ghost { border-color: transparent; background: transparent; color: var(--accent); padding: 5px 6px; }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .f { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); align-items: center; }
      .f .grow { flex: 1; }
      .alog { list-style: none; margin: 0; padding: 0; font-size: 13px; }
      .alog li { padding: 4px 0; border-bottom: 1px solid var(--line); color: var(--muted); }
      .alog li:last-child { color: var(--fg); }
      details > summary { cursor: pointer; color: var(--muted); font-size: 13px; margin: 2px 0 6px; }
      .ask { margin: 4px 0 10px; padding: 12px; border-radius: 10px; background: var(--accent-soft); }
      .ask textarea { width: 100%; box-sizing: border-box; margin: 8px 0; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
      .msg { margin: 4px 0 8px; padding: 12px; border-radius: 10px; }
      .msg.bad { background: var(--bad-soft); }
      .msg.bad b { color: var(--bad); }
      .msg.good { background: var(--good-soft); }
      .msg.good b { color: var(--good); }
      .msg p { margin: 4px 0 10px; }
      .busy { display: flex; gap: 10px; align-items: center; padding: 18px 14px; border-top: 1px solid var(--line); color: var(--muted); }
      .spin { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line);
        border-top-color: var(--accent); animation: spin .8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .toast { margin: 0 12px 10px; padding: 8px 10px; border-radius: 8px; background: var(--fg); color: var(--bg);
        font-size: 13px; animation: in .15s ease-out; }
      .empty { color: var(--muted); padding: 6px 4px; }
      .tabs { display: flex; gap: 4px; margin: 0 12px 10px; padding: 3px; border-radius: 10px; background: var(--soft); }
      .tabs button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; border: 0;
        border-radius: 8px; padding: 6px 8px; background: transparent; color: var(--muted); font: inherit;
        font-size: 13px; font-weight: 600; cursor: pointer; }
      .tabs button[aria-selected="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
      .tabs .n { background: var(--bad-soft); color: var(--bad); border-radius: 99px; padding: 0 7px; font-size: 11px; }
      .chat { display: flex; flex-direction: column; gap: 8px; min-height: 140px; }
      .bubble { max-width: 88%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
      .bubble.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
      .bubble.assistant { align-self: flex-start; background: var(--soft); border-bottom-left-radius: 4px; }
      .bubble .filled { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 6px; color: var(--muted); font-size: 12px; }
      .bubble .filled .chip { background: var(--good-soft); color: var(--good); border-color: transparent; }
      .bubble .warn { margin-top: 4px; color: var(--bad); font-size: 12px; }
      .quick { display: flex; flex-wrap: wrap; gap: 6px; }
      .quick button { font: inherit; font-size: 12.5px; border-radius: 99px; padding: 4px 11px; cursor: pointer;
        border: 1px solid var(--accent); color: var(--accent); background: var(--bg); }
      .quick button:hover:not(:disabled) { background: var(--accent-soft); }
      .quick button:disabled { opacity: .6; cursor: default; }
      .thinking { align-self: flex-start; display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 13px; }
      .thinking .spin { width: 14px; height: 14px; }
      .composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--line); }
      .composer textarea { flex: 1; min-height: 38px; max-height: 120px; resize: none; font: inherit; font-size: 13.5px;
        padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
      .composer textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
      .composer .hint { display: block; color: var(--muted); font-size: 11px; margin-top: 4px; }
      .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
        padding: 6px 14px 6px 6px; border-radius: 99px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
        box-shadow: 0 8px 24px rgba(0,0,0,.18); cursor: pointer; font: inherit; font-weight: 600; }
      .pill.enter { animation: in .15s ease-out; }
      .pill .mark { width: 26px; height: 26px; }
      .pill .badge { background: #dc2626; color: #fff; border-radius: 99px; padding: 0 7px; font-size: 12px; }
      .pill .badge.ok { background: #16a34a; }
    `;

    function el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "onclick") node.addEventListener("click", (e) => { e.stopPropagation(); v(e); });
        else if (k === "class") node.className = v;
        else if (k === "style") node.style.cssText = v;
        else node.setAttribute(k, v === true ? "" : v);
      }
      for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
      return node;
    }

    const btn = (label, onclick, cls = "", attrs = {}) => el("button", { class: `b ${cls}`, type: "button", onclick, ...attrs }, label);

    function ensure() {
      if (host?.isConnected) return;
      host = document.createElement("jobhunt-autofill-panel");
      root = host.attachShadow({ mode: "closed" });
      document.documentElement.append(host);
    }

    function focusField(field) {
      const target = outlineTarget(field);
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (field.kind === "text" || field.kind === "select") field.el.focus({ preventScroll: true });
      target.animate?.(
        [{ boxShadow: "0 0 0 0 rgba(79,70,229,.6)" }, { boxShadow: "0 0 0 14px rgba(79,70,229,0)" }],
        { duration: 900, iterations: 2, delay: 250 },
      );
    }

    function downloadResume() {
      if (!state?.resume) return;
      const url = URL.createObjectURL(state.resume);
      const a = el("a", { href: url, download: state.resume.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(`Saved ${state.resume.name}. Now click "Add file" on the form and pick it.`);
    }

    function toast(text) {
      view.toast = text;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { view.toast = null; render(); }, 5000);
      render();
    }

    function setMinimized(value) {
      if (value) view.countdown?.cancel(); // never submit from a panel the user can't see
      view.minimized = value;
      chrome.runtime.sendMessage({ type: "panelPreference", minimized: value }).catch(() => {});
      render();
    }

    function header(title, subtitle) {
      return el("div", { class: "h" },
        el("div", { class: "mark", "aria-hidden": "true" }),
        el("div", { class: "t" }, el("b", { title }, title), subtitle ? el("small", { title: subtitle }, subtitle) : null),
        el("button", { class: "icon", type: "button", title: "Minimise (Esc)", "aria-label": "Minimise", onclick: () => setMinimized(true) }, "–"),
        el("button", { class: "icon", type: "button", title: "Close", "aria-label": "Close", onclick: () => { view.countdown?.cancel(); host.remove(); } }, "×"),
      );
    }

    function chips(r) {
      const source = P.sourceLabel(r.source);
      return [
        source ? el("span", { class: `chip ${r.source === "generated" ? "ai" : ""}` }, source) : null,
        r.needsReview && !r.reviewed ? el("span", { class: "chip check" }, "Check") : null,
      ];
    }

    function valueLine(r) {
      if (!r.value) return null;
      const node = el("div", { class: `v ${view.expanded.has(r) ? "open" : ""}`, title: "Click to expand" }, r.value);
      node.addEventListener("click", () => {
        view.expanded.has(r) ? view.expanded.delete(r) : view.expanded.add(r);
        render();
      });
      return node;
    }

    function todoRow(r) {
      const k = r.field.kind;
      return el("div", { class: "row todo" },
        el("div", { class: "q" }, el("span", {}, r.field.label || "(question without a label)")),
        el("div", { class: "why" }, r.reason),
        el("div", { class: "acts" },
          btn("Go to field →", () => focusField(r.field), "primary"),
          k === "text" ? btn(r.drafting ? "Drafting…" : "✨ Draft with AI", () => draftOne(r), "", { disabled: r.drafting, title: "Uses AI credits" }) : null,
          r.suggestion ? btn("Copy answer", () => {
            navigator.clipboard.writeText(r.suggestion).then(() => toast("Answer copied"), () => toast(r.suggestion));
          }) : null,
          k === "picker" && state.resume ? btn("⬇ Download CV", downloadResume) : null,
          ["checkbox", "picker", "dropdown", "file"].includes(k)
            ? btn("✓ Done", () => { Object.assign(r, { status: "done", manual: true }); outline(); render(); }, "ghost")
            : null,
        ),
      );
    }

    function checkRow(r) {
      return el("div", { class: "row check" },
        el("div", { class: "q" }, el("span", {}, r.field.label), ...chips(r)),
        valueLine(r),
        el("div", { class: "acts" },
          btn("Go to field →", () => focusField(r.field)),
          btn("✓ Looks good", () => { r.reviewed = true; outline(); render(); }, "ghost"),
        ),
      );
    }

    function optionalRow(r) {
      return el("div", { class: "row" },
        el("div", { class: "q" }, el("span", {}, r.field.label || "(question without a label)"), el("span", { class: "chip" }, "Optional")),
        el("div", { class: "acts" },
          btn("Go to field →", () => focusField(r.field)),
          r.field.kind === "text" ? btn(r.drafting ? "Drafting…" : "✨ Draft with AI", () => draftOne(r), "", { disabled: r.drafting, title: "Uses AI credits" }) : null,
        ),
      );
    }

    function okRow(r) {
      const node = el("div", { class: "row ok", style: "cursor:pointer", title: "Show on the page" },
        el("div", { class: "q" }, el("span", {}, r.field.label || "(question without a label)"), ...chips(r)),
        valueLine(r),
      );
      node.addEventListener("click", () => focusField(r.field));
      return node;
    }

    function section(key, label, rows, make) {
      if (!rows.length) return null;
      const open = view.open[key];
      return [
        el("button", {
          class: `sec ${open ? "" : "closed"}`, type: "button", "aria-expanded": String(open),
          onclick: () => { view.open[key] = !open; render(); },
        }, label, el("span", { class: "n" }, String(rows.length)), el("span", { class: "chev" }, "▾")),
        open ? rows.map(make) : null,
      ];
    }

    function stepsList(summary, results) {
      const firstOpen = summary.steps.find((s) => s.remaining > 0)?.id;
      const hasUploadTodo = results.some((r) => r.status === "unresolved" && (r.field.kind === "picker" || r.field.kind === "file"));
      return el("ol", { class: "steps", "aria-label": "Next steps" },
        summary.steps.map((s, i) => {
          const done = s.remaining === 0;
          let extra = null;
          if (s.id === "upload" && hasUploadTodo && state.resume) {
            extra = el("div", { class: "extra" }, btn("⬇ Download CV", downloadResume), el("span", { class: "meta" }, "then Add file on the form"));
          }
          if (s.id === "submit" && !done && state.appId != null) {
            extra = el("div", { class: "extra" },
              view.confirmSubmit
                ? [
                    el("span", { class: "meta" }, "Did you submit it?"),
                    btn("Yes, I submitted it", () => { view.confirmSubmit = false; void markSubmitted("marked from the extension panel"); }, "primary"),
                    btn("Not yet", () => { view.confirmSubmit = false; render(); }, "ghost"),
                  ]
                : btn("I already submitted it", () => { view.confirmSubmit = true; render(); }, "ghost"),
            );
          }
          return el("li", { class: done ? "done" : s.id === firstOpen ? "now" : "" },
            el("span", { class: "dot", "aria-hidden": "true" }, done ? "✓" : String(i + 1)),
            el("div", { class: "lbl" }, s.label, extra),
          );
        }),
      );
    }

    const AGENT_HEADLINE = {
      starting: "Starting the agent…",
      running: "Working through the form…",
      waiting: "Needs you",
      paused: "Paused",
      ready: "Ready for your review",
      failed: "The agent stopped",
      stopped: "Stopped",
    };

    function agentQuestion(q) {
      if (q.kind === "question") {
        const input = el("textarea", { rows: "2", "aria-label": "Your answer", placeholder: "Your answer" });
        input.value = view.agentDraft;
        input.addEventListener("input", () => { view.agentDraft = input.value; });
        input.addEventListener("keydown", (e) => {
          e.stopPropagation(); // keep the job site's shortcuts out of the answer box
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void agentControl("reply", input.value); }
        });
        queueMicrotask(() => input.focus({ preventScroll: true }));
        return el("div", { class: "ask", role: "alert" },
          el("b", {}, q.text), input,
          el("div", { class: "acts" },
            btn("Answer", () => void agentControl("reply", input.value), "primary"),
            btn("I'll fill it on the page", () => void agentControl("skip"), "ghost")));
      }
      return el("div", { class: "ask", role: "alert" },
        el("b", {}, q.kind === "blocker" ? "Your turn on the page" : "One click from you"),
        el("p", {}, q.text),
        btn("Continue", () => void agentControl("resume"), "primary"));
    }

    const AGENT_LIVE = ["starting", "running", "waiting", "paused"];
    const agentLive = () => Boolean(agent && AGENT_LIVE.includes(agent.status));
    const AGENT_TITLE = "Works through the whole form in this tab, step by step, and asks you when it needs something. It never submits. Chrome shows a \"started debugging\" bar while it works.";

    function agentHero() {
      return el("div", { class: "hero" },
        el("strong", {}, AGENT_HEADLINE[agent.status] ?? agent.status),
        el("div", { class: "meta" }, agentLive() ? "The agent is filling this form. You still submit." : "Ask me below to change anything, then submit."));
    }

    /** The agent's question, result and step log; finished runs fold the log away under the chat. */
    function agentDetails() {
      const nodes = [];
      if (agent.status === "waiting" && agent.question) nodes.push(agentQuestion(agent.question));
      if (agent.status === "ready") {
        nodes.push(el("div", { class: "msg good" }, el("b", {}, "Review the form, then submit it yourself"),
          el("p", {}, agent.unresolved?.length ? `Still open: ${agent.unresolved.join("; ")}` : "Every question I could find has an answer. Check the ones marked for review.")));
      }
      if (agent.status === "failed" && agent.message) nodes.push(el("div", { class: "msg bad", role: "alert" }, el("b", {}, "Stopped"), el("p", {}, agent.message)));
      const log = el("ul", { class: "alog", "aria-live": "polite" });
      for (const line of (agent.log ?? []).slice(-14)) log.append(el("li", {}, line));
      nodes.push(agentLive() ? log : el("details", {}, el("summary", {}, "What the agent did"), log));
      const review = (agent.filled ?? []).filter((f) => f.needs_review);
      if (review.length) {
        nodes.push(el("div", { class: "filled" }, "Double-check:", review.map((f) => el("span", { class: "chip", title: `${f.label}: ${f.value}` }, f.label.length > 40 ? `${f.label.slice(0, 40)}…` : f.label))));
      }
      return nodes;
    }

    const agentButton = (kind = "") => btn(agent ? "Run the agent again" : "Fill with the agent", () => void startAgent(), kind, { title: AGENT_TITLE });

    function agentFooter() {
      if (!agentLive()) return el("div", { class: "f" }, el("span", { class: "grow" }), agentButton("primary"));
      return el("div", { class: "f" },
        agent.status === "paused"
          ? btn("Resume", () => void agentControl("resume"), "primary")
          : btn("Pause", () => void agentControl("pause"), ""),
        el("span", { class: "grow" }),
        btn("Stop and take over", () => void agentControl("stop"), "ghost"));
    }

    function tabsBar(summary) {
      const tab = (id, label, badge) => el("button", {
        type: "button", role: "tab", "aria-selected": String(view.tab === id),
        onclick: () => { view.tab = id; render(); },
      }, label, badge ? el("span", { class: "n", "aria-label": `${badge} to do` }, String(badge)) : null);
      return el("div", { class: "tabs", role: "tablist", "aria-label": "ApplyShortly panel" },
        tab("assistant", "Assistant"),
        tab("form", "Form", summary.todo),
      );
    }

    function chatView(results) {
      const lines = chat.lines.length ? chat.lines : [{ role: "assistant", greeting: true, ...P.assistantGreeting(results) }];
      const log = el("div", { class: "chat", "aria-live": "polite" });
      lines.forEach((line, i) => {
        log.append(el("div", { class: `bubble ${line.role}` },
          line.text,
          line.filled?.length ? el("div", { class: "filled" }, "Filled:", line.filled.map((f) => el("span", { class: "chip", title: f }, f.length > 40 ? `${f.slice(0, 40)}…` : f))) : null,
          line.warnings?.map((w) => el("div", { class: "warn" }, w)),
        ));
        if (i === lines.length - 1 && line.role === "assistant" && line.choices?.length) {
          log.append(el("div", { class: "quick", role: "group", "aria-label": "Quick replies" },
            line.choices.map((c) => el("button", { type: "button", disabled: chat.pending, onclick: () => void askAssistant(c) }, c))));
        }
      });
      if (chat.pending) log.append(el("div", { class: "thinking", role: "status" }, el("span", { class: "spin" }), "Thinking…"));
      return log;
    }

    function composer() {
      const input = el("textarea", {
        class: "composer-input", rows: "1", "aria-label": "Message the assistant",
        placeholder: "Type your answer, or ask to change one…",
      });
      input.value = chat.draft;
      const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
      input.addEventListener("input", () => { chat.draft = input.value; grow(); });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // keep the job site's own shortcuts out of the chat box
        if (e.key === "Escape") setMinimized(true);
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void askAssistant(input.value); }
      });
      queueMicrotask(grow);
      return el("div", { class: "composer" },
        el("div", { style: "flex:1;display:flex;flex-direction:column" }, input,
          el("small", { class: "hint" }, "Fills the form for you to review. Uses AI credits.")),
        btn("Send", () => void askAssistant(input.value), "primary", { disabled: chat.pending, "aria-label": "Send" }),
      );
    }

    // The stylesheet stays in place between renders; only the content is swapped, so nothing
    // restyles or flashes when the user changes tabs.
    const styleEl = el("style", {}, css);
    function mount(wrap) {
      if (!root.contains(styleEl)) root.replaceChildren(styleEl);
      const old = root.querySelector(".wrap");
      if (old) old.replaceWith(wrap);
      else root.append(wrap);
    }

    function render() {
      ensure();
      // Re-rendering replaces the panel; keep the chat box focused while the user is typing.
      const typing = root.activeElement?.classList?.contains("composer-input") ? root.activeElement.selectionStart : null;
      const prevScroll = root.querySelector(".body")?.scrollTop ?? 0;
      const app = state?.ctx?.app;
      const results = state?.results ?? [];
      const summary = P.summarize(results, { submitted: submittedReported });
      const title = app?.title || document.title || "ApplyShortly autofill";
      const subtitle = [app?.company_name, state && state.appId == null ? "Not tracked in ApplyShortly" : null]
        .filter(Boolean).join(" · ");

      const wrap = el("div", { class: "wrap" });

      if (view.minimized) {
        const badge = submittedReported ? "Submitted ✓" : summary.todo ? `${summary.todo} to do` : "All set";
        wrap.append(el("button", {
          class: root.querySelector(".pill") ? "pill" : "pill enter", type: "button", title: "Open ApplyShortly autofill",
          onclick: () => setMinimized(false),
        }, el("span", { class: "mark", "aria-hidden": "true" }), "ApplyShortly",
          view.busy ? el("span", { class: "spin" }) : el("span", { class: `badge ${summary.todo ? "" : "ok"}` }, badge)));
        mount(wrap);
        return;
      }

      // Slide in only when the panel appears, not on every re-render (tab switches, typing).
      const entering = !root.querySelector(".p");
      const p = el("div", { class: entering ? "p enter" : "p", role: "dialog", "aria-label": "ApplyShortly autofill" });
      p.addEventListener("keydown", (e) => { if (e.key === "Escape") setMinimized(true); });
      p.append(header(title, subtitle));

      if (view.busy) {
        p.append(el("div", { class: "busy", role: "status" }, el("span", { class: "spin" }), view.busy));
      } else if (view.error) {
        const e = view.error;
        const retry = (kind) => btn("Try again", () => { view.error = null; void run(state?.appId ?? retryAppId); }, kind);
        const action = {
          settings: btn("Open settings", () => void send({ type: "openOptions" }), "primary"),
          reload: btn("Reload page", () => location.reload(), "primary"),
          retry: retry("primary"),
          profile: el("div", { class: "acts" }, btn("Set up profile", () => void send({ type: "openProfile" }).catch(() => {}), "primary"), retry("")),
        }[e.action];
        p.append(el("div", { class: "body" },
          el("div", { class: "msg bad", role: "alert" }, el("b", {}, e.title), el("p", {}, e.detail), action)));
      } else if (agent && !state?.ctx) {
        // Started from the popup before anything was filled: the agent's progress on its own.
        p.append(agentHero(), el("div", { class: "body" }, ...agentDetails()), agentFooter());
      } else if (state?.ctx || submittedReported) {
        if (!submittedReported) view.tab ??= agent || P.assistantFirst(results) ? "assistant" : "form";
        const assistant = !submittedReported && view.tab === "assistant";
        const withAgent = assistant && Boolean(agent);
        const working = withAgent && agentLive();
        const full = submittedReported || summary.progress >= 1;
        if (withAgent) p.append(agentHero());
        else p.append(el("div", { class: "hero" },
          el("strong", {}, summary.headline),
          el("div", { class: `bar ${full ? "full" : ""}`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(summary.total), "aria-valuenow": String(summary.answered) },
            el("i", { style: `width:${full ? 100 : Math.round(summary.progress * 100)}%` })),
          el("div", { class: "meta" }, submittedReported ? "Tracked in ApplyShortly" : summary.total ? `${summary.answered} of ${summary.total} answered` : "Try again once the form has loaded"),
        ));

        if (!submittedReported) p.append(tabsBar(summary));
        const body = el("div", { class: "body" });
        if (assistant) {
          if (withAgent) body.append(...agentDetails());
          if (!working) body.append(chatView(results));
        } else if (submittedReported) {
          body.append(el("div", { class: "msg good" },
            el("b", {}, "Saved in ApplyShortly"),
            el("p", {}, state.appId != null ? "This application is now marked Submitted. Good luck!" : "Done."),
            state.ctx?.baseUrl ? btn("Open ApplyShortly", () => window.open(`${state.ctx.baseUrl}/apply-queue`, "_blank"), "primary") : null,
          ));
        } else {
          body.append(stepsList(summary, results));
          const todo = results.filter((r) => r.status === "unresolved");
          const check = results.filter((r) => r.status === "filled" && r.needsReview && !r.reviewed);
          const optional = results.filter((r) => r.status === "optional");
          const ok = results.filter((r) => !todo.includes(r) && !check.includes(r) && !optional.includes(r));
          if (!results.length) body.append(el("div", { class: "empty" }, "No form fields found yet. If the form is still loading, click Fill again."));
          body.append(
            el("div", {}, section("todo", "Needs you", todo, todoRow)),
            el("div", {}, section("check", "Double-check", check, checkRow)),
            el("div", {}, section("optional", "Optional", optional, optionalRow)),
            el("div", {}, section("filled", "Filled", ok, okRow)),
          );
        }
        p.append(body);
        const newLines = working || (assistant && chat.lines.length + Number(chat.pending) !== view.chatSeen);
        if (assistant) view.chatSeen = chat.lines.length + Number(chat.pending);
        queueMicrotask(() => { body.scrollTop = newLines ? body.scrollHeight : prevScroll; });

        if (view.toast) p.append(el("div", { class: "toast", role: "status" }, view.toast));

        // Submit is on both tabs (not while the agent is working). It runs the guarded flow: refuses and says why unless every required
        // answer is in, then clicks the form's own Submit after a countdown the user can cancel.
        const submit = () => {
          const blockers = P.autoApplyBlockers(results, state.ctx.app);
          // Enabled only when every required answer is in; the tooltip says what's missing.
          return btn("Submit", () => void autoApply(), "primary", {
            disabled: blockers.length > 0,
            title: blockers.length
              ? `Not ready: ${blockers.join(". ")}.`
              : `Clicks the form's Submit button for you after a ${AUTO_APPLY_DELAY_S}-second countdown.`,
          });
        };
        const countdown = () => el("div", { class: "f", role: "alert" },
          el("span", { class: "grow" }, `Submitting in ${view.countdown.left}s…`),
          btn("Cancel", view.countdown.cancel, "primary"),
        );
        if (working) {
          p.append(agentFooter());
        } else if (assistant) {
          if (view.countdown) p.append(countdown());
          p.append(composer());
          if (!view.countdown && !submittedReported) p.append(el("div", { class: "f" }, agentButton(), el("span", { class: "grow" }), submit()));
        } else if (view.countdown) {
          p.append(countdown());
        } else if (!submittedReported) {
          const draftable = results.filter((r) => r.status === "unresolved" && r.field.kind === "text").length;
          p.append(el("div", { class: "f" },
            btn("↻ Fill again", () => run(state.appId, { allowGenerate: false }), "", { title: "Fill fields that are still empty. Your edits are kept." }),
            el("span", { class: "grow" }),
            draftable ? btn(`✨ Draft ${draftable} with AI`, () => run(state.appId, { allowGenerate: true }), "primary", { title: "Uses AI credits. Drafts are marked Check." }) : null,
            submit(),
          ));
        }
      }

      wrap.append(p);
      mount(wrap);
      if (typing !== null) {
        const input = root.querySelector(".composer-input");
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(typing, typing);
      }
    }

    let retryAppId = null;
    return {
      render,
      toast,
      busy(text) { Object.assign(view, { busy: text, error: null }); render(); },
      idle() { view.busy = null; render(); },
      fail(err) {
        view.busy = null;
        view.error = P.friendlyError(err.message, err.status, state?.ctx?.baseUrl, err.code);
        render();
      },
      setRetry(appId) { retryAppId = appId; },
      /** Shows the agent's latest update on the Assistant tab. */
      agent(show) {
        if (show) Object.assign(view, { tab: "assistant", minimized: false, busy: null, error: null });
        render();
      },
      clearAgentDraft() { view.agentDraft = ""; },
      /** Shows the Form tab with a message, e.g. why Auto apply didn't submit. */
      stop(text) {
        Object.assign(view, { tab: "form", minimized: false });
        toast(text);
      },
      /** Counts down before Auto apply submits; resolves false if the user cancels. */
      countdown(seconds) {
        return new Promise((resolve) => {
          const c = { left: seconds };
          const finish = (go) => {
            if (view.countdown !== c) return;
            clearInterval(c.timer);
            view.countdown = null;
            render();
            resolve(go);
          };
          c.cancel = () => finish(false);
          c.timer = setInterval(() => (--c.left <= 0 ? finish(true) : render()), 1000);
          Object.assign(view, { countdown: c, tab: "form", minimized: false });
          render();
        });
      },
      focus: focusField,
      async restore({ show = false } = {}) {
        if (show) view.minimized = false;
        else view.minimized = Boolean((await chrome.runtime.sendMessage({ type: "panelPreference" }).catch(() => ({}))).data);
      },
    };
  })();

  // ------------------------------------------------------------------ lifecycle

  // A native form submit (the user clicked the site's submit button). Pages that submit with
  // fetch instead are covered by the confirmation-page check or the panel's "I already submitted".
  document.addEventListener(
    "submit",
    () => {
      if (!autoSubmitting && state?.appId != null && state.results.length) void report("submission_attempted", { note: "form submit event; confirmation not yet detected" });
    },
    true,
  );

  async function startAgent() {
    try {
      agent = await send({ type: "agentStart", appId: state?.appId ?? null }).then(() => ({ status: "starting", log: [] }));
      panel.agent(true);
    } catch (err) {
      panel.fail(err);
    }
  }

  async function agentControl(action, text) {
    if (action === "reply" && !String(text ?? "").trim()) return;
    try {
      await send({ type: "agentControl", action, text });
      if (action === "reply" || action === "skip") panel.clearAgentDraft();
    } catch (err) {
      panel.toast(err.message);
    }
  }

  async function start(appId, opts = {}) {
    panel.setRetry(appId);
    await panel.restore(opts);
    if ((await run(appId)) && opts.autoSubmit) await autoApply();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === "agentUpdate") {
      const first = !agent;
      agent = msg;
      panel.agent(first || msg.status === "waiting" || msg.status === "ready" || msg.status === "failed");
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "run") {
      // Same application: keep what's been filled and answered; another one starts over.
      if (state && state.appId !== (msg.appId ?? null)) { state = null; chat = newChat(); }
      void start(msg.appId ?? null, { show: true, autoSubmit: msg.autoSubmit === true });
      sendResponse({ ok: true });
    }
  });

  async function boot() {
    let hello;
    try {
      hello = await send({ type: "hello", url: location.href });
    } catch {
      return; // extension reloaded or not configured; stay quiet on unrelated pages
    }
    if (hello.mode === "idle") return;
    if (hello.mode === "agent") {
      // A new page of a form the agent is filling: show its progress, don't autofill over it.
      agent = await send({ type: "agentStatus" }).catch(() => null);
      if (agent) await panel.restore({ show: true }).then(() => panel.agent(true));
      return;
    }
    if (hello.mode === "continue") {
      if (F.looksSubmitted(document, location.href)) {
        state = { appId: hello.appId, ctx: null, results: [] };
        await markSubmitted("confirmation page");
        return;
      }
      const empty = F.collectFields(document).filter((f) => ["text", "select", "radio"].includes(f.kind) && F.isEmpty(f));
      if (!empty.length) return;
    }
    // Pages often render their form after load (Google Forms, Workday): give them a moment.
    await new Promise((r) => setTimeout(r, 800));
    await start(hello.appId);
  }

  // The ApplyShortly website marks whether it is signed in, so the extension can follow it.
  // The background accepts this only from the ApplyShortly origin.
  let sessionMark;
  function followWebsiteSession() {
    const mark = document.documentElement.dataset.applyshortlySession;
    if (!mark || mark === sessionMark) return;
    sessionMark = mark;
    send({ type: "webSession", signedIn: mark === "signed-in" }).catch(() => {});
  }
  new MutationObserver(followWebsiteSession).observe(document.documentElement, { attributes: true, attributeFilter: ["data-applyshortly-session"] });
  followWebsiteSession();

  void boot();
})();
