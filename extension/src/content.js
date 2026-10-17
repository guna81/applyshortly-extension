// Runs on every page but stays idle unless the page was opened with #jobhunt-autofill=<id>,
// is a later page of a form already being filled in this tab, or the popup says "Autofill".
// It fills and reports; it never submits. The user clicks the site's own submit button.

(() => {
  if (globalThis.__jobhuntContentLoaded) return;
  globalThis.__jobhuntContentLoaded = true;

  const F = globalThis.JobHuntFill;
  const P = globalThis.JobHuntPanel;
  let state = null; // {appId, ctx, resume, results}
  let submittedReported = false;

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) {
          const err = new Error(res?.error ?? "No response from the extension");
          err.status = res?.status;
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
  function applyAnswer(field, answer) {
    if (!answer) {
      return field.required ? { field, status: "unresolved", reason: "Not in your profile or answer bank yet" } : null;
    }
    if (field.kind === "dropdown") {
      return { field, status: "unresolved", reason: `Pick “${answer.value}” from the list`, suggestion: answer.value };
    }
    const written = F.apply(field, answer.value);
    if (written === null) {
      return { field, status: "unresolved", reason: `None of the options match “${answer.value}”`, suggestion: answer.value };
    }
    return { field, status: "filled", value: written, source: answer.source, needsReview: answer.needsReview };
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
          results.push({ field, status: "unresolved", reason: "Tick it yourself if you agree" });
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
      const row = applyAnswer(field, answerFor.get(field));
      if (row) results.push(row);
    }
    return results;
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
        await report("opened");
      }
      const generate = allowGenerate ?? state.ctx.aiDrafts;
      panel.busy(generate ? "Drafting answers with AI… this can take a few seconds" : "Matching your answers to the form…");
      state.results = merge(state.results, await fillAll({ allowGenerate: generate }));
      outline();
      await reportFilled();
      panel.idle();
    } catch (err) {
      panel.fail(err);
      await report("failed", { note: err.message });
    }
  }

  /** Per-row "Draft with AI": one field only. */
  async function draftOne(row) {
    row.drafting = true;
    panel.idle();
    const answer = await resolveAnswer(row.field, true);
    row.drafting = false;
    const next = answer ? applyAnswer(row.field, answer) : null;
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

  // ------------------------------------------------------------------ live re-check

  /** Whether the user has answered a field, by looking at the page as it is now. */
  function answeredNow(field) {
    switch (field.kind) {
      case "checkbox":
        return field.el.checked === true || field.el.getAttribute("aria-checked") === "true";
      case "dropdown": {
        const sel = field.el.querySelector('[role="option"][aria-selected="true"]');
        if (!sel) return false;
        const value = sel.getAttribute("data-value") ?? sel.textContent.trim();
        return Boolean(value) && !/^choose$/i.test(sel.textContent.trim());
      }
      case "picker": // Google Forms hides "Add file" once the file is attached
        return ![...field.el.querySelectorAll('[role="button"]')].some(
          (b) => /add file|upload/i.test(b.textContent) && b.getClientRects().length > 0,
        );
      default:
        return !F.isEmpty(field);
    }
  }

  function currentValue(field) {
    if (field.kind === "text") return field.el.value;
    if (field.kind === "select") return field.el.selectedOptions[0]?.text ?? "";
    return null;
  }

  /** Ticks off what the user answered by hand, without another fill pass. */
  function recheck() {
    if (!state?.results.length) return;
    let changed = false;
    for (const r of state.results) {
      if (r.status === "unresolved" && answeredNow(r.field)) {
        Object.assign(r, { status: "done", source: "you", value: currentValue(r.field) });
        changed = true;
      } else if (r.status === "done" && !r.manual && !answeredNow(r.field)) {
        r.status = "unresolved";
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
      open: { todo: true, check: true, filled: false },
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
      .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 380px;
        max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); display: flex; flex-direction: column;
        background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
        box-shadow: 0 18px 48px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.08); overflow: hidden;
        animation: in .18s ease-out; }
      @keyframes in { from { opacity: 0; transform: translateY(8px); } }
      .h { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 14px; }
      .mark { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
        /* Embedded from icons/logo.svg so the panel needs no exposed extension resources. */
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
      .body { overflow: auto; border-top: 1px solid var(--line); padding: 10px 12px 12px; }
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
      button.b.ghost { border-color: transparent; background: transparent; color: var(--accent); padding: 5px 6px; }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .f { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); align-items: center; }
      .f .grow { flex: 1; }
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
      .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
        padding: 6px 14px 6px 6px; border-radius: 99px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
        box-shadow: 0 8px 24px rgba(0,0,0,.18); cursor: pointer; font: inherit; font-weight: 600; animation: in .15s ease-out; }
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
      view.minimized = value;
      chrome.runtime.sendMessage({ type: "panelPreference", minimized: value }).catch(() => {});
      render();
    }

    function header(title, subtitle) {
      return el("div", { class: "h" },
        el("div", { class: "mark", "aria-hidden": "true" }),
        el("div", { class: "t" }, el("b", { title }, title), subtitle ? el("small", { title: subtitle }, subtitle) : null),
        el("button", { class: "icon", type: "button", title: "Minimise (Esc)", "aria-label": "Minimise", onclick: () => setMinimized(true) }, "–"),
        el("button", { class: "icon", type: "button", title: "Close", "aria-label": "Close", onclick: () => host.remove() }, "×"),
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

    function render() {
      ensure();
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
          class: "pill", type: "button", title: "Open ApplyShortly autofill",
          onclick: () => setMinimized(false),
        }, el("span", { class: "mark", "aria-hidden": "true" }), "ApplyShortly",
          view.busy ? el("span", { class: "spin" }) : el("span", { class: `badge ${summary.todo ? "" : "ok"}` }, badge)));
        root.replaceChildren(el("style", {}, css), wrap);
        return;
      }

      const p = el("div", { class: "p", role: "dialog", "aria-label": "ApplyShortly autofill" });
      p.addEventListener("keydown", (e) => { if (e.key === "Escape") setMinimized(true); });
      p.append(header(title, subtitle));

      if (view.busy) {
        p.append(el("div", { class: "busy", role: "status" }, el("span", { class: "spin" }), view.busy));
      } else if (view.error) {
        const e = view.error;
        const action = {
          settings: btn("Open settings", () => void send({ type: "openOptions" }), "primary"),
          reload: btn("Reload page", () => location.reload(), "primary"),
          retry: btn("Try again", () => { view.error = null; void run(state?.appId ?? retryAppId); }, "primary"),
        }[e.action];
        p.append(el("div", { class: "body" },
          el("div", { class: "msg bad", role: "alert" }, el("b", {}, e.title), el("p", {}, e.detail), action)));
      } else if (state?.ctx || submittedReported) {
        const full = submittedReported || summary.progress >= 1;
        p.append(el("div", { class: "hero" },
          el("strong", {}, summary.headline),
          el("div", { class: `bar ${full ? "full" : ""}`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(summary.total), "aria-valuenow": String(summary.answered) },
            el("i", { style: `width:${full ? 100 : Math.round(summary.progress * 100)}%` })),
          el("div", { class: "meta" }, submittedReported ? "Tracked in ApplyShortly" : summary.total ? `${summary.answered} of ${summary.total} answered` : "Try again once the form has loaded"),
        ));

        const body = el("div", { class: "body" });
        if (submittedReported) {
          body.append(el("div", { class: "msg good" },
            el("b", {}, "Saved in ApplyShortly"),
            el("p", {}, state.appId != null ? "This application is now marked Submitted. Good luck!" : "Done."),
            state.ctx?.baseUrl ? btn("Open ApplyShortly", () => window.open(`${state.ctx.baseUrl}/apply-queue`, "_blank"), "primary") : null,
          ));
        } else {
          body.append(stepsList(summary, results));
          const todo = results.filter((r) => r.status === "unresolved");
          const check = results.filter((r) => r.status === "filled" && r.needsReview && !r.reviewed);
          const ok = results.filter((r) => !todo.includes(r) && !check.includes(r));
          if (!results.length) body.append(el("div", { class: "empty" }, "No form fields found yet. If the form is still loading, click Fill again."));
          body.append(
            el("div", {}, section("todo", "Needs you", todo, todoRow)),
            el("div", {}, section("check", "Double-check", check, checkRow)),
            el("div", {}, section("filled", "Filled", ok, okRow)),
          );
        }
        p.append(body);
        queueMicrotask(() => { body.scrollTop = prevScroll; });

        if (view.toast) p.append(el("div", { class: "toast", role: "status" }, view.toast));

        if (!submittedReported) {
          const draftable = results.filter((r) => r.status === "unresolved" && r.field.kind === "text").length;
          p.append(el("div", { class: "f" },
            btn("↻ Fill again", () => run(state.appId, { allowGenerate: false }), "", { title: "Fill fields that are still empty. Your edits are kept." }),
            el("span", { class: "grow" }),
            draftable ? btn(`✨ Draft ${draftable} with AI`, () => run(state.appId, { allowGenerate: true }), "primary", { title: "Uses AI credits. Drafts are marked Check." }) : null,
          ));
        }
      }

      wrap.append(p);
      root.replaceChildren(el("style", {}, css), wrap);
    }

    let retryAppId = null;
    return {
      render,
      toast,
      busy(text) { Object.assign(view, { busy: text, error: null }); render(); },
      idle() { view.busy = null; render(); },
      fail(err) {
        view.busy = null;
        view.error = P.friendlyError(err.message, err.status, state?.ctx?.baseUrl);
        render();
      },
      setRetry(appId) { retryAppId = appId; },
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
      if (state?.appId != null && state.results.length) void report("submission_attempted", { note: "form submit event; confirmation not yet detected" });
    },
    true,
  );

  async function start(appId, opts) {
    panel.setRetry(appId);
    await panel.restore(opts);
    await run(appId);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg?.type === "pageInfo" && window === window.top) {
      // Only on request from the side panel, which is opt-in; the fragment is left out.
      sendResponse({ url: location.href.split("#")[0], title: document.title });
      return;
    }
    if (msg?.type === "run") {
      // Same application: keep what's been filled and answered; another one starts over.
      if (state && state.appId !== (msg.appId ?? null)) state = null;
      void start(msg.appId ?? null, { show: true });
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

  void boot();
})();
