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
  // The assistant's conversation for this page; reset with `state`.
  const newChat = () => ({ lines: [], draft: "", pending: false });
  let chat = newChat();
  // The form agent's latest update for this tab (it runs in the background; see agent/loop.js).
  let agent = null;

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) {
          /** @type {Error & {status?: number, code?: string}} */
          const err = new Error(res?.error ?? "No response from the extension");
          err.status = res?.status;
          err.code = res?.code;
          return reject(err);
        }
        resolve(res.data);
      });
    });
  }

  /** @param {string} event @param {{note?: string, [key: string]: unknown}} [extra] */
  function report(event, extra = {}) {
    if (state?.appId == null) return Promise.resolve(null);
    // The API caps url at 2000 and note at 1000 characters.
    /** @type {Record<string, unknown>} */
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

  /** The job as this page shows it, so an AI draft on an untracked page knows what it answers for. */
  function pageJob() {
    const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
    const text = document.body?.innerText ?? document.body?.textContent ?? "";
    return {
      title: (document.title.trim() || meta("og:title") || F.cleanLabel(document.querySelector("h1")?.textContent ?? "")).slice(0, 300),
      company: meta("og:site_name").slice(0, 200),
      description: text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 6000),
    };
  }

  /** Asks the server for an answer; an AI draft for an untracked page carries the page's job. */
  const suggest = (question, appId, allowGenerate) =>
    send({ type: "suggest", question, appId, allowGenerate, page: allowGenerate && appId == null ? pageJob() : undefined });

  /** Why the last AI draft failed (no credits, a rejected key, …), for the chat to say. @type {string | null} */
  let draftError = null;

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
        const s = await suggest(question, state.appId, generate);
        if (s.answer) return { value: s.answer, source: s.source, needsReview: s.needs_review };
      } catch (err) {
        console.warn("[JobHunt] suggest failed:", err.message);
        if (generate) draftError = err.message;
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

  const NEXT_TEXT = /^(next|continue|save (and|&) continue|proceed)\b/i;

  /** What the page looks like after filling: whether it needs clicking through (see navigationNeeded). */
  function pageShape() {
    const fields = F.collectFields(document);
    const label = (b) => F.cleanLabel(b.getAttribute("aria-label") || (b.tagName === "INPUT" ? b.value : b.textContent));
    const hasNext = [...document.querySelectorAll('button, input[type=submit], [role="button"]')]
      .some((b) => b.getClientRects().length > 0 && !b.matches(":disabled") && NEXT_TEXT.test(label(b)));
    const bigFrame = [...document.querySelectorAll("iframe")].some((f) => {
      const r = f.getBoundingClientRect();
      return r.width >= 300 && r.height >= 300;
    });
    return { total: fields.length, hasSubmit: Boolean(F.findSubmitButton(document, fields)), hasNext, bigFrame };
  }

  const greeting = () => P.assistantGreeting(state.results);

  /**
   * Fills the page from the profile and answer bank. `quiet` re-reads a page the agent already
   * filled, without reporting it again (the agent reported its own fill).
   * @param {number | null} appId @param {{allowGenerate?: boolean, quiet?: boolean}} [opts]
   */
  async function run(appId, { allowGenerate, quiet = false } = {}) {
    try {
      if (!state || state.appId !== appId) {
        panel.busy("Loading your profile…");
        const [ctx, resume] = await Promise.all([send({ type: "context", appId }), loadResume()]);
        if (state) chat = newChat(); // another application; a fresh page keeps what the agent said
        state = { appId, ctx, resume, results: [] };
        if (!quiet) await report("opened");
      }
      const generate = allowGenerate ?? state.ctx.aiDrafts;
      panel.busy(generate ? "Drafting answers with AI… this can take a few seconds" : "Matching your answers to the form…");
      state.results = merge(state.results, await fillAll({ allowGenerate: generate }));
      outline();
      if (!quiet) await reportFilled();
      panel.idle();
      return true;
    } catch (err) {
      panel.fail(err);
      await report("failed", { note: err.message });
      return false;
    }
  }

  // ------------------------------------------------------------------ assistant

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
    draftError = null;
    const answer = await resolveAnswer(row.field, true);
    const next = answer ? await applyAnswer(row.field, answer) : null;
    if (next?.status !== "filled") {
      const why = draftError ? ` (${draftError.replace(/\.$/, "")})` : "";
      return { text: `I couldn't draft this one${why}. Tell me what you'd like to say and I'll put it in.`, target: row };
    }
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
    if (P.isDraftRequest(message) && ["optional", "unresolved"].includes(row.status)) {
      if (P.draftable(row.field)) return assistantDraft(row);
      if (row.field.options?.length) return { text: "Pick one of the options, or tell me which one fits.", choices: row.field.options.map((o) => o.text).filter(Boolean).slice(0, 8), target: row };
      return { text: `That's a detail only you know, so I won't draft it. Tell me what to put${row.status === "optional" ? ", or leave it blank" : ""}.`, target: row };
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

  /** A plain answer to the question the chat just asked: written into the form, no AI call. */
  async function directReply(row, value) {
    const filled = await applyAssistantUpdates({ answer: value }, { answer: row });
    return filled.length ? { text: "Got it.", filled, next: true } : { text: `The form didn't take “${value}”. Please set it on the page.` };
  }

  /** The reply line, followed by whatever the chat should bring up next. */
  /** A lead line followed by the next thing to ask (its question card and quick replies). */
  const followedBy = (lead, next) =>
    ({ text: `${lead} ${next ? next.text : DONE_TEXT}`, question: next?.question, choices: next?.choices ?? [], target: next?.target });

  function withNext(reply) {
    if (!reply.next) return reply;
    return { ...reply, ...followedBy(reply.text, P.nextPrompt(state.results)) };
  }

  // ------------------------------------------------------------------ driving the tab

  const AGENT_LIVE = ["starting", "running", "waiting", "paused"];
  const agentLive = () => Boolean(agent && AGENT_LIVE.includes(agent.status));
  let handedOff = false; // the chat started driving this page once; it doesn't restart on its own

  /** The chat carries on by clicking through the form (the form agent, in this tab). */
  async function handOff(reason, { autoSubmit = false } = {}) {
    handedOff = true;
    chat.lines.push({ role: "assistant", local: true, text: P.handoffText(reason, { autoSubmit }) });
    panel.idle();
    await startAgent();
  }

  /** The user's reply while the agent waits: an answer, a draft request, or "done on the page". */
  async function replyToAgent(message) {
    const q = agent.question;
    chat.lines.push({ role: "user", text: message });
    chat.draft = "";
    if (q?.kind !== "question") {
      await agentControl("resume");
      return panel.idle();
    }
    if (message === P.ON_PAGE_REPLY) {
      chat.lines.push({ role: "assistant", local: true, text: "OK, fill it on the page. I'll carry on." });
      await agentControl("skip");
      return panel.idle();
    }
    if (!P.isDraftRequest(message)) {
      await agentControl("reply", message);
      return panel.idle();
    }
    // "Draft it for me": draft from the profile and the job, then give the agent the draft.
    chat.pending = true;
    panel.idle();
    try {
      const s = P.draftable({ kind: "text", label: q.text })
        ? await suggest(q.text, state?.appId ?? agent.appId ?? null, true).catch(() => null)
        : null;
      if (s?.answer) {
        chat.lines.push({ role: "assistant", local: true, text: `Here's a draft, going into the form now: “${s.answer}” Tell me if you want it changed.` });
        await agentControl("reply", s.answer);
      } else {
        chat.lines.push({ role: "assistant", local: true, text: q.choices?.length ? "Pick one of the options, or tell me which one fits." : "That's one only you can answer. Tell me what to put.", choices: P.agentAsk(q)?.choices.filter((c) => c !== P.DRAFT_REPLY) });
      }
    } finally {
      chat.pending = false;
      panel.idle();
    }
  }

  /** Brings the agent's progress into the chat: its questions, and what happened when it stopped. */
  async function agentChanged(previous, next) {
    const key = (a) => (a?.status === "waiting" ? `waiting:${a.question?.kind}:${a.question?.text}` : a?.status);
    if (key(previous) === key(next)) return panel.agent(false);
    if (next.status === "waiting") {
      const ask = P.agentAsk(next.question);
      if (ask) chat.lines.push({ role: "assistant", local: true, ...ask });
      return panel.agent(true);
    }
    if (!["ready", "failed", "stopped"].includes(next.status)) return panel.agent(previous == null);
    // Done driving: read the page as it is now, so the chat can follow up and Submit knows the state.
    const lead = next.status === "ready" ? "I've been through the form." : `${next.message ?? "I stopped."} You can finish it on the page, or ask me to change an answer.`;
    await run(state?.appId ?? next.appId ?? null, { quiet: true });
    const follow = next.status === "ready" && state ? P.nextPrompt(state.results) : null;
    chat.lines.push({ role: "assistant", local: true, ...(next.status === "ready" ? followedBy(lead, follow) : { text: lead, choices: [] }) });
    panel.agent(true);
  }

  /** One chat turn. Like the web app's review assistant: it fills fields, the user submits. */
  async function askAssistant(text) {
    const message = text.trim();
    if (!message || chat.pending) return;
    if (agent?.status === "waiting") return replyToAgent(message);
    if (agentLive() || !state?.ctx) return; // it's clicking through the form; the box is off meanwhile
    if (P.isNavigateRequest(message)) {
      chat.lines.push({ role: "user", text: message });
      chat.draft = "";
      return handOff("asked");
    }
    // The question the chat asked last; a plain answer to it is filled here, for free.
    const asked = ([...chat.lines].reverse().find((l) => l.role === "assistant") ?? greeting()).target;
    // A draft request drafts the question just asked, required or optional.
    const target = P.isDraftRequest(message) ? asked ?? P.promptTarget(state.results) : P.LOCAL_REPLIES.includes(message) ? P.promptTarget(state.results) : null;
    const answer = target ? null : P.directAnswer(asked, message);
    if (target || answer != null) {
      const turn = chat;
      if (!turn.lines.length) turn.lines.push({ role: "assistant", greeting: true, ...greeting() });
      turn.lines.push({ role: "user", text: message });
      turn.draft = "";
      turn.pending = true;
      panel.idle();
      try {
        const reply = target ? await localReply(message, target) : await directReply(asked, answer);
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
    if (!turn.lines.length) turn.lines.push({ role: "assistant", greeting: true, ...greeting() });
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
        if (e.target instanceof Element && e.target.tagName === "JOBHUNT-AUTOFILL-PANEL") return;
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

  const UPLOAD_WAIT_MS = 5000; // a file uploader fills its hidden field once the upload is done
  const isHidden = (el) => el.getClientRects().length === 0;
  const invalidControls = (form) => [...form.querySelectorAll("input:invalid, select:invalid, textarea:invalid")];

  /**
   * Whether the browser accepts the form; otherwise says which field and why, in words. Fields the
   * user can't see (an uploader's "resume.fileName") are named rather than pointed at: the browser
   * can't focus them, and a file upload the site never registered goes back on the user's list.
   */
  async function formAccepted(form) {
    for (let waited = 0; !form.checkValidity() && waited < UPLOAD_WAIT_MS && invalidControls(form).every(isHidden); waited += 500) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (form.checkValidity()) return true;
    const bad = invalidControls(form);
    const shown = bad.find((el) => !isHidden(el));
    if (shown) {
      shown.reportValidity(); // a field the user can see: the browser points at it
      const why = shown.validationMessage ? `: ${shown.validationMessage}` : "";
      panel.stop(`Not submitted: the form doesn't accept “${F.labelOf(shown) || "a field"}” yet${why}.`);
      return false;
    }
    const upload = state.results.find((r) => r.field.kind === "file" && r.status === "filled");
    if (upload && bad.some((el) => /resume|cv|file|upload|attach|document/i.test(`${el.name} ${el.id}`))) {
      Object.assign(upload, { status: "unresolved", reason: "The site didn't take the file. Attach it again on the page and wait for the upload to finish" });
      outline();
      panel.stop(`Not submitted: the site hasn't registered your file for “${upload.field.label}”. Attach it again on the page, wait for it to finish uploading, then try again.`);
      return false;
    }
    const names = bad.map((el) => F.labelOf(el) || el.name).filter(Boolean);
    panel.stop(`Not submitted: the site still rejects a field you can't see${names.length ? ` (${names.join(", ")})` : ""}. Check the form on the page, then try again.`);
    return false;
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
    if (form && !(await formAccepted(form))) return;
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

  // ------------------------------------------------------------------ panel (panel-view.js)

  // What the panel (panel-view.js) reads and calls. It reads state through these getters and
  // changes it only through the actions.
  const ctl = {
    get state() { return state; },
    get agent() { return agent; },
    get chat() { return chat; },
    get submittedReported() { return submittedReported; },
    AUTO_APPLY_DELAY_S,
    agentControl, askAssistant, autoApply, markSubmitted, outlineTarget, run, send,
  };
  const panel = globalThis.JobHuntPanelView.create(ctl);

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
    agent = { status: "starting", log: [], appId: state?.appId ?? null };
    panel.agent(true);
    try {
      await send({ type: "agentStart", appId: state?.appId ?? null });
    } catch (err) {
      agent = null;
      const e = P.friendlyError(err.message, err.status, state?.ctx?.baseUrl, err.code);
      chat.lines.push({ role: "assistant", local: true, error: true, text: `I couldn't click through this form: ${e.detail || e.title} You can finish it on the page; I'll keep helping here.` });
      panel.agent(true);
    }
  }

  async function agentControl(action, text) {
    if (action === "reply" && !String(text ?? "").trim()) return;
    try {
      await send({ type: "agentControl", action, text });
    } catch (err) {
      panel.toast(err.message);
    }
  }

  /** Drafts every open question with AI (the switch was just turned on), then says what it did. */
  async function draftOpen() {
    const before = new Set(state.results.filter((r) => r.status === "filled").map((r) => r.field.el));
    if (!(await run(state.appId, { allowGenerate: true }))) return;
    const drafted = state.results.filter((r) => r.status === "filled" && !before.has(r.field.el)).map((r) => r.field.label || "answer");
    const next = P.nextPrompt(state.results);
    const lead = drafted.length
      ? `I drafted ${drafted.length === 1 ? "an answer" : `${drafted.length} answers`} with AI. Read ${drafted.length === 1 ? "it" : "them"} over in the form.`
      : "I couldn't draft any of the open questions.";
    chat.lines.push({ role: "assistant", local: true, filled: drafted, ...followedBy(lead, next) });
    panel.idle();
  }

  // The popup's "Let AI answer questions it can't find" takes effect at once, also on an open panel.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !("aiDrafts" in changes) || !state?.ctx) return;
    state.ctx.aiDrafts = changes.aiDrafts.newValue !== false;
    if (state.ctx.aiDrafts && !agentLive() && !chat.pending && P.openQuestions(state.results).length) void draftOpen();
  });

  async function start(appId, opts = {}) {
    panel.setRetry(appId);
    await panel.restore(opts);
    if (!(await run(appId)) || agentLive()) return;
    // A page that needs clicking through (an Apply pop-up, Next steps, a form in a frame): carry on.
    const reason = handedOff ? null : P.navigationNeeded(pageShape());
    if (reason) return handOff(reason, opts);
    if (opts.autoSubmit) await autoApply();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === "agentUpdate") {
      const previous = agent;
      agent = msg;
      void agentChanged(previous, msg);
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
      handedOff = true;
      agent = await send({ type: "agentStatus" }).catch(() => null);
      if (!agent) return;
      await panel.restore({ show: true });
      chat.lines.push({ role: "assistant", local: true, text: "On to the next page of the form." });
      await agentChanged(null, agent);
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
    // Apply clicked in ApplyShortly: Auto apply, which still submits only when every required
    // field is answered, after its countdown.
    await start(hello.appId, { autoSubmit: hello.autoSubmit === true });
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
