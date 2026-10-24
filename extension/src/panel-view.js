// The autofill panel on the page, drawn in a closed shadow DOM. content.js owns the filling
// and its state; the panel reads that state through `ctl` and calls back for every action.

(() => {
  if (globalThis.JobHuntPanelView) return;
  const P = globalThis.JobHuntPanel;

  /**
   * @typedef {object} PanelController what content.js shares with the panel
   * @property {any} state the page's fill: {appId, ctx, resume, results}, or null
   * @property {any} agent the form agent's latest update for this tab, or null
   * @property {{lines: any[], draft: string, pending: boolean}} chat the assistant's conversation
   * @property {boolean} submittedReported
   * @property {number} AUTO_APPLY_DELAY_S
   * @property {(...args: any[]) => any} agentControl
   * @property {(...args: any[]) => any} askAssistant
   * @property {(...args: any[]) => any} autoApply
   * @property {(...args: any[]) => any} markSubmitted
   * @property {(...args: any[]) => any} outlineTarget
   * @property {(...args: any[]) => any} run
   * @property {(...args: any[]) => any} send
   */

  /** @param {PanelController} ctl */
  function create(ctl) {
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
      chatSeen: "",
    };
    let toastTimer = 0;

    const css = `
      :host { all: initial; }
      .wrap {
        --bg: #ffffff; --fg: #18181b; --muted: #6b7280; --line: #e5e7eb; --soft: #f4f4f6; --hover: #ececf1;
        --accent: #078651; --accent-soft: #ecfdf5; --accent-fg: #ffffff; --good: #15803d; --good-soft: #dcfce7;
        --warn: #b45309; --warn-soft: #fef3c7; --bad: #b91c1c; --bad-soft: #fee2e2;
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      }
      @media (prefers-color-scheme: dark) {
        .wrap {
          --bg: #17181e; --fg: #ececf1; --muted: #9ca3af; --line: #2c2d36; --soft: #20212a; --hover: #2a2b35;
          --accent: #34d399; --accent-soft: #064e3b88; --accent-fg: #052e1f; --good: #86efac; --good-soft: #14532d55;
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
        background: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%0A%20%20%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%23059669%22%2F%3E%0A%20%20%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%0A%20%20%20%20%3Cpath%20d%3D%22M8%2024%2015%208h2l4%209%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M12%2019h13m-4-4%204%204-4%204%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%3C%2Fsvg%3E%0A") center / contain no-repeat; }
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
      .chip { flex: none; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; background: var(--bg);
        color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
      .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      button.b { font: inherit; font-size: 12.5px; border-radius: 8px; padding: 5px 10px; border: 1px solid var(--line);
        background: var(--bg); color: var(--fg); cursor: pointer; white-space: nowrap; }
      button.b:hover:not(:disabled) { background: var(--hover); }
      button.b:disabled { opacity: .6; cursor: default; }
      button.b.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
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
      .chat { display: flex; flex-direction: column; gap: 8px; min-height: 140px; }
      .bubble { max-width: 88%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
      .bubble.user { align-self: flex-end; background: var(--accent); color: var(--accent-fg); border-bottom-right-radius: 4px; }
      .bubble.assistant { width: fit-content; max-width: 100%; box-sizing: border-box; background: var(--soft); border-top-left-radius: 4px; }
      .turn { display: flex; align-items: flex-start; gap: 8px; }
      .avatar { flex: none; display: grid; place-items: center; width: 24px; height: 24px; margin-top: 2px; border-radius: 50%;
        background: var(--accent-soft); color: var(--accent); }
      .avatar svg { width: 14px; height: 14px; }
      .said { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      .said .filled { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
      .said .filled li { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .said .filled li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .said .filled svg { flex: none; width: 14px; height: 14px; color: var(--good); }
      .question { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-left: 2px solid var(--accent);
        border-radius: 8px; background: var(--soft); }
      .question p { margin: 0; word-break: break-word; }
      .question .step { font-size: 11px; font-weight: 600; color: var(--muted); }
      .question .label { font-weight: 600; }
      .question .note { font-size: 12px; color: var(--muted); }
      .question .quick { padding-top: 4px; }
      .said .warn { margin: 0; color: var(--bad); font-size: 12px; }
      .quick { display: flex; flex-wrap: wrap; gap: 6px; }
      .quick button { font: inherit; font-size: 12.5px; border-radius: 99px; padding: 4px 11px; cursor: pointer;
        border: 1px solid var(--accent); color: var(--accent); background: var(--bg); }
      .quick button:hover:not(:disabled) { background: var(--accent-soft); }
      .quick button:disabled { opacity: .6; cursor: default; }
      .thinking { align-self: flex-start; padding-left: 32px; display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 13px; }
      .thinking .spin { width: 14px; height: 14px; }
      .composer { padding: 10px 12px; border-top: 1px solid var(--line); }
      /* The input and its Send button share one box, so they line up whatever the text's height. */
      .composer .box { display: flex; align-items: flex-end; gap: 6px; padding: 4px 4px 4px 10px;
        border: 1px solid var(--line); border-radius: 12px; background: var(--bg); }
      .composer .box:focus-within { outline: 2px solid var(--accent); outline-offset: -1px; }
      .composer textarea { flex: 1; box-sizing: border-box; min-height: 32px; max-height: 120px; margin: 0; padding: 6px 0;
        resize: none; border: 0; outline: none; background: transparent; color: var(--fg); font: inherit; font-size: 13.5px; line-height: 20px; }
      .composer .send { flex: none; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border-radius: 8px; }
      .composer .send svg { width: 16px; height: 16px; }
      .composer .hint { display: block; color: var(--muted); font-size: 11px; margin: 6px 2px 0; }
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
      const target = ctl.outlineTarget(field);
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      if (field.kind === "text" || field.kind === "select") field.el.focus({ preventScroll: true });
      target.animate?.(
        [{ boxShadow: "0 0 0 0 rgba(7,134,81,.6)" }, { boxShadow: "0 0 0 14px rgba(7,134,81,0)" }],
        { duration: 900, iterations: 2, delay: 250 },
      );
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

    // The chat is the agent: while it clicks through the form, its steps and questions show here.
    const AGENT_HEADLINE = {
      starting: "Getting started…",
      running: "Working through the form…",
      waiting: "Needs you",
      paused: "Paused",
    };
    const AGENT_LIVE = ["starting", "running", "waiting", "paused"];
    const agentLive = () => Boolean(ctl.agent && AGENT_LIVE.includes(ctl.agent.status));
    const agentBusy = () => agentLive() && ctl.agent.status !== "waiting";

    function agentHero() {
      return el("div", { class: "hero" },
        el("strong", {}, AGENT_HEADLINE[ctl.agent.status] ?? AGENT_HEADLINE.running),
        el("div", { class: "meta" }, agentBusy() ? "I'll ask here when I need you. You still submit." : "Answer below, and I'll carry on."));
    }

    /** While it clicks through: the latest step. Afterwards: what it did, folded away. */
    function agentActivity() {
      if (!ctl.agent) return null;
      const steps = ctl.agent.log ?? [];
      if (agentBusy()) {
        return el("div", { class: "thinking", role: "status" }, el("span", { class: "spin" }), ctl.agent.status === "paused" ? "Paused." : steps.at(-1) ?? "Working…");
      }
      if (agentLive() || !steps.length) return null;
      const log = el("ul", { class: "alog" });
      for (const line of steps.slice(-14)) log.append(el("li", {}, line));
      const review = (ctl.agent.filled ?? []).filter((f) => f.needs_review);
      return el("div", { class: "activity" },
        review.length ? el("div", { class: "filled" }, "Double-check:", review.map((f) => el("span", { class: "chip", title: `${f.label}: ${f.value}` }, f.label.length > 40 ? `${f.label.slice(0, 40)}…` : f.label))) : null,
        el("details", {}, el("summary", {}, "What I did on the page"), log));
    }

    function agentControls() {
      return el("div", { class: "f" },
        ctl.agent.status === "paused"
          ? btn("Resume", () => void ctl.agentControl("resume"), "primary")
          : ctl.agent.status === "waiting" ? null : btn("Pause", () => void ctl.agentControl("pause"), ""),
        el("span", { class: "grow" }),
        btn("Stop and take over", () => void ctl.agentControl("stop"), "ghost"));
    }

    function chatView(results) {
      const greeting = ctl.state?.ctx ? [{ role: "assistant", greeting: true, ...P.assistantGreeting(results) }] : [];
      const lines = ctl.chat.lines.length ? ctl.chat.lines : greeting;
      const log = el("div", { class: "chat", "aria-live": "polite" });
      lines.forEach((line, i) => {
        if (line.role === "user") return void log.append(el("div", { class: "bubble user" }, line.text));
        // Like the website's chat: a bot avatar, the message, what it filled, then the question it asks.
        const q = line.question;
        const quick = i === lines.length - 1 && line.choices?.length
          ? el("div", { class: "quick", role: "group", "aria-label": "Quick replies" },
            line.choices.map((c) => el("button", { type: "button", disabled: ctl.chat.pending || agentBusy(), onclick: () => void ctl.askAssistant(c) }, c)))
          : null;
        log.append(el("div", { class: "turn" },
          el("span", { class: "avatar" }, icon(BOT)),
          el("div", { class: "said" },
            line.text ? el("div", { class: "bubble assistant" }, line.text) : null,
            line.filled?.length ? el("ul", { class: "filled", "aria-label": "Filled" }, line.filled.map((f) => el("li", { title: f }, icon(CHECK), el("span", {}, f)))) : null,
            q ? el("div", { class: "question" },
              q.step ? el("p", { class: "step" }, q.step) : null,
              el("p", { class: "label" }, q.label),
              q.note ? el("p", { class: "note" }, q.note) : null,
              quick) : quick,
            line.warnings?.map((w) => el("p", { class: "warn" }, w)))));
      });
      if (ctl.chat.pending) log.append(el("div", { class: "thinking", role: "status" }, el("span", { class: "spin" }), "Thinking…"));
      else { const activity = agentActivity(); if (activity) log.append(activity); }
      return log;
    }

    // Lucide icons, as on the website's chat.
    const SEND = ["M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
      "m21.854 2.147-10.94 10.939"];
    const BOT = ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"];
    const CHECK = ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z", "m9 12 2 2 4-4"];

    /** @param {string[]} paths */
    function icon(paths) {
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
        "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
      for (const d of paths) {
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d);
        svg.append(path);
      }
      return svg;
    }

    function composer() {
      const busy = agentBusy();
      const input = el("textarea", {
        class: "composer-input", rows: "1", "aria-label": "Message the agent", disabled: busy,
        placeholder: busy ? "Working on the form… I'll ask here when I need you." : ctl.agent?.status === "waiting" ? "Type your answer…" : "Type your answer, or ask to change one…",
      });
      input.value = ctl.chat.draft;
      const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
      input.addEventListener("input", () => { ctl.chat.draft = input.value; grow(); });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // keep the job site's own shortcuts out of the chat box
        if (e.key === "Escape") setMinimized(true);
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ctl.askAssistant(input.value); }
      });
      queueMicrotask(grow);
      return el("div", { class: "composer" },
        el("div", { class: "box" }, input,
          btn(icon(SEND), () => void ctl.askAssistant(input.value), "primary send", { disabled: ctl.chat.pending || busy, "aria-label": "Send", title: "Send" })),
        el("small", { class: "hint" }, "Answering my questions is free. Drafts and other changes use AI credits."),
      );
    }

    // The stylesheet stays in place between renders; only the content is swapped, so nothing
    // restyles or flashes between updates.
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
      const app = ctl.state?.ctx?.app;
      const results = ctl.state?.results ?? [];
      const summary = P.summarize(results, { submitted: ctl.submittedReported });
      const title = app?.title || document.title || "ApplyShortly autofill";
      const subtitle = [app?.company_name, ctl.state && ctl.state.appId == null ? "Not tracked in ApplyShortly" : null]
        .filter(Boolean).join(" · ");

      const wrap = el("div", { class: "wrap" });

      if (view.minimized) {
        const badge = ctl.submittedReported ? "Submitted ✓" : summary.todo ? `${summary.todo} to do` : "All set";
        wrap.append(el("button", {
          class: root.querySelector(".pill") ? "pill" : "pill enter", type: "button", title: "Open ApplyShortly autofill",
          onclick: () => setMinimized(false),
        }, el("span", { class: "mark", "aria-hidden": "true" }), "ApplyShortly",
          view.busy ? el("span", { class: "spin" }) : el("span", { class: `badge ${summary.todo ? "" : "ok"}` }, badge)));
        mount(wrap);
        return;
      }

      // Slide in only when the panel appears, not on every re-render (agent updates, typing).
      const entering = !root.querySelector(".p");
      const p = el("div", { class: entering ? "p enter" : "p", role: "dialog", "aria-label": "ApplyShortly autofill" });
      p.addEventListener("keydown", (e) => { if (e.key === "Escape") setMinimized(true); });
      p.append(header(title, subtitle));

      if (view.busy) {
        p.append(el("div", { class: "busy", role: "status" }, el("span", { class: "spin" }), view.busy));
      } else if (view.error) {
        const e = view.error;
        const retry = (kind) => btn("Try again", () => { view.error = null; void ctl.run(ctl.state?.appId ?? retryAppId); }, kind);
        const action = {
          settings: btn("Open settings", () => void ctl.send({ type: "openOptions" }), "primary"),
          reload: btn("Reload page", () => location.reload(), "primary"),
          retry: retry("primary"),
          profile: el("div", { class: "acts" }, btn("Set up profile", () => void ctl.send({ type: "openProfile" }).catch(() => {}), "primary"), retry("")),
        }[e.action];
        p.append(el("div", { class: "body" },
          el("div", { class: "msg bad", role: "alert" }, el("b", {}, e.title), el("p", {}, e.detail), action)));
      } else if (ctl.state?.ctx || ctl.submittedReported || ctl.agent) {
        const working = agentLive();
        const full = ctl.submittedReported || summary.progress >= 1;
        if (working && !ctl.submittedReported) p.append(agentHero());
        else p.append(el("div", { class: "hero" },
          el("strong", {}, summary.headline),
          el("div", { class: `bar ${full ? "full" : ""}`, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(summary.total), "aria-valuenow": String(summary.answered) },
            el("i", { style: `width:${full ? 100 : Math.round(summary.progress * 100)}%` })),
          el("div", { class: "meta" }, ctl.submittedReported ? "Tracked in ApplyShortly" : summary.total ? `${summary.answered} of ${summary.total} answered` : "Try again once the form has loaded"),
        ));

        const body = el("div", { class: "body" });
        if (ctl.submittedReported) {
          body.append(el("div", { class: "msg good" },
            el("b", {}, "Saved in ApplyShortly"),
            el("p", {}, ctl.state.appId != null ? "This application is now marked Submitted. Good luck!" : "Done."),
            ctl.state.ctx?.baseUrl ? btn("Open ApplyShortly", () => window.open(`${ctl.state.ctx.baseUrl}/apply-queue`, "_blank"), "primary") : null,
          ));
        } else {
          body.append(chatView(results));
        }
        p.append(body);
        // A reply replacing "Thinking…" counts as new, so the chat scrolls to show all of it.
        const seen = `${ctl.chat.lines.length}:${ctl.chat.pending}`;
        const newLines = working || (!ctl.submittedReported && seen !== view.chatSeen);
        if (!ctl.submittedReported) view.chatSeen = seen;
        queueMicrotask(() => { body.scrollTop = newLines ? body.scrollHeight : prevScroll; });

        if (view.toast) p.append(el("div", { class: "toast", role: "status" }, view.toast));

        // Submit is in the footer (not while the agent is working). It runs the guarded flow: refuses and says why unless every required
        // answer is in, then clicks the form's own Submit after a countdown the user can cancel.
        const submit = () => {
          const blockers = P.autoApplyBlockers(results, ctl.state.ctx.app);
          // Enabled only when every required answer is in; the tooltip says what's missing.
          return btn("Submit for me", () => void ctl.autoApply(), "primary", {
            disabled: blockers.length > 0,
            title: blockers.length
              ? `Not ready: ${blockers.join(". ")}.`
              : `Clicks the form's Submit button for you after a ${ctl.AUTO_APPLY_DELAY_S}-second countdown.`,
          });
        };
        const countdown = () => el("div", { class: "f", role: "alert" },
          el("span", { class: "grow" }, `Submitting in ${view.countdown.left}s…`),
          btn("Cancel", view.countdown.cancel, "primary"),
        );
        // Sites where the confirmation can't be detected: the user says it was sent.
        const confirmSubmitted = () => el("div", { class: "f" },
          el("span", { class: "grow meta" }, "Did you submit it?"),
          btn("Yes, I submitted it", () => { view.confirmSubmit = false; void ctl.markSubmitted("marked from the extension panel"); }, "primary"),
          btn("Not yet", () => { view.confirmSubmit = false; render(); }, "ghost"));
        if (working) {
          p.append(composer(), agentControls());
        } else if (!ctl.submittedReported && ctl.state?.ctx) {
          if (view.countdown) p.append(countdown());
          p.append(composer());
          if (view.confirmSubmit) p.append(confirmSubmitted());
          else if (!view.countdown) p.append(el("div", { class: "f" }, el("span", { class: "grow" }),
            ctl.state.appId != null ? btn("I already submitted it", () => { view.confirmSubmit = true; render(); }, "ghost") : null,
            submit()));
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
        view.error = P.friendlyError(err.message, err.status, ctl.state?.ctx?.baseUrl, err.code);
        render();
      },
      setRetry(appId) { retryAppId = appId; },
      /** Shows the agent's latest update. */
      agent(show) {
        if (show) Object.assign(view, { minimized: false, busy: null, error: null });
        render();
      },
      /** Shows the panel with a message, e.g. why Auto apply didn't submit. */
      stop(text) {
        view.minimized = false;
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
          Object.assign(view, { countdown: c, minimized: false });
          render();
        });
      },
      focus: focusField,
      async restore({ show = false } = {}) {
        if (show) view.minimized = false;
        else view.minimized = Boolean((await chrome.runtime.sendMessage({ type: "panelPreference" }).catch(() => ({}))).data);
      },
    };
  }

  globalThis.JobHuntPanelView = { create };
})();
