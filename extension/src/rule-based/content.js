(() => {
  if (globalThis.__jobhuntContentLoaded) return;
  globalThis.__jobhuntContentLoaded = true;
  const F = globalThis.JobHuntFill;
  const P = globalThis.JobHuntPanel;
  let state = null;
  let submittedReported = false;
  let attemptPending = false;
  let receiptBaseline = [];
  let attemptUrl = "";
  let autoSubmitting = false;
  const AUTO_APPLY_DELAY_S = 3;
  const newChat = () => ({ lines: [], draft: "", pending: false });
  let chat = newChat();
  let agent = null;
  const RELOAD_TEXT = "The extension was updated or reloaded, so this page lost its connection. Reload the page to reconnect.";
  const isInvalidated = (err) => /extension context invalidated|receiving end does not exist/i.test(String(err?.message ?? err));
  function send(message) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) return reject(new Error("Extension context invalidated."));
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
    if (event === "submission_attempted") {
      if (!attemptPending) {
        receiptBaseline = receiptTexts();
        attemptUrl = location.href;
      }
      attemptPending = true;
      if (state.ctx?.app) state.ctx.app = { ...state.ctx.app, status: "submission_unconfirmed" };
    }
    const payload = { application_id: state.appId, event, url: location.href.slice(0, 2e3), ...extra };
    if (payload.note) payload.note = String(payload.note).slice(0, 1e3);
    return send({ type: "report", event: payload }).catch(
      (err) => console.warn("[JobHunt] report failed:", err?.message)
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
        needs_review: Boolean(r.needsReview)
      })),
      unresolved_fields: unresolved.map((r) => ({ label: r.field.label, reason: r.reason }))
    });
  }
  function pageJob() {
    const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
    const text = document.body?.innerText ?? document.body?.textContent ?? "";
    return {
      title: (document.title.trim() || meta("og:title") || F.cleanLabel(document.querySelector("h1")?.textContent ?? "")).slice(0, 300),
      company: meta("og:site_name").slice(0, 200),
      description: text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 6e3)
    };
  }
  const suggest = (question, appId, allowGenerate) => send({ type: "suggest", question, appId, allowGenerate, page: allowGenerate && appId == null ? pageJob() : void 0 });
  let draftError = null;
  async function resolveAnswer(field, allowGenerate) {
    if (field.consent) return null;
    if (field.kind === "text" && field.el.matches("input[type=date], input.ashby-application-form-input-date")) {
      const prefs = state.ctx.profile.preferences;
      let value = prefs?.available_from;
      if (!value && prefs?.notice_period_days === 0) {
        const today = /* @__PURE__ */ new Date();
        value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      }
      return value ? { value, source: "profile", needsReview: false } : null;
    }
    const local = F.profileAnswer(field.label, state.ctx.profile, state.ctx.app);
    if (local) return { value: local.value, source: "profile", needsReview: local.needsReview };
    if (!field.label) return null;
    const head = F.firstSentence(field.label);
    const attempts = head !== field.label ? [[field.label, false], [head, false]] : [[field.label, false]];
    if (allowGenerate && (field.kind !== "text" || P.draftable(field))) attempts.push([field.label, true]);
    for (const [question, generate] of attempts) {
      try {
        const s = await suggest(question, state.appId, generate);
        if (s.answer) return { value: s.answer, source: s.source, needsReview: s.needs_review };
      } catch (err) {
        console.warn("[JobHunt] suggest failed:", err?.message);
        if (generate) draftError = err?.message;
        return null;
      }
    }
    return null;
  }
  function isResumeInput(field, fileFields) {
    if (/cover/i.test(field.label)) return false;
    return /resume|résumé|\bcv\b|curriculum/i.test(field.label) || fileFields.length === 1;
  }
  async function applyAnswer(field, answer) {
    if (!answer) {
      if (field.required) return { field, status: "unresolved", reason: "Not in your profile or answer bank yet" };
      return { field, status: "optional", optional: true, reason: "Optional" };
    }
    if (field.kind === "text" && (answer.source === "generated" || answer.aiUpdate)) {
      answer = { ...answer, value: plainDraft(answer.value) };
    }
    const strict = answer.source === "generated";
    if (field.kind === "dropdown") {
      const picked = field.custom ? await F.pickDropdown(field, answer.value, { strict }) : null;
      if (picked === null) {
        return { field, status: "unresolved", reason: `Pick \u201C${answer.value}\u201D from the list`, suggestion: answer.value };
      }
      return { field, status: "filled", value: picked, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
    }
    if (F.isPhoneBox(field)) {
      const phone = await F.applyPhone(field, answer.value);
      if (!phone.ok) return { field, status: "unresolved", reason: phone.reason ?? "Enter your phone number on the page.", suggestion: answer.value };
      return { field, status: "filled", value: phone.value, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
    }
    const written = F.apply(field, answer.value, { strict });
    if (written === null) {
      if (field.kind === "text") return { field, status: "unresolved", reason: "This answer doesn't fit the field. Please enter it on the page." };
      return { field, status: "unresolved", reason: `None of the options match \u201C${answer.value}\u201D`, suggestion: answer.value };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { field, status: "filled", value: written, source: answer.source, needsReview: answer.needsReview, optional: !field.required };
  }
  function plainDraft(value) {
    return String(value).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)").replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1").replace(/(^|\n)\s*[-*+]\s+/g, "$1\u2022 ").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1").replace(/`([^`\n]+)`/g, "$1").trim();
  }
  async function fillAll({ allowGenerate }) {
    const fields = F.collectFields(document);
    const fileFields = fields.filter((f) => f.kind === "file");
    const results = [];
    const answerable = fields.filter((f) => ["text", "select", "radio", "dropdown"].includes(f.kind) && F.isEmpty(f));
    const answers = await Promise.all(answerable.map((f) => resolveAnswer(f, allowGenerate)));
    const answerFor = new Map(answerable.map((f, i) => [f, answers[i]]));
    for (const field of fields) {
      if (answeredNow(field)) {
        const previous = state.results.find((r) => r.field.el === field.el);
        const value = currentValue(field);
        const unchanged = previous && ["filled", "done"].includes(previous.status) && (value === null || value === previous.value);
        results.push(unchanged ? { ...previous, field } : {
          field,
          status: "done",
          source: "you",
          value,
          optional: !field.required
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
          results.push({ field, status: field.required ? "unresolved" : "optional", optional: !field.required, reason: "Use the form's upload button to attach your r\xE9sum\xE9" });
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
      if (!answerFor.has(field)) continue;
      const row = await applyAnswer(field, answerFor.get(field));
      if (row && !answerFor.get(field) && allowGenerate && P.draftable(field)) row.draftAttempted = true;
      if (row) results.push(row);
    }
    const checked = await validate(results, fields);
    await readChoices(checked);
    return checked;
  }
  async function readChoices(results) {
    for (const row of results) {
      const { field } = row;
      if (!field.custom || field.options?.length || !["unresolved", "optional"].includes(row.status)) continue;
      field.options = await F.readDropdownOptions(field);
    }
  }
  const SETTLE_MS = 300;
  async function validate(results, fields) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    for (const row of results) {
      if (row.status === "filled" && row.field.kind === "text" && row.field.el.matches('[role="textbox"][contenteditable]') && F.isEmpty(row.field)) {
        Object.assign(row, { status: row.field.required ? "unresolved" : "optional", reason: "The form did not keep this answer. Please enter it on the page." });
        continue;
      }
      if (row.status !== "filled" || !F.isInvalid(row.field)) continue;
      if (!await repair(row)) {
        const why = F.invalidReason(row.field);
        Object.assign(row, { status: "unresolved", reason: why ? `The site says: \u201C${why}\u201D` : "The site doesn't accept this answer", suggestion: row.value });
      }
    }
    const known = new Set(results.map((r) => r.field.el));
    for (const field of fields) {
      if (known.has(field.el) || !["text", "select", "radio", "dropdown"].includes(field.kind) || F.isEmpty(field) || !F.isInvalid(field)) continue;
      const why = F.invalidReason(field);
      results.push({ field, status: "unresolved", reason: why ? `The site says: \u201C${why}\u201D` : "The site doesn't accept this answer" });
    }
    return results;
  }
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
    const byEl = new Map(previous.filter((r) => r.field.el.isConnected).map((r) => [r.field.el, r]));
    for (const r of next) byEl.set(r.field.el, r);
    return [...byEl.values()].sort((a, b) => a.field.el.compareDocumentPosition(b.field.el) & 4 ? -1 : 1);
  }
  const NEXT_TEXT = /^(next|continue|save (and|&) continue|proceed)\b/i;
  function pageShape() {
    const fields = F.collectFields(document);
    const label = (b) => F.cleanLabel(b.getAttribute("aria-label") || (b.tagName === "INPUT" ? b.value : b.textContent));
    const hasNext = [...document.querySelectorAll('button, input[type=submit], [role="button"]')].some((b) => b.getClientRects().length > 0 && !b.matches(":disabled") && NEXT_TEXT.test(label(b)));
    const bigFrame = [...document.querySelectorAll("iframe")].some((f) => {
      const r = f.getBoundingClientRect();
      return r.width >= 300 && r.height >= 300;
    });
    return { total: fields.length, hasSubmit: Boolean(F.findSubmitButton(document, fields)), hasNext, bigFrame };
  }
  const greeting = () => P.assistantGreeting(state.results);
  async function run(appId, { allowGenerate, quiet = false } = {}) {
    try {
      if (!state || state.appId !== appId) {
        panel.busy("Loading your profile\u2026");
        const [ctx, resume] = await Promise.all([send({ type: "context", appId, page: { title: pageJob().title, company: pageJob().company } }), loadResume()]);
        if (state) chat = newChat();
        state = { appId: ctx.app?.id ?? appId, ctx, resume, results: [] };
        if (!quiet) await report("opened");
      }
      if (!quiet && state.ctx.agentAvailable) {
        panel.idle();
        return true;
      }
      if (quiet) {
        state.results = F.collectFields(document).map((field) => {
          const native = agent?.filled?.find((f) => f.label === field.label);
          const answered = answeredNow(field);
          return {
            field,
            status: answered ? native ? "filled" : "done" : field.required ? "unresolved" : "optional",
            value: currentValue(field),
            source: native?.source ?? "you",
            needsReview: native?.needs_review ?? false,
            manual: field.kind === "checkbox" || field.kind === "file",
            optional: !field.required,
            reason: answered ? "" : "Not answered on the page"
          };
        });
        outline();
        panel.idle();
        return true;
      }
      const generate = allowGenerate ?? state.ctx.aiDrafts;
      panel.busy(generate ? "Drafting answers with AI\u2026 this can take a few seconds" : "Matching your answers to the form\u2026");
      state.results = merge(state.results, await fillAll({ allowGenerate: generate }));
      outline();
      if (!quiet) await reportFilled();
      panel.idle();
      return true;
    } catch (err) {
      panel.fail(err);
      await report("failed", { note: err?.message });
      return false;
    }
  }
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
  async function directReply(row, value) {
    const filled = await applyAssistantUpdates({ answer: value }, { answer: row });
    return filled.length ? { text: "Got it.", filled, next: true } : { text: `The form didn't take \u201C${value}\u201D. Please set it on the page.` };
  }
  const followedBy = (lead, next) => ({ text: `${lead} ${next ? next.text : DONE_TEXT}`, question: next?.question, choices: next?.choices ?? [], target: next?.target });
  function withNext(reply) {
    if (!reply.next) return reply;
    return { ...reply, ...followedBy(reply.text, P.nextPrompt(state.results)) };
  }
  const AGENT_LIVE = ["starting", "running", "waiting", "paused"];
  const agentLive = () => Boolean(agent && AGENT_LIVE.includes(agent.status));
  let handedOff = false;
  async function handOff(reason, { autoSubmit = false } = {}) {
    handedOff = true;
    chat.lines.push({ role: "assistant", local: true, text: P.handoffText(reason, { autoSubmit }) });
    panel.idle();
    await startAgent({ autoSubmit });
  }
  async function replyToAgent(message) {
    const q = agent.question;
    chat.lines.push({ role: "user", text: message });
    chat.draft = "";
    if (q?.kind !== "question") {
      const done = message === P.ON_PAGE_REPLY || message === P.CONTINUE_REPLY;
      await agentControl(agent.agent_engine === "ai_led" && !done ? "reply" : "resume", message);
      return panel.idle();
    }
    const agentBased = agent.agent_engine === "ai_led";
    if (message === P.ON_PAGE_REPLY || message === P.SKIP_REPLY && (q.optional || agentBased)) {
      const blank = message === P.SKIP_REPLY;
      if (!agentBased) chat.lines.push({ role: "assistant", local: true, text: blank ? "OK, leaving it blank. I'll carry on." : "OK, fill it on the page. I'll carry on." });
      await agentControl("skip");
      return panel.idle();
    }
    if (agentBased || !P.isDraftRequest(message)) {
      await agentControl("reply", message);
      return panel.idle();
    }
    chat.pending = true;
    panel.idle();
    try {
      if (!P.draftable({ kind: "text", label: q.text }) && P.groundedDraft(q.text)) {
        chat.lines.push({ role: "assistant", local: true, text: "I'll write it from your profile and what you've told me here, and nothing else. Read it over in the form." });
        await agentControl("message", `Draft it for me: answer the open question "${String(q.text).slice(0, 200)}" yourself: type one or two plain sentences into that field using only facts from my profile and my earlier answers in this chat (user_answered). Do not invent anything; if a fact is missing, ask me for it.`);
        return;
      }
      let lost = false;
      const s = P.draftable({ kind: "text", label: q.text }) ? await suggest(q.text, state?.appId ?? agent.appId ?? null, true).catch((err) => {
        lost = isInvalidated(err);
        return null;
      }) : null;
      if (lost) {
        chat.lines.push({ role: "assistant", local: true, text: RELOAD_TEXT });
        return;
      }
      if (s?.answer) {
        chat.lines.push({ role: "assistant", local: true, text: `Here's a draft, going into the form now: \u201C${s.answer}\u201D Tell me if you want it changed.` });
        await agentControl("reply", s.answer);
      } else {
        chat.lines.push({ role: "assistant", local: true, text: q.choices?.length ? "Pick one of the options, or tell me which one fits." : "That's one only you can answer. Tell me what to put.", choices: P.agentAsk(q)?.choices.filter((c) => c !== P.DRAFT_REPLY) });
      }
    } finally {
      chat.pending = false;
      panel.idle();
    }
  }
  let shownLog = [];
  let shownFilledCount = 0;
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
  function narrateFills(next) {
    const filled = Array.isArray(next?.filled) ? next.filled : [];
    if (filled.length <= shownFilledCount) return false;
    const fresh = filled.slice(shownFilledCount);
    shownFilledCount = filled.length;
    const items = fresh.map((f) => f && f.label && f.value ? `${f.label}: ${f.value}` : f?.label || String(f));
    chat.lines.push({ role: "assistant", local: true, filled: items });
    return true;
  }
  function narrate(next) {
    const log = Array.isArray(next?.log) ? next.log.map(String).filter(Boolean) : [];
    if (!log.length) return false;
    let fresh = log;
    for (let drop = 0; drop <= shownLog.length; drop += 1) {
      const kept = shownLog.slice(drop);
      if (kept.length <= log.length && kept.every((line, i) => line === log[i])) {
        fresh = log.slice(kept.length);
        break;
      }
    }
    shownLog = log;
    for (const text of fresh) {
      const last = [...chat.lines].reverse().find((l) => l.step);
      if ((last?.parts ? last.parts.at(-1) : last?.text) === text || /^Filling the next known answer/i.test(text)) continue;
      pushStep(text);
    }
    return fresh.length > 0;
  }
  async function agentChanged(previous, next) {
    const logNew = narrate(next);
    const fillNew = narrateFills(next);
    const key = (a) => a?.status === "waiting" ? `waiting:${a.question?.kind}:${a.question?.text}` : a?.status;
    if (key(previous) === key(next)) {
      panel.agent(Boolean(logNew || fillNew));
      return;
    }
    if (next.status === "waiting") {
      const ask = P.agentAsk(next.question, next.agent_engine);
      const lastSaid = [...chat.lines].reverse().find((l) => !l.step);
      const sameCard = (a, b) => Boolean(a && b) && (a.question?.label ?? a.text) === (b.question?.label ?? b.text);
      if (ask && !(lastSaid?.role === "assistant" && sameCard(lastSaid, ask))) chat.lines.push({ role: "assistant", local: true, ...ask });
      panel.agent(true);
      return;
    }
    if (!["ready", "failed", "stopped"].includes(next.status)) {
      if (state) {
        state.readiness = null;
        state.captchaPending = false;
      }
      panel.agent(previous == null);
      return;
    }
    const gone = next.status === "failed" && next.failure_code === "posting_gone";
    if (state) state.postingGone = gone;
    const lead = gone ? `${next.message || "This job posting is closed or has been removed."} There is no application form to fill, so I've stopped.` : next.status === "ready" ? [next.message, next.captchaPending ? "Complete any CAPTCHA the site requires, then submit the application on the page." : ""].filter(Boolean).join(" ") : `${next.message ?? "I stopped."} You can finish it on the page, or ask me to change an answer.`;
    const tail = chat.lines.at(-1);
    if (tail?.step && next.message && lead.includes(next.message)) {
      const parts = (tail.parts ?? [tail.text]).filter((part) => part !== next.message);
      if (parts.length) {
        tail.parts = parts;
        tail.text = parts.join("\n");
      } else chat.lines.pop();
    }
    const refreshed = await run(state?.appId ?? next.appId ?? null, { quiet: true });
    if (state) {
      state.readiness = next.status === "ready" ? next.readiness ?? null : null;
      state.captchaPending = next.status === "ready" && next.captchaPending === true;
    }
    const agentBased = next.agent_engine === "ai_led";
    const framedNote = next.status === "ready" && !agentBased ? P.readinessNote({ missing: (next.readiness?.missing ?? []).filter((m) => m.framed) }) : "";
    const follow = next.status === "ready" && state ? P.nextPrompt(state.results) : null;
    const bodyText = follow ? followedBy(framedNote ? `${lead} ${framedNote}` : lead, follow) : { text: lead, choices: [] };
    if (lead.trim() || follow) chat.lines.push({ role: "assistant", local: true, ...bodyText });
    panel.agent(true);
    if (refreshed && next.status === "ready" && (next.autoSubmit === true || autoApplyOn) && !next.captchaPending && next.appId === state?.appId) await autoApply();
  }
  async function askAssistant(text) {
    const message = text.trim();
    if (!message || chat.pending) return;
    const finishedChip = agent?.status === "ready" && P.LOCAL_REPLIES.includes(message);
    if (agent && !["failed", "stopped"].includes(agent.status) && !finishedChip) {
      if (agent.status === "waiting" && agent.question?.kind === "question" && (P.isDraftRequest(message) || message === P.ON_PAGE_REPLY || message === P.SKIP_REPLY)) {
        return replyToAgent(message);
      }
      chat.lines.push({ role: "user", text: message });
      chat.draft = "";
      const plainAnswer = agent.status === "waiting" && agent.question?.kind === "question" && P.isPlainAnswer(message);
      await agentControl(plainAnswer ? "reply" : "message", message);
      panel.idle();
      return;
    }
    if (agent?.status === "waiting") return replyToAgent(message);
    if (agentLive() || !state?.ctx) return;
    if (P.isNavigateRequest(message)) {
      chat.lines.push({ role: "user", text: message });
      chat.draft = "";
      return handOff("asked");
    }
    const asked = ([...chat.lines].reverse().find((l) => l.role === "assistant" && !l.step) ?? greeting())?.target;
    const target = P.isDraftRequest(message) ? asked ?? P.promptTarget(state.results) : P.LOCAL_REPLIES.includes(message) ? P.promptTarget(state.results) : null;
    const answer = target ? null : P.directAnswer(asked, message);
    if (target || answer != null) {
      const turn2 = chat;
      const hello2 = turn2.lines.length ? null : greeting();
      if (hello2) turn2.lines.push({ role: "assistant", greeting: true, ...hello2 });
      turn2.lines.push({ role: "user", text: message });
      turn2.draft = "";
      turn2.pending = true;
      panel.idle();
      try {
        const reply = target ? await localReply(message, target) : await directReply(asked, answer);
        if (turn2 !== chat) return;
        turn2.lines.push({ role: "assistant", local: true, ...withNext(reply ?? { text: "Tell me what you'd like to do." }) });
      } finally {
        turn2.pending = false;
        panel.idle();
      }
      return;
    }
    const { fields, current, rows } = P.assistantFields(state.results);
    if (!fields.length) {
      panel.toast("There are no questions on this page the assistant can answer.", { persist: true });
      return;
    }
    const turn = chat;
    const hello = turn.lines.length ? null : greeting();
    if (hello) turn.lines.push({ role: "assistant", greeting: true, ...hello });
    turn.lines.push({ role: "user", text: message });
    turn.draft = "";
    turn.pending = true;
    panel.idle();
    try {
      const res = await send({ type: "assist", appId: state.appId, messages: P.chatHistory(turn.lines), fields, current });
      if (turn !== chat) return;
      const filled = await applyAssistantUpdates(res.updates, rows);
      const moveOn = !P.openQuestions(state.results).length && (res.done || !res.choices?.length);
      const reply = { text: res.reply, filled, warnings: res.warnings ?? [], choices: res.done ? [] : res.choices ?? [], next: moveOn };
      turn.lines.push({ role: "assistant", ...withNext(reply) });
    } catch (err) {
      turn.lines.pop();
      if (turn.lines.length === 1 && turn.lines[0].greeting) turn.lines = [];
      turn.draft = message;
      panel.toast(`Assistant unavailable: ${err?.message}`, { persist: true });
    } finally {
      turn.pending = false;
      panel.idle();
    }
  }
  function answeredNow(field) {
    switch (field.kind) {
      case "checkbox":
        if (field.options?.length) return field.options.some((o) => o.el.checked === true);
        return field.el.checked === true || field.el.getAttribute("aria-checked") === "true";
      case "dropdown":
        return field.phoneFor ? !F.isEmpty(field) : Boolean(F.dropdownValue(field)) && !F.isInvalid(field);
      case "picker":
        if (field.dropzone) return !field.el.isConnected || !field.el.getClientRects().length;
        return ![...field.el.querySelectorAll('[role="button"]')].some(
          (b) => /add file|upload/i.test(b.textContent) && b.getClientRects().length > 0
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
        Object.assign(r, { status: "unresolved", reason: why ? `The site says: \u201C${why}\u201D` : "The site doesn't accept this answer" });
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
      true
    );
  }
  const COLORS = {
    filled: ["#16a34a", "rgba(22,163,74,.12)", "ApplyShortly filled this"],
    check: ["#d97706", "rgba(217,119,6,.14)", "ApplyShortly filled this: please check it"],
    todo: ["#dc2626", "rgba(220,38,38,.10)", "ApplyShortly: this needs your answer"]
  };
  function outlineTarget(field) {
    if (field.kind === "radio" && !field.aria) return field.el.closest("fieldset") ?? field.el;
    return field.el;
  }
  function outline() {
    for (const r of state.results) {
      if (r.status === "optional") continue;
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
  const RECEIPT_ELEMENTS = 'h1, h2, h3, p, div, span, [role="status"], [role="alert"], .alert, .toast';
  function receiptTexts() {
    return [...document.querySelectorAll(RECEIPT_ELEMENTS)].filter((el) => {
      if (!el.getClientRects().length || el.closest("jobhunt-autofill-panel")) return false;
      const text = F.cleanLabel(el.textContent ?? "");
      if (el.matches('.ashby-application-form-success-container[role="status"]') && el.getAttribute("data-highlight") === "positive" && [...el.querySelectorAll("h2")].some((h) => F.cleanLabel(h.textContent) === "Success")) return true;
      return text.length <= 600 && !/\b(not|unable|failed|error|already|cannot|couldn.t)\b/i.test(text) && /\b(?:your application (?:has been |was )?(?:successfully )?(?:submitted|received)|application (?:submitted|received) successfully|thank you for applying|thank you\s*[—–-]\s*our talent team will review your application|we (?:have )?received your application)\b/i.test(text);
    }).map((el) => F.cleanLabel(el.textContent ?? ""));
  }
  const hasReceipt = () => receiptTexts().some((text) => !receiptBaseline.includes(text));
  const reachedConfirmationPage = () => location.href !== attemptUrl && F.confirmationPath(location.href);
  function checkConfirmation() {
    if (!attemptPending || submittedReported) return;
    if (hasReceipt()) void markSubmitted("site confirmed application receipt");
    else if (reachedConfirmationPage()) void markSubmitted("confirmation page");
  }
  new MutationObserver(checkConfirmation).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  async function markSubmitted(note) {
    if (submittedReported || state?.appId == null) return;
    submittedReported = true;
    await report("submitted", note ? { note } : {});
    panel.idle();
  }
  const UPLOAD_WAIT_MS = 5e3;
  const isHidden = (el) => el.getClientRects().length === 0;
  const invalidControls = (form) => [...form.querySelectorAll("input:invalid, select:invalid, textarea:invalid")];
  async function formAccepted(form) {
    for (let waited = 0; !form.checkValidity() && waited < UPLOAD_WAIT_MS && invalidControls(form).every(isHidden); waited += 500) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (form.checkValidity()) return true;
    const bad = invalidControls(form);
    const shown = bad.find((el) => !isHidden(el));
    if (shown) {
      shown.reportValidity();
      const why = shown.validationMessage ? `: ${shown.validationMessage}` : "";
      panel.stop(`Not submitted: the form doesn't accept \u201C${F.labelOf(shown) || "a field"}\u201D yet${why}.`);
      return false;
    }
    const upload = state.results.find((r) => r.field.kind === "file" && r.status === "filled");
    if (upload && bad.some((el) => /resume|cv|file|upload|attach|document/i.test(`${el.name} ${el.id}`))) {
      Object.assign(upload, { status: "unresolved", reason: "The site didn't take the file. Attach it again on the page and wait for the upload to finish" });
      outline();
      panel.stop(`Not submitted: the site hasn't registered your file for \u201C${upload.field.label}\u201D. Attach it again on the page, wait for it to finish uploading, then try again.`);
      return false;
    }
    const names = bad.map((el) => F.labelOf(el) || el.name).filter(Boolean);
    panel.stop(`Not submitted: the site still rejects a field you can't see${names.length ? ` (${names.join(", ")})` : ""}. Check the form on the page, then try again.`);
    return false;
  }
  async function autoApply(unattended = false) {
    if (!state?.ctx || autoSubmitting || submittedReported) return;
    if (P.loginWall(location.pathname, [...document.querySelectorAll("input[type=password]")].some((el) => !isHidden(el)))) {
      return panel.stop("Not submitted: this page needs you to sign in. Sign in, then choose \u201CAuto apply\u201D.");
    }
    recheck();
    const blocked = P.autoApplyBlockers(state.results, state.ctx.app, state.readiness, state.captchaPending);
    if (blocked.length) return panel.stop(`Not submitted: ${blocked.join(". ")}.`);
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
    if (form && !await formAccepted(form)) return;
    if (!await panel.countdown(AUTO_APPLY_DELAY_S)) return panel.toast("Submit cancelled. Nothing was submitted.");
    recheck();
    const currentFields = F.collectFields(document);
    const currentButton = F.findSubmitButton(document, currentFields, { includeDisabled: true });
    if (P.autoApplyBlockers(state.results, state.ctx.app, state.readiness, state.captchaPending).length || currentFields.some((field) => field.required && !answeredNow(field) || F.isInvalid(field)) || currentButton !== button || !button.isConnected || button.disabled || button.getAttribute("aria-disabled") === "true" || form && !form.checkValidity()) {
      return panel.stop("Not submitted: the form changed. Check it and try again.");
    }
    autoSubmitting = true;
    await report("submission_attempted", { note: "auto apply clicked the form's submit button; confirmation not yet detected" });
    if (state.ctx.app) state.ctx.app = { ...state.ctx.app, status: "submission_unconfirmed" };
    button.click();
    void send({ type: "autoApplied" }).catch(() => {
    });
    panel.idle();
    panel.toast("Submission attempted. Check the page for the site's confirmation.");
  }
  function pageCount() {
    try {
      const fields = F.collectFields(document);
      return { total: fields.length, answered: fields.filter((f) => answeredNow(f)).length };
    } catch {
      return null;
    }
  }
  let countTimer = null;
  new MutationObserver(() => {
    if (countTimer || !agent || !["starting", "running"].includes(agent.status) || agent.field_total) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      if (agent && !agent.field_total) panel.agent(false);
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  const ctl = {
    get state() {
      return state;
    },
    get agent() {
      return agent;
    },
    get chat() {
      return chat;
    },
    get submittedReported() {
      return submittedReported;
    },
    get pageCount() {
      return pageCount();
    },
    AUTO_APPLY_DELAY_S,
    agentControl,
    askAssistant,
    autoApply,
    markSubmitted,
    outlineTarget,
    run,
    send
  };
  const panel = globalThis.JobHuntPanelView.create(ctl);
  document.addEventListener(
    "submit",
    (event) => {
      if (autoSubmitting || attemptPending || state?.appId == null || !state.results.length) return;
      const button = F.findSubmitButton(document, state.results.map((r) => r.field)) ?? F.findSubmitButton(document, []);
      if (!button || event.submitter && event.submitter !== button) return;
      void report("submission_attempted", { note: "form submit event; confirmation not yet detected" });
    },
    true
  );
  document.addEventListener("click", (event) => {
    if (autoSubmitting || attemptPending || !state?.results.length || state.appId == null) return;
    const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
    const button = F.findSubmitButton(document, []);
    if (!target || target !== button || target.matches(':disabled, [aria-disabled="true"]')) return;
    if (state.results.some((r) => r.field.required && !answeredNow(r.field) || F.isInvalid(r.field))) return;
    if (target.closest("form")?.querySelector(":invalid")) return;
    void report("submission_attempted", { note: "final submit clicked; confirmation not yet detected" });
  }, true);
  async function startAgent({ autoSubmit = false } = {}) {
    if (agent) chat = newChat();
    agent = { status: "starting", log: [], appId: state?.appId ?? null };
    shownLog = [];
    panel.agent(true);
    try {
      await send({ type: "agentStart", appId: state?.appId ?? null, autoSubmit });
    } catch (err) {
      agent = null;
      const e = P.friendlyError(err?.message, err?.status, state?.ctx?.baseUrl, err?.code);
      chat.lines.push({ role: "assistant", local: true, error: true, text: `I couldn't click through this form: ${e.detail || e.title} You can finish it on the page; I'll keep helping here.` });
      panel.agent(true);
    }
  }
  async function agentControl(action, text) {
    if (action === "reply" && !String(text ?? "").trim()) return;
    try {
      await send({ type: "agentControl", action, text });
    } catch (err) {
      panel.toast(isInvalidated(err) ? RELOAD_TEXT : err?.message, { persist: true });
    }
  }
  async function draftOpen() {
    const before = new Set(state.results.filter((r) => r.status === "filled").map((r) => r.field.el));
    if (!await run(state.appId, { allowGenerate: true })) return;
    const drafted = state.results.filter((r) => r.status === "filled" && !before.has(r.field.el)).map((r) => r.field.label || "answer");
    const next = P.nextPrompt(state.results);
    const lead = drafted.length ? `I drafted ${drafted.length === 1 ? "an answer" : `${drafted.length} answers`} with AI. Read ${drafted.length === 1 ? "it" : "them"} over in the form.` : "I couldn't draft any of the open questions.";
    chat.lines.push({ role: "assistant", local: true, filled: drafted, ...followedBy(lead, next) });
    panel.idle();
  }
  let autoApplyOn = false;
  try {
    void chrome.storage?.local?.get?.("autoApply")?.then?.((v) => {
      autoApplyOn = v?.autoApply === true;
    });
  } catch {
  }
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if ("aiDrafts" in changes && state?.ctx) {
      state.ctx.aiDrafts = changes.aiDrafts.newValue !== false;
      if (state.ctx.aiDrafts && !agentLive() && !chat.pending && state.results.some((r) => ["unresolved", "optional"].includes(r.status) && P.draftable(r.field))) void draftOpen();
    }
    if ("autoApply" in changes) {
      autoApplyOn = changes.autoApply.newValue === true;
      if (!autoApplyOn) return panel.cancelCountdown?.();
      const idle = state?.ctx && !chat.pending && !agentLive() && (!agent || agent.status === "ready");
      if (idle && state.results.length && !submittedReported) void autoApply();
    }
  });
  async function start(appId, opts = {}) {
    panel.setRetry(appId);
    await panel.restore(opts);
    if (!await run(appId) || agentLive()) return;
    if (state?.ctx.agentAvailable && !opts.unattended) return startAgent(opts);
    const reason = handedOff ? null : P.navigationNeeded(pageShape());
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
      agent = msg;
      void agentChanged(previous, msg);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "assistantUpdate") {
      panel.assistant({ submissionState: msg.submissionState, assistantName: typeof msg.assistantName === "string" ? msg.assistantName : null, active: msg.active === true, paused: msg.paused === true, steps: Array.isArray(msg.steps) ? msg.steps : [], notes: Array.isArray(msg.notes) ? msg.notes : [] });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "run") {
      if (state && state.appId !== (msg.appId ?? null)) {
        state = null;
        chat = newChat();
      }
      void start(msg.appId ?? null, { show: true, autoSubmit: msg.autoSubmit === true, unattended: msg.unattended === true });
      sendResponse({ ok: true });
    }
  });
  async function boot() {
    let hello;
    try {
      hello = await send({ type: "hello", url: location.href });
    } catch {
      return;
    }
    if (hello.mode === "idle") return;
    if (hello.mode === "agent") {
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
    await new Promise((r) => setTimeout(r, 800));
    await start(hello.appId, { autoSubmit: hello.autoSubmit === true, unattended: hello.unattended === true });
  }
  let sessionMark;
  function followWebsiteSession() {
    const mark = document.documentElement.dataset.applyshortlySession;
    if (!mark || mark === sessionMark) return;
    sessionMark = mark;
    send({ type: "webSession", signedIn: mark === "signed-in" }).catch(() => {
    });
  }
  new MutationObserver(followWebsiteSession).observe(document.documentElement, { attributes: true, attributeFilter: ["data-applyshortly-session"] });
  followWebsiteSession();
  void boot();
})();
