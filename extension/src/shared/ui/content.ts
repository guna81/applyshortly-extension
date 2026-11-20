// Runs on every page but stays idle unless the page was opened with #jobhunt-autofill=<id>,
// is a later page of a form already being filled in this tab, or the toolbar icon or shortcut says "Autofill".
// It fills and reports. It submits only on the user's explicit "Auto apply", once every required
// field is answered and after a cancellable countdown; otherwise the user clicks the site's button.

(() => {
  if (globalThis.__jobhuntContentLoaded) return;
  globalThis.__jobhuntContentLoaded = true;

  const F = globalThis.JobHuntFill;
  const P = globalThis.JobHuntPanel;
  let state = null; // {appId, ctx, resume, results}
  let submittedReported = false;
  let attemptPending = false;
  let receiptBaseline = [];
  let attemptUrl = "";
  let autoSubmitting = false; // Auto apply clicked Submit; its own report covers the submit event
  const AUTO_APPLY_DELAY_S = 3;
  // The assistant's conversation for this page; reset with `state`.
  const newChat = () => ({ lines: [], draft: "", pending: false });
  let chat = newChat();
  // The form agent's latest update for this tab (it runs in the background; see page-control/loop.js).
  let agent = null;

  const RELOAD_TEXT = "The extension was updated or reloaded, so this page lost its connection. Reload the page to reconnect.";
  const isInvalidated = (err) => /extension context invalidated|receiving end does not exist/i.test(String(err?.message ?? err));

  function send(message) {
    return new Promise((resolve, reject) => {
      // After the extension is reloaded, this orphaned script's runtime is gone: say so instead of throwing.
      if (!chrome.runtime?.id) return reject(new Error("Extension context invalidated."));
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) {
          const err: any = new Error(res?.error ?? "No response from the extension");
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
    if (event === "submission_attempted") {
      if (!attemptPending) {
        receiptBaseline = receiptTexts();
        attemptUrl = location.href;
      }
      attemptPending = true;
      if (state.ctx?.app) state.ctx.app = { ...state.ctx.app, status: "submission_unconfirmed" };
    }
    // The API caps url at 2000 and note at 1000 characters.
    const payload: any = { application_id: state.appId, event, url: location.href.slice(0, 2000), ...extra };
    if (payload.note) payload.note = String(payload.note).slice(0, 1000);
    return send({ type: "report", event: payload }).catch(
      (err: any) => console.warn("[JobHunt] report failed:", err?.message),
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
    if (typeof document === "undefined" || !document) return { title: "", company: "", description: "" };
    const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
    const text = document.body?.innerText ?? document.body?.textContent ?? "";
    return {
      title: (document.title?.trim?.() || meta("og:title") || F.cleanLabel(document.querySelector("h1")?.textContent ?? "")).slice(0, 300),
      company: meta("og:site_name").slice(0, 200),
      description: text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 6000),
    };
  }

  /** Looks up an existing saved answer. */
  const suggest = (question, appId) =>
    send({ type: "suggest", question, appId, allowGenerate: false });

  const resolveAnswer = (field) =>
    (globalThis as any).JobHuntRuleEngine.resolveAnswer(field, state, suggest);

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
    // Form controls are plain text, so never paste generated Markdown syntax into them.
    if (field.kind === "text" && (answer.source === "generated" || answer.aiUpdate)) {
      answer = { ...answer, value: plainDraft(answer.value) };
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
    if (F.isPhoneBox(field)) {
      // A phone answer counts once the page holds a complete number under the right country.
      const phone = await F.applyPhone(field, answer.value);
      if (!phone.ok) return { field, status: "unresolved", reason: phone.reason ?? "Enter your phone number on the page.", suggestion: answer.value };
      return { field, status: "filled", value: phone.value, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
    }
    const written = F.apply(field, answer.value, { strict });
    if (written === null) {
      if (field.kind === "text") return { field, status: "unresolved", reason: "This answer doesn't fit the field. Please enter it on the page." };
      return { field, status: "unresolved", reason: `None of the options match “${answer.value}”`, suggestion: answer.value };
    }
    // Give frameworks a task boundary to commit this change before writing the next field.
    // Several onChange handlers can otherwise use the same stale form-state snapshot.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { field, status: "filled", value: written, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
  }

  function plainDraft(value) {
    return String(value).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
      .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1")
      .replace(/(^|\n)\s*[-*+]\s+/g, "$1• ")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1").trim();
  }

  async function fillAll() {
    const fields = F.collectFields(document);
    const fileFields = fields.filter((f) => f.kind === "file");
    const results = [];

    const answerable = fields.filter((f) => ["text", "select", "radio", "dropdown"].includes(f.kind) && F.isEmpty(f));
    const answers = await Promise.all(answerable.map(resolveAnswer));
    const answerFor = new Map(answerable.map((f, i) => [f, answers[i]]));

    for (const field of fields) {
      // A reopened or agent-filled form still has fields, even when this pass writes nothing.
      // Retain this run's provenance/review flags rather than relabelling its drafts as manual.
      if (answeredNow(field)) {
        const previous = state.results.find((r) => r.field.el === field.el);
        const value = currentValue(field);
        const unchanged = previous && ["filled", "done"].includes(previous.status) &&
          (value === null || value === previous.value);
        results.push(unchanged ? { ...previous, field } : {
          field, status: "done", source: "you", value, optional: !field.required,
        });
        continue;
      }
      if (field.kind === "checkbox") {
        if (field.required && !answeredNow(field)) {
          results.push({ field, status: "unresolved", reason: field.options?.length ? "Select the options that apply on the form" : "Tick it yourself if you agree" });
        }
        continue;
      }
      if (field.kind === "picker") {
        if (!answeredNow(field)) {
          results.push({ field, status: field.required ? "unresolved" : "optional", optional: !field.required, reason: "Use the form's upload button to attach your résumé" });
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
      const row: any = await applyAnswer(field, answerFor.get(field));
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
      if (row.status === "filled" && row.field.kind === "text" && row.field.el.matches('[role="textbox"][contenteditable]') && F.isEmpty(row.field)) {
        Object.assign(row, { status: row.field.required ? "unresolved" : "optional", reason: "The form did not keep this answer. Please enter it on the page." });
        continue;
      }
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
      const r: any = await send({ type: "resume" });
      if (!r) return null;
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      return new File([bytes], r.name, { type: r.type });
    } catch {
      return null;
    }
  }

  function merge(previous: any[], next: any[]) {
    // Keep earlier "filled" and "done" rows (their fields aren't empty, so a re-run skips them).
    const byEl = new Map(previous.filter((r) => r.field.el.isConnected).map((r) => [r.field.el, r]));
    for (const r of next) byEl.set(r.field.el, r);
    return [...byEl.values()].sort((a: any, b: any) => (a.field.el.compareDocumentPosition(b.field.el) & 4 ? -1 : 1));
  }

  const NEXT_TEXT = /^(next|continue|save (and|&) continue|proceed)\b/i;

  /** What the page looks like after filling: whether it needs clicking through (see navigationNeeded). */
  function pageShape() {
    const fields = F.collectFields(document);
    const label = (b: any) => F.cleanLabel(b.getAttribute("aria-label") || (b.tagName === "INPUT" ? b.value : b.textContent));
    const hasNext = [...document.querySelectorAll('button, input[type=submit], [role="button"]')]
      .some((b) => (b as HTMLElement).getClientRects().length > 0 && !b.matches(":disabled") && NEXT_TEXT.test(label(b)));
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
   */
  async function run(appId: any, { quiet = false }: any = {}) {
    try {
      if (!state || state.appId !== appId) {
        panel.busy("Loading your profile…");
        const [ctx, resume]: [any, any] = await Promise.all([send({ type: "context", appId, page: { title: pageJob().title, company: pageJob().company } }), loadResume()]);
        if (state) chat = newChat(); // another application; a fresh page keeps what the agent said
        state = { appId: ctx.app?.id ?? appId, ctx, resume, results: [] };
        if (!quiet) await report("opened");
      }
      if (!quiet && state.ctx.agentAvailable) { panel.idle(); return true; }
      if (!quiet && state.ctx.agentEngine === "ai_led") {
        state = null;
        throw new Error("The Agent based form assistant is unavailable. Check your connection or AI provider and retry.");
      }
      if (quiet) {
        // Readback only: the controller owns writes, including during completion refresh.
        state.results = F.collectFields(document).map((field) => {
          const native = agent?.filled?.find((f) => f.label === field.label);
          const answered = answeredNow(field);
          return { field, status: answered ? native ? "filled" : "done" : field.required ? "unresolved" : "optional",
            value: currentValue(field), source: native?.source ?? "you",
            needsReview: native?.needs_review ?? false, manual: field.kind === "checkbox" || field.kind === "file",
            optional: !field.required, reason: answered ? "" : "Not answered on the page" };
        });
        outline();
        panel.idle();
        return true;
      }
      panel.busy("Matching your answers to the form…");
      state.results = merge(state.results, await fillAll());
      outline();
      if (!quiet) await reportFilled();
      panel.idle();
      return true;
    } catch (err: any) {
      panel.fail(err);
      await report("failed", { note: err?.message });
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
      const next = await applyAnswer(r.field, { value, source: "assistant", needsReview: false, aiUpdate: true });
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
    return { text: "AI drafting is available in the Agent based form assistant. Type your answer to continue.", target: row };
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
    await startAgent({ autoSubmit });
  }

  /** The user's reply while the agent waits: an answer, a draft request, or "done on the page". */
  async function replyToAgent(message) {
    const q = agent.question;
    chat.lines.push({ role: "user", text: message });
    chat.draft = "";
    if (q?.kind !== "question") {
      // The Continue chip on a CAPTCHA/sign-in/click prompt is "done on the page", not an answer:
      // sent as a reply the platform never sees `resumed`, so a solved CAPTCHA keeps blocking.
      const done = message === P.ON_PAGE_REPLY || message === P.CONTINUE_REPLY;
      await agentControl(agent.agent_engine === "ai_led" && !done ? "reply" : "resume", message);
      return panel.idle();
    }
    const agentBased = agent.agent_engine === "ai_led";
    if (message === P.ON_PAGE_REPLY || (message === P.SKIP_REPLY && (q.optional || agentBased))) {
      const blank = message === P.SKIP_REPLY;
      if (!agentBased) chat.lines.push({ role: "assistant", local: true, text: blank ? "OK, leaving it blank. I'll carry on." : "OK, fill it on the page. I'll carry on." });
      await agentControl("skip");
      return panel.idle();
    }
    // The agent drafts for itself ("Draft it for me" reaches it as the user's request); the panel writes nothing.
    if (agentBased || !P.isDraftRequest(message)) {
      await agentControl("reply", message);
      return panel.idle();
    }
    chat.lines.push({
      role: "assistant", local: true,
      text: q.choices?.length ? "Pick one of the options, or tell me which one fits." : "Tell me what to put in the form.",
      choices: P.agentAsk(q)?.choices.filter((choice) => choice !== P.DRAFT_REPLY),
    });
    panel.idle();
  }

  let shownLog: string[] = []; // the agent's log lines already narrated in the chat
  let shownFilledCount = 0;

  /** Steps taken back to back share one chat bubble (one line each) instead of one bubble per step. */
  function pushStep(text) {
    const tail = chat.lines.at(-1);
    if (tail?.step && tail.parts) {
      if (tail.parts.at(-1) === text) return;
      tail.parts.push(text);
      if (tail.parts.length > 8) tail.parts.shift();
      tail.text = tail.parts.join("\n");
      return;
    }
    chat.lines.push({ role: "assistant", local: true, step: true, parts: [text], text });
  }

  function narrateFills(next: any) {
    const filled = Array.isArray(next?.filled) ? next.filled : [];
    if (filled.length <= shownFilledCount) return false;
    const fresh = filled.slice(shownFilledCount);
    shownFilledCount = filled.length;
    const items = fresh.map((f: any) => (f && f.label && f.value ? `${f.label}: ${f.value}` : f?.label || String(f)));
    chat.lines.push({ role: "assistant", local: true, filled: items });
    return true;
  }

  /** Every new line the agent logs joins the chat, folded into one bubble per run of steps. */
  function narrate(next) {
    const log = Array.isArray(next?.log) ? next.log.map(String).filter(Boolean) : [];
    if (!log.length) return false;
    // The agent sends its last 40 lines: find where what we already showed ends in the new window.
    let fresh = log;
    for (let drop = 0; drop <= shownLog.length; drop += 1) {
      const kept = shownLog.slice(drop);
      if (kept.length <= log.length && kept.every((line, i) => line === log[i])) { fresh = log.slice(kept.length); break; }
    }
    shownLog = log;
    for (const text of fresh) {
      // The agent repeats generic lines (e.g. "Filling the next known answer…"); say each only once in a row.
      const last = [...chat.lines].reverse().find((l) => l.step);
      if ((last?.parts ? last.parts.at(-1) : last?.text) === text || /^Filling the next known answer/i.test(text)) continue;
      pushStep(text);
    }
    return fresh.length > 0;
  }

  /** Brings the agent's progress into the chat: every step it takes, its questions, and what happened when it stopped. */
  async function agentChanged(previous, next) {
    const logNew = narrate(next);
    // The agent-based assistant speaks for itself; do not turn its structured
    // fill data into a separate, code-generated checklist in the conversation.
    const fillNew = next.agent_engine === "ai_led" ? false : narrateFills(next);
    const key = (a) => (a?.status === "waiting" ? `waiting:${a.question?.kind}:${a.question?.text}` : a?.status);
    if (key(previous) === key(next)) {
      panel.agent(Boolean(logNew || fillNew));
      return;
    }
    if (next.status === "waiting") {
      const ask = P.agentAsk(next.question, next.agent_engine);
      // The agent may log the same blocker/question text as a step; show it once as the card below.
      const tail = chat.lines.at(-1);
      if (tail?.step && next.question?.text) {
        const parts = (tail.parts ?? [tail.text]).filter((part) => part !== next.question.text);
        if (parts.length) { tail.parts = parts; tail.text = parts.join("\n"); } else chat.lines.pop();
      }
      // The same question twice in a row (nothing said by the user between) is one card.
      const lastSaid = [...chat.lines].reverse().find((l) => !l.step);
      const sameCard = (a, b) => Boolean(a && b) && (a.question?.label ?? a.text) === (b.question?.label ?? b.text);
      if (ask && !(lastSaid?.role === "assistant" && sameCard(lastSaid, ask))) chat.lines.push({ role: "assistant", local: true, ...ask });
      panel.agent(true);
      return;
    }
    if (!["ready", "failed", "stopped"].includes(next.status)) {
      // The agent is working again: what it reported at the last "ready" no longer holds.
      if (state) { state.readiness = null; state.captchaPending = false; }
      panel.agent(previous == null);
      return;
    }
    // Done driving: read the page as it is now, so the chat can follow up and Submit knows the state.
    const gone = next.status === "failed" && next.failure_code === "posting_gone";
    if (state) state.postingGone = gone;
    const lead = gone ? `${next.message || "This job posting is closed or has been removed."} There is no application form to fill, so I've stopped.` : next.status === "ready" ? ([next.message, next.captchaPending ? "Complete any CAPTCHA the site requires, then submit the application on the page." : ""].filter(Boolean).join(" ")) : `${next.message ?? "I stopped."} You can finish it on the page, or ask me to change an answer.`;
    // The agent also logged its message as a step; the hand-off below says it, so don't show it twice.
    const tail = chat.lines.at(-1);
    if (tail?.step && next.message && lead.includes(next.message)) {
      const parts = (tail.parts ?? [tail.text]).filter((part) => part !== next.message);
      if (parts.length) { tail.parts = parts; tail.text = parts.join("\n"); } else chat.lines.pop();
    }
    const refreshed = await run(state?.appId ?? next.appId ?? null, { quiet: true });
    // The panel's scan covers this document only; keep the agent's frame-aware view beside it.
    if (state) { state.readiness = next.status === "ready" ? next.readiness ?? null : null; state.captchaPending = next.status === "ready" && next.captchaPending === true; }
    // The agent's own closing message is the whole hand-off; the Agent based form adds no counts, notes or questions.
    const agentBased = next.agent_engine === "ai_led";
    const framedNote = next.status === "ready" && !agentBased ? P.readinessNote({ missing: (next.readiness?.missing ?? []).filter((m: any) => m.framed) }) : "";
    const leadWithNote = [lead, framedNote].filter(Boolean).join(" ");
    const follow = next.status === "ready" && state ? P.nextPrompt(state.results) : null;
    const bodyText = next.status === "ready"
      ? (follow ? followedBy(leadWithNote, follow) : { text: leadWithNote || DONE_TEXT, choices: [] })
      : { text: leadWithNote, choices: [] };
    if (leadWithNote || follow) chat.lines.push({ role: "assistant", local: true, ...bodyText });
    panel.agent(true);
    // The agent never submits. Resume only this run's explicit Auto apply choice,
    // through the same required-field checks and cancellable countdown as a single page.
    if (refreshed && next.status === "ready" && (next.autoSubmit === true || autoApplyOn) && !next.captchaPending && next.appId === state?.appId) await autoApply();
  }

  /** One chat turn. Like the web app's review assistant: it fills fields, the user submits. */
  async function askAssistant(text) {
    const message = text.trim();
    if (!message || chat.pending) return;
    // Once the agent has finished ("ready"), the panel's own quick replies (tick it, show me, I've done it)
    // act on the page directly, as they do without an agent. Sent to the agent they would arrive as a
    // read-only chat question and nothing would be ticked.
    const finishedChip = agent?.agent_engine !== "ai_led" && agent?.status === "ready" && P.LOCAL_REPLIES.includes(message);
    if (agent && !["failed", "stopped"].includes(agent.status) && !finishedChip) {
      // The chips on the agent's own question/blocker are the panel's: "Draft it for me" drafts,
      // "I'll fill it on the page" / "Leave it blank" skips, and "Continue" resumes a blocker/click handoff.
      if (agent.status === "waiting" && (
        (agent.question?.kind === "question" && (P.isDraftRequest(message) || message === P.ON_PAGE_REPLY || message === P.SKIP_REPLY)) ||
        (agent.question?.kind !== "question" && (message === P.CONTINUE_REPLY || message === P.ON_PAGE_REPLY))
      )) {
        return replyToAgent(message);
      }
      chat.lines.push({ role: "user", text: message });
      chat.draft = "";
      // A typed response to a field question or a stuck blocker ("fill it yourself, or type the answer for me")
      // goes as a reply so the agent keeps its write tools; other mid-run messages go as chat messages.
      const plainAnswer = agent.status === "waiting" && (agent.question?.kind === "question" || agent.question?.kind === "blocker");
      await agentControl(plainAnswer ? "reply" : "message", message);
      panel.idle();
      return;
    }
    if (agent?.status === "waiting") return replyToAgent(message);
    if (agentLive() || !state?.ctx) return; // it's clicking through the form; the box is off meanwhile
    if (P.isNavigateRequest(message)) {
      chat.lines.push({ role: "user", text: message });
      chat.draft = "";
      return handOff("asked");
    }
    // The question the chat asked last; a plain answer to it is filled here, for free.
    const asked = ([...chat.lines].reverse().find((l) => l.role === "assistant" && !l.step) ?? greeting())?.target;
    // A draft request drafts the question just asked, required or optional.
    const target = P.isDraftRequest(message) ? asked ?? P.promptTarget(state.results) : P.LOCAL_REPLIES.includes(message) ? P.promptTarget(state.results) : null;
    const answer = target ? null : P.directAnswer(asked, message);
    if (target || answer != null) {
      const turn = chat;
      const hello = turn.lines.length ? null : greeting();
      if (hello) turn.lines.push({ role: "assistant", greeting: true, ...hello });
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
    chat.lines.push({ role: "user", text: message });
    chat.lines.push({ role: "assistant", local: true, text: "Type an answer for the current field, or use the Agent based form assistant for AI assistance." });
    panel.idle();
  }

  // ------------------------------------------------------------------ live re-check

  /** Whether the user has answered a field, by looking at the page as it is now. */
  function answeredNow(field) {
    switch (field.kind) {
      case "checkbox":
        if (field.options?.length) return field.options.some((o) => o.el.checked === true);
        return field.el.checked === true || field.el.getAttribute("aria-checked") === "true";
      case "dropdown":
        return field.phoneFor ? !F.isEmpty(field) : Boolean(F.dropdownValue(field)) && !F.isInvalid(field);
      case "picker": // Google Forms hides "Add file" once the file is attached
        if (field.dropzone) return !field.el.isConnected || !field.el.getClientRects().length;
        return ![...field.el.querySelectorAll('[role="button"]')].some(
          (b) => /add file|upload/i.test(b.textContent) && b.getClientRects().length > 0,
        );
      default:
        return !F.isEmpty(field) && !F.isInvalid(field);
    }
  }

  function currentValue(field) {
    if (field.kind === "text") return F.textValue(field.el) || F.widgetPick(field.el);
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
      } else if (r.status === "filled" && !answeredNow(r.field)) {
        Object.assign(r, { status: r.optional ? "optional" : "unresolved", reason: "The form cleared this answer. Please choose a value." });
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

  // Only explicit receipt evidence in a visible status/heading counts as confirmation.
  // A duplicate-profile error, a submit click, and general job-description text do not.
  // Sites put the receipt in a heading, a status region or just a paragraph or box, so any
  // visible short element can carry it; the wording and the "new since the attempt" check decide.
  const RECEIPT_ELEMENTS = 'h1, h2, h3, p, div, span, [role="status"], [role="alert"], .alert, .toast';
  function receiptTexts() {
    if (typeof document === "undefined" || !document) return [];
    return [...document.querySelectorAll(RECEIPT_ELEMENTS)].filter((el) => {
      if (!el.getClientRects().length || el.closest('jobhunt-autofill-panel')) return false;
      const text = F.cleanLabel(el.textContent ?? "");
      // Ashby's receipt has a generic heading and company-specific thanks. Require its
      // dedicated positive status container, never a generic Success heading or toast.
      if (el.matches('.ashby-application-form-success-container[role="status"]') &&
          el.getAttribute("data-highlight") === "positive" &&
          [...el.querySelectorAll("h2")].some((h) => F.cleanLabel(h.textContent) === "Success")) return true;
      return text.length <= 600 && !/\b(not|unable|failed|error|already|cannot|couldn.t)\b/i.test(text) &&
        /\b(?:your application (?:has been |was )?(?:successfully )?(?:submitted|received)|application (?:submitted|received) successfully|thank you for applying|thank you\s*[—–-]\s*our talent team will review your application|we (?:have )?received your application)\b/i.test(text);
    }).map((el) => F.cleanLabel(el.textContent ?? ""));
  }

  const hasReceipt = () => receiptTexts().some((text) => !receiptBaseline.includes(text));
  // The site moved to its own confirmation page (a single-page app changes the address without reloading).
  const reachedConfirmationPage = () => typeof location !== "undefined" && Boolean(location?.href) && location.href !== attemptUrl && F.confirmationPath(location.href);

  function checkConfirmation() {
    if (!attemptPending || submittedReported) return;
    if (hasReceipt()) void markSubmitted("site confirmed application receipt");
    else if (reachedConfirmationPage()) void markSubmitted("confirmation page");
  }

  // A single-page app re-renders when its route changes, so the same observer sees the move.
  new MutationObserver(checkConfirmation).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

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
  async function autoApply(unattended = false) {
    if (!state?.ctx || autoSubmitting || submittedReported) return;
    // A sign-in page (or account creation) is the user's to complete: the window stays for them.
    if (P.loginWall(location.pathname, [...document.querySelectorAll("input[type=password]")].some((el) => !isHidden(el)))) {
      return panel.stop("Not submitted: this page needs you to sign in. Sign in, then choose “Auto apply”.");
    }
    recheck();
    const blocked = P.autoApplyBlockers(state.results, state.ctx.app, state.readiness, state.captchaPending);
    if (blocked.length) return panel.stop(`Not submitted: ${blocked.join(". ")}.`);
    // Autopilot's window sends only what is certain: a guessed or drafted answer is for the user to check.
    const unchecked = unattended ? state.results.filter((r) => r.status === "filled" && r.needsReview && !r.reviewed) : [];
    if (unchecked.length) {
      return panel.stop(`Not submitted: ${unchecked.length} ${unchecked.length === 1 ? "answer needs" : "answers need"} your check. This window is open for you.`);
    }
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
    if (P.autoApplyBlockers(state.results, state.ctx.app, state.readiness, state.captchaPending).length ||
        currentFields.some((field) => (field.required && !answeredNow(field)) || F.isInvalid(field)) ||
        currentButton !== button || !button.isConnected || button.disabled ||
        button.getAttribute("aria-disabled") === "true" || (form && !form.checkValidity())) {
      return panel.stop("Not submitted: the form changed. Check it and try again.");
    }
    autoSubmitting = true;
    await report("submission_attempted", { note: "auto apply clicked the form's submit button; confirmation not yet detected" });
    if (state.ctx.app) state.ctx.app = { ...state.ctx.app, status: "submission_unconfirmed" };
    button.click();
    // Autopilot's window, if this is one, closes shortly after.
    void send({ type: "autoApplied" }).catch(() => {});
    panel.idle();
    panel.toast("Submission attempted. Check the page for the site's confirmation.");
    // Keep this page locked after an attempt; another click must not submit it twice.
  }

  // ------------------------------------------------------------------ panel (panel-view.js)

  // What the panel (panel-view.js) reads and calls. It reads state through these getters and
  // changes it only through the actions.
  /**
   * A quick local count of the fields on this page (no AI, nothing filled), so the panel can show "0/14" while the
   * agent is still reading the form. The agent's own frame-aware count replaces it once it arrives.
   */
  function pageCount() {
    try {
      const fields = F.collectFields(document);
      return { total: fields.length, answered: fields.filter((f) => answeredNow(f)).length };
    } catch { return null; }
  }
  // Forms often render after load: re-count as the page grows, until the agent reports its own total.
  let countTimer = null;
  new MutationObserver(() => {
    if (countTimer || !agent || !["starting", "running"].includes(agent.status) || agent.field_total) return;
    countTimer = setTimeout(() => { countTimer = null; if (agent && !agent.field_total) panel.agent(false); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  const ctl = {
    get state() { return state; },
    get agent() { return agent; },
    get chat() { return chat; },
    get submittedReported() { return submittedReported; },
    get pageCount() { return pageCount(); },
    AUTO_APPLY_DELAY_S,
    agentControl, askAssistant, autoApply, markSubmitted, outlineTarget, run: start, send,
  };
  const panel = globalThis.JobHuntPanelView.create(ctl);

  // ------------------------------------------------------------------ lifecycle

  // A native form submit (the user clicked the site's submit button). Pages that submit with
  // fetch instead are covered by the confirmation-page check or the panel's "I already submitted".
  document.addEventListener(
    "submit",
    (event) => {
      if (autoSubmitting || attemptPending || state?.appId == null || !state.results.length) return;
      const button = F.findSubmitButton(document, state.results.map((r) => r.field)) ?? F.findSubmitButton(document, []);
      if (!button || (event.submitter && event.submitter !== button)) return;
      void report("submission_attempted", { note: "form submit event; confirmation not yet detected" });
    },
    true,
  );

  // SPA forms may send through fetch without a native submit event. Observe the user's final
  // button click too, while treating it only as an attempt until receipt evidence appears.
  document.addEventListener("click", (event) => {
    if (autoSubmitting || attemptPending || !state?.results.length || state.appId == null) return;
    const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
    const button = F.findSubmitButton(document, []);
    if (!target || target !== button || target.matches(':disabled, [aria-disabled="true"]')) return;
    if (state.results.some((r) => (r.field.required && !answeredNow(r.field)) || F.isInvalid(r.field))) return;
    if (target.closest('form')?.querySelector(':invalid')) return;
    void report("submission_attempted", { note: "final submit clicked; confirmation not yet detected" });
  }, true);

  async function startAgent({ autoSubmit = false } = {}) {
    if (agent) chat = newChat(); // a restart begins a clean conversation: the last run's steps and questions are not this one's
    agent = { status: "starting", log: [], appId: state?.appId ?? null };
    shownLog = [];
    panel.agent(true);
    try {
      await send({ type: "agentStart", appId: state?.appId ?? null, autoSubmit });
    } catch (err: any) {
      agent = null;
      const e = P.friendlyError(err?.message, err?.status, state?.ctx?.baseUrl, err?.code);
      chat.lines.push({ role: "assistant", local: true, error: true, text: `I couldn't click through this form: ${e.detail || e.title} You can finish it on the page; I'll keep helping here.` });
      panel.agent(true);
    }
  }

  async function agentControl(action: string, text?: string) {
    if (action === "reply" && !String(text ?? "").trim()) return;
    try {
      await send({ type: "agentControl", action, text });
    } catch (err: any) {
      panel.toast(isInvalidated(err) ? RELOAD_TEXT : err?.message, { persist: true });
    }
  }

  /** Drafts every open question with AI (the switch was just turned on), then says what it did. */
  // The panel's two switches (also on the settings page) take effect at once, also on an open panel.
  // "Let AI answer": draft what the profile doesn't cover. "Auto apply": send once everything is answered.
  let autoApplyOn = false;
  try { void chrome.storage?.local?.get?.("autoApply")?.then?.((v) => { autoApplyOn = v?.autoApply === true; }); } catch { /* storage unavailable */ }
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if ("autoApply" in changes) {
      autoApplyOn = changes.autoApply.newValue === true;
      if (!autoApplyOn) return panel.cancelCountdown?.();
      // Switched on after the form is already filled: send it now, through the usual checks and countdown.
      const idle = state?.ctx && !chat.pending && !agentLive() && (!agent || agent.status === "ready");
      if (idle && state.results.length && !submittedReported) void autoApply();
    }
  });

  async function start(appId: any, opts: any = {}) {
    panel.setRetry(appId);
    await panel.restore(opts);
    if (!(await run(appId)) || agentLive()) return;
    if (state?.ctx.agentAvailable && !opts.unattended) return startAgent(opts);
    // A page that needs clicking through (an Apply pop-up, Next steps, a form in a frame): carry on.
    const reason = handedOff ? null : P.navigationNeeded(pageShape());
    // Autopilot's window has nobody watching: no agent (it spends a run's credits behind a debugging
    // bar), the page stays for the user.
    if (reason && opts.unattended) {
      handedOff = true;
      return panel.stop("Autopilot can't submit a form with several steps. This window is open for you to finish it.");
    }
    if (reason) return handOff(reason, opts);
    if (opts.autoSubmit) await autoApply(opts.unattended === true);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === "agentUpdate") {
      const previous = agent;
      agent = { ...msg, agent_engine: msg.agent_engine ?? previous?.agent_engine };
      void agentChanged(previous, agent);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "assistantUpdate") {
      // The connected assistant is filling this page: show its steps in this panel.
      panel.assistant({ submissionState: msg.submissionState, assistantName: typeof msg.assistantName === "string" ? msg.assistantName : null, active: msg.active === true, paused: msg.paused === true, steps: Array.isArray(msg.steps) ? msg.steps : [], notes: Array.isArray(msg.notes) ? msg.notes : [] });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "run") {
      // Same application: keep what's been filled and answered; another one starts over.
      if (state && state.appId !== (msg.appId ?? null)) { state = null; chat = newChat(); }
      void start(msg.appId ?? null, { show: true, autoSubmit: msg.autoSubmit === true, unattended: msg.unattended === true });
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
      shownLog = (agent.log ?? []).map(String);
      await panel.restore({ show: true });
      await agentChanged(null, agent);
      return;
    }
    if (hello.mode === "continue") {
      if (hello.attemptPending && (F.looksSubmitted(document, location.href) || hasReceipt())) {
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
    await start(hello.appId, { autoSubmit: hello.autoSubmit === true, unattended: hello.unattended === true });
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
