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
   * @property {{total: number, answered: number} | null} [pageCount]
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
    const view: any = {
      busy: null,
      error: null,
      toast: null,
      minimized: false,
      launcher: false,
      confirmSubmit: false,
      autoApply: false, // the two switches under the chat; kept in storage so the settings page and every tab agree
      aiDrafts: true,
      fillOptional: true, // the third switch: off leaves optional fields to the person
      countdown: null, // {left, cancel} while Submit waits to click the form's button
      chatSeen: "",
    };
    let toastTimer = 0;
    let watchingTheme = false;

    const css = `
      :host { all: initial; }
      :host::backdrop { display: none !important; }
      .wrap {
        color-scheme: light dark;
        --bg: light-dark(#ffffff, #17181e);
        --fg: light-dark(#18181b, #ececf1);
        --muted: light-dark(#6b7280, #9ca3af);
        --line: light-dark(#e5e7eb, #2c2d36);
        --soft: light-dark(#f4f4f6, #20212a);
        --hover: light-dark(#ececf1, #2a2b35);
        --accent: light-dark(#078651, #34d399);
        --accent-soft: light-dark(#ecfdf5, #064e3b88);
        --accent-fg: light-dark(#ffffff, #052e1f);
        --good: light-dark(#15803d, #86efac);
        --good-soft: light-dark(#dcfce7, #14532d55);
        --warn: light-dark(#b45309, #fcd34d);
        --warn-soft: light-dark(#fef3c7, #78350f66);
        --bad: light-dark(#b91c1c, #fca5a5);
        --bad-soft: light-dark(#fee2e2, #7f1d1d55);
        --badge-bad: #b91c1c; --badge-ok: #15803d;
        font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
      }
      .wrap[data-theme="light"] { color-scheme: light; }
      .wrap[data-theme="dark"] { color-scheme: dark; }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
        .spin { animation: none; border-top-color: var(--line); border-right-color: var(--accent); }
      }
      @media (forced-colors: active) {
        .p { border: 1px solid CanvasText; }
        .bar i { forced-color-adjust: none; }
      }
      .p, .pill, .launcher { pointer-events: auto; }
      :host([data-applyshortly-executing]) .p, :host([data-applyshortly-executing]) .pill, :host([data-applyshortly-executing]) .launcher { pointer-events: none; }
      .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 380px;
        max-width: calc(100vw - 32px); height: min(680px, calc(100vh - 32px)); min-height: 0; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
        background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
        box-shadow: 0 18px 48px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.08); overflow: hidden;
        }
      .p > :not(.body) { flex-shrink: 0; }
      .p.enter { animation: in .18s ease-out; }
      @keyframes in { from { opacity: 0; transform: translateY(8px); } }
      .h { display: flex; align-items: center; gap: 10px; padding: 12px 12px 10px 14px; cursor: grab; touch-action: none; user-select: none; }
      .h.dragging { cursor: grabbing; }
      .h button { cursor: pointer; }
      .mark { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
        /* Embedded from frontend/public/favicon.svg so the panel needs no exposed extension resources. */
        background: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%0A%20%20%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%227%22%20fill%3D%22%23059669%22%2F%3E%0A%20%20%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-width%3D%223.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%0A%20%20%20%20%3Cpath%20d%3D%22M8%2024%2015%208h2l4%209%22%2F%3E%0A%20%20%20%20%3Cpath%20d%3D%22M12%2019h13m-4-4%204%204-4%204%22%2F%3E%0A%20%20%3C%2Fg%3E%0A%3C%2Fsvg%3E%0A") center / contain no-repeat; }
      .t { flex: 1; min-width: 0; }
      .t b { display: block; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t small { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .icon { border: 0; background: transparent; color: var(--muted); width: 36px; height: 36px; border-radius: 8px;
        font-size: 18px; line-height: 1; cursor: pointer; display: grid; place-items: center; padding: 0; }
      .icon:hover { background: var(--soft); color: var(--fg); }
      .hero { padding: 0 14px 12px; }
      .hero strong { display: block; font-size: 15px; }
      .bar { height: 6px; border-radius: 99px; background: var(--soft); margin: 8px 0 4px; overflow: hidden; }
      .bar i { display: block; height: 100%; border-radius: 99px; background: var(--accent); transition: width .3s; }
      .bar.full i { background: var(--good); }
      .meta { color: var(--muted); font-size: 12px; }
      .body { flex: 1 1 auto; min-height: 0; overflow: auto; border-top: 1px solid var(--line); padding: 10px 12px 12px; }
      .chip { flex: none; font-size: 12px; padding: 1px 7px; border-radius: 99px; background: var(--bg);
        color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
      .recheck { margin: 0 0 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--soft); }
      .recheck-h { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
      .recheck-chips { display: flex; flex-wrap: wrap; gap: 5px; }
      .recheck-chips .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
      .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      button.b { font: inherit; font-size: 12.5px; border-radius: 8px; padding: 5px 10px; border: 1px solid var(--line);
        background: var(--bg); color: var(--fg); cursor: pointer; white-space: nowrap; }
      button.b:hover:not(:disabled) { background: var(--hover); }
      button.b:disabled { opacity: .6; cursor: default; }
      button.b.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
      button.b.primary:hover { filter: brightness(1.08); background: var(--accent); }
      button.b:disabled { opacity: 1; cursor: not-allowed; filter: none; }
      button.b.primary:disabled { background: var(--soft); border-color: var(--line); color: var(--muted); }
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
        font-size: 13px; animation: in .15s ease-out; display: flex; gap: 8px; align-items: flex-start; }
      .toast .grow { flex: 1; min-width: 0; }
      .toast.sticky { border-left: 4px solid var(--warn); }
      .toast button.b { color: inherit; border-color: transparent; text-decoration: underline; padding: 0 4px; }
      .toast button.b:hover:not(:disabled) { background: transparent; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .p:focus { outline: none; }
      .p.left, .pill.left { right: auto; left: 16px; }
      .p.compact { width: 340px; height: auto; min-height: 0; }
      .p.compact .body, .p.compact .composer { display: none; }
      .icon svg { width: 18px; height: 18px; }
      .why { padding: 8px 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
      .f.counting { background: var(--warn-soft); }
      .f.counting .cd { font-weight: 600; color: var(--warn); }
      .chat { display: flex; flex-direction: column; gap: 8px; min-height: 140px; }
      .bubble { max-width: 88%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
      .bubble.assistant { white-space: normal; display: flex; flex-direction: column; gap: 8px; }
      .bubble.assistant p { margin: 0; }
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
      .bubble.assistant.question { gap: 4px; }
      .question p { margin: 0; word-break: break-word; }
      .question .step { font-size: 11px; font-weight: 600; color: var(--muted); }
      .question .note { font-size: 12px; color: var(--muted); }
      .question .quick { padding-top: 4px; }
      .said .warn { margin: 0; color: var(--bad); font-size: 12px; }
      .quick { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; }
      .quick.options-list { flex-direction: column; flex-wrap: nowrap; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; padding: 4px; }
      .quick.options-list button { flex-shrink: 0; width: 100%; text-align: left; border-radius: 8px; padding: 8px 10px; }
      .quick button { font: inherit; font-size: 12.5px; border-radius: 99px; padding: 4px 11px; cursor: pointer;
        border: 1px solid var(--accent); color: var(--accent); background: var(--bg);
        min-width: 0; max-width: 100%; box-sizing: border-box; white-space: normal; overflow-wrap: anywhere; line-height: 1.4; }
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
      .hero-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .hero .count { font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--muted); }
      .bar.indeterminate i { width: 40%; animation: bar-slide 1.4s ease-in-out infinite; }
      @keyframes bar-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
      @media (prefers-reduced-motion: reduce) { .bar.indeterminate i { animation: none; width: 100%; opacity: .35; } }
      .sub { padding: 0 14px 8px; font-size: 12px; color: var(--muted); }
      details.sub > summary { font-size: 12px; margin: 0; }
      .f .submit-main { flex: 1.6 1 0; min-width: 0; white-space: nowrap; font-weight: 600; }
      .f .submit-main.secondary { flex: 1 1 0; font-weight: 500; font-size: 12px; background: transparent; color: var(--muted); }
      .f.wrap-actions { flex-wrap: wrap; }
      .f .submit-hint { flex: 1 0 100%; color: var(--warn); font-size: 11.5px; }
      .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
        padding: 6px 14px 6px 6px; border-radius: 99px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
        box-shadow: 0 8px 24px rgba(0,0,0,.18); cursor: pointer; font: inherit; font-weight: 600; }
      .pill.enter { animation: in .15s ease-out; }
      .pill .mark { width: 26px; height: 26px; }
      .pill .badge { background: var(--badge-bad); color: #fff; border-radius: 99px; padding: 0 7px; font-size: 12px; }
      .pill .badge.ok { background: var(--badge-ok); }
      .launcher { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 4px;
        padding: 4px 6px 4px 4px; border-radius: 99px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
        box-shadow: 0 10px 28px rgba(0,0,0,.20), 0 2px 6px rgba(0,0,0,.08); font: inherit; }
      .launcher.enter { animation: in .18s ease-out; }
      .launcher-go { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 99px; padding: 4px 12px 4px 4px;
        background: var(--accent); color: var(--accent-fg); font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
      .launcher-go:hover { filter: brightness(1.08); }
      .launcher-go .mark { width: 26px; height: 26px; }
      .launcher-close { border: 0; background: transparent; color: var(--muted); width: 28px; height: 28px; border-radius: 99px;
        font-size: 16px; line-height: 1; cursor: pointer; display: grid; place-items: center; padding: 0; }
      .launcher-close:hover { background: var(--soft); color: var(--fg); }
    `;

    function el(tag: string, attrs: Record<string, any> = {}, ...children: any[]) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "onclick") node.addEventListener("click", (e) => { e.stopPropagation(); (v as any)(e); });
        else if (k === "class") node.className = v;
        else if (k === "style") node.style.cssText = v;
        else node.setAttribute(k, v === true ? "" : v);
      }
      for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
      return node;
    }

    const btn = (label, onclick, cls = "", attrs = {}) => el("button", { class: `b ${cls}`, type: "button", onclick, ...attrs }, label);

    // A site's own modals (LinkedIn's Easy Apply, a native <dialog>, popovers) sit in the browser's
    // top layer, above any z-index, and a modal <dialog> makes everything outside it inert. So the
    // panel is a manual popover (top layer), lives inside an open modal dialog (the only place a
    // modal leaves clickable), and is raised again whenever the site puts something above it.
    const HOST_STYLE = {
      position: "fixed", inset: "auto 0 0 auto", width: "0", height: "0", margin: "0", padding: "0",
      border: "0", background: "transparent", overflow: "visible", display: "block", "z-index": "2147483647",
      // A site's modal library (Radix, MUI) sets pointer-events:none on body/html while its dialog is open; the panel would inherit it.
      "pointer-events": "auto",
    };
    let watching = false;
    let raiseQueued = false;
    let modalTimer = 0;

    function topModal() {
      let top = null;
      for (const d of document.querySelectorAll("dialog")) {
        try { if (d.matches(":modal")) top = d; } catch { /* no :modal support */ }
      }
      return top;
    }

    function raise() {
      if (!host?.parentNode) return; // closed by the user
      const home = topModal() ?? document.documentElement;
      // Moving the host and re-entering the top layer both drop focus: keep the user's typing.
      const focused = root.activeElement;
      const caret = typeof focused?.selectionStart === "number" ? focused.selectionStart : null;
      if (host.parentNode !== home) home.append(host);
      if (host.inert) host.inert = false;
      try {
        if (host.matches(":popover-open")) host.hidePopover();
        host.showPopover();
      } catch { /* no Popover API: the z-index still applies */ }
      if (focused && root.activeElement !== focused) {
        focused.focus({ preventScroll: true });
        if (caret != null) focused.setSelectionRange?.(caret, caret);
      }
      clearInterval(modalTimer);
      // A modal removed from the page without closing takes the panel with it: bring it back.
      if (home !== document.documentElement) {
        modalTimer = setInterval(() => {
          if (host.parentNode === home && host.isConnected && topModal() === home) return;
          if (host.parentNode === home) document.documentElement.append(host);
          raise();
        }, 500);
      }
    }

    function queueRaise() {
      if (raiseQueued) return;
      raiseQueued = true;
      queueMicrotask(() => { raiseQueued = false; raise(); });
    }

    function watch() {
      if (watching) return;
      watching = true;
      const ours = (node) => node === host || node?.hasAttribute?.("data-applyshortly-screenshot-refs");
      // Popovers announce themselves with a toggle event, which doesn't bubble: listen in capture.
      document.addEventListener("toggle", (e) => {
        if (!ours(e.target) && /** @type {any} */ (e).newState === "open") queueRaise();
      }, true);
      // A dialog opened with showModal() or closed again flips its `open` attribute; a site that
      // marks the panel inert (focus traps do) gets it undone.
      // Watchdog: if clicks at the panel's centre don't reach it (a site made it inert, covered it or
      // turned pointer events off), raise it again and restore its own hit-testing. Otherwise it stays dead until a reload.
      const watchdog = setInterval(() => {
        if (!host?.isConnected || host.hasAttribute("data-applyshortly-executing")) return;
        const box = root.querySelector(".p, .pill, .launcher")?.getBoundingClientRect();
        if (!box || !box.width) return;
        const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
        if (document.elementFromPoint(x, y) === host) return;
        host.style.setProperty("pointer-events", "auto", "important");
        if (host.closest("[inert]") && host.parentNode !== document.documentElement) document.documentElement.append(host);
        raise();
      }, 1000);
      // Node-based UI tests may return a timer object; browsers return a numeric id.
      (watchdog as any)?.unref?.();
      new MutationObserver((records) => {
        if (records.some((r) => (r.target === host && host.inert) || (!ours(r.target) && r.target instanceof HTMLDialogElement))) queueRaise();
      }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open", "inert"] });
    }

    function ensure() {
      if (host?.isConnected) return;
      if (!host) {
        host = document.createElement("jobhunt-autofill-panel");
        root = host.attachShadow({ mode: "closed" });
        host.setAttribute("popover", "manual");
        for (const [prop, value] of Object.entries(HOST_STYLE)) host.style.setProperty(prop, value, "important");
      }
      document.documentElement.append(host);
      watch();
      raise();
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

    // A confirmation ("Submit cancelled") fades after a few seconds. A message the user has to act
    // on or could miss (why nothing was submitted, an error) stays until they dismiss it.
    function toast(text, { persist = false } = {}) {
      view.toast = text;
      view.toastPersist = persist;
      clearTimeout(toastTimer);
      if (!persist) toastTimer = setTimeout(() => { view.toast = null; render(); }, 5000);
      render();
    }

    function dismissToast() {
      clearTimeout(toastTimer);
      view.toast = null;
      render();
    }

    function setMinimized(value) {
      if (value) view.countdown?.cancel(); // never submit from a panel the user can't see
      view.minimized = value;
      chrome.runtime.sendMessage({ type: "panelPreference", minimized: value }).catch(() => {});
      render();
      // Every caller is the user minimising or reopening: keep keyboard focus on what they act on.
      root.querySelector(value ? ".pill" : ".p")?.focus({ preventScroll: true });
    }

    // Where the panel sits and how big it is are remembered across pages (the user's own layout).
    function setPref(name, value) {
      view[name] = value;
      try { void chrome.storage.local.set({ [name === "dock" ? "panelDock" : "panelCompact"]: value }).catch(() => {}); } catch { /* not remembered */ }
      render();
      root.querySelector(`[data-act="${name}"]`)?.focus({ preventScroll: true });
    }

    /** Where the user dragged the panel to (kept across re-renders until the page reloads). */
    function applyPos(p) {
      if (!view.pos) return;
      // Only the position changes: width and height stay what the panel's content and size rules give.
      const w = p.offsetWidth, h = p.offsetHeight;
      const left = Math.min(Math.max(0, view.pos.left), Math.max(0, innerWidth - w));
      const top = Math.min(Math.max(0, view.pos.top), Math.max(0, innerHeight - h));
      p.style.right = "auto"; p.style.bottom = "auto"; p.style.left = `${left}px`; p.style.top = `${top}px`;
    }
    function makeDraggable(p, handle) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return;
        const box = p.getBoundingClientRect();
        const dx = e.clientX - box.left, dy = e.clientY - box.top;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        const move = (ev) => {
          view.pos = { left: Math.min(Math.max(0, ev.clientX - dx), innerWidth - p.offsetWidth), top: Math.min(Math.max(0, ev.clientY - dy), innerHeight - p.offsetHeight) };
          applyPos(p);
        };
        const up = () => {
          handle.classList.remove("dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
        e.preventDefault();
      });
    }

    function header(title, subtitle) {
      return el("div", { class: "h" },
        el("div", { class: "mark", "aria-hidden": "true" }),
        el("div", { class: "t" }, el("b", { title }, title), subtitle ? el("small", { title: subtitle }, subtitle) : null),
        el("button", { class: "icon", type: "button", "data-act": "compact", title: view.compact ? "Show the full panel" : "Smaller panel",
          "aria-label": view.compact ? "Show the full panel" : "Smaller panel", "aria-pressed": view.compact ? "true" : "false",
          onclick: () => setPref("compact", !view.compact) }, icon(view.compact ? CHEVRONS_OUT : CHEVRONS_IN)),
        el("button", { class: "icon", type: "button", title: "Minimise (Esc)", "aria-label": "Minimise", onclick: () => setMinimized(true) }, "–"),
        el("button", { class: "icon", type: "button", title: "Close", "aria-label": "Close", onclick: () => { view.countdown?.cancel(); host.remove(); } }, "×"),
      );
    }

    // The chat is the agent: while it clicks through the form, its steps and questions show here.
    const AGENT_LIVE = ["starting", "running", "waiting", "paused"];
    const agentLive = () => Boolean(ctl.agent && AGENT_LIVE.includes(ctl.agent.status));
    const agentBusy = () => agentLive() && ctl.agent.status !== "waiting";

    /** Headline, count and progress bar. Until the form has been read there is no total to show, so the bar animates instead. */
    function heroSection(summary, results) {
      const agent = ctl.agent;
      const working = agentLive();
      const paused = agent?.status === "paused";
      const busy = agentBusy() && !paused;
      const completed = agent?.status === "ready";
      const missing = completed ? P.missingRequired(results, ctl.state?.readiness ?? agent?.readiness).count : 0;
      const full = ctl.submittedReported || (!missing && summary.progress >= 1);
      const headline = ctl.submittedReported ? "Saved in ApplyShortly ✓"
        : agent && ["stopped", "failed"].includes(agent.status) ? "Stopped: review the form"
        : missing ? `${missing} required ${missing === 1 ? "answer" : "answers"} needed`
        : completed ? "Ready for your review"
        : working ? (agent.status === "waiting" ? "Needs you" : agent.status === "paused" ? "Paused" : "Working through the form…")
        : summary.headline;
      // The page scan is not repeated while the agent works: use the agent's own live count until it is.
      const filledCount = agent?.filled_count ?? 0;
      // Before the agent has read the form, the page's own quick count stands in.
      const early = working && !summary.total && !agent?.field_total ? ctl.pageCount : null;
      const total = (missing ? Math.max(summary.total, agent?.field_total ?? 0, agent?.readiness?.total ?? 0, missing) : summary.total) || (working || completed ? agent?.field_total || early?.total || 0 : 0);
      const live = working ? Math.max(summary.answered, filledCount, agent?.field_answered ?? 0, early?.answered ?? 0) : completed ? Math.max(summary.answered, agent?.field_answered ?? 0, filledCount) : summary.answered;
      const done = full && total ? total : total ? Math.min(live, total - missing) : live;
      const pct = full ? 100 : total ? Math.round((done / total) * 100) : 0;
      const reading = busy && !full && !total && !filledCount;
      const unknownTotal = busy && !full && !total && filledCount > 0;
      const stopped = Boolean(agent && ["stopped", "failed"].includes(agent.status));
      const meta = ctl.submittedReported ? "Tracked in ApplyShortly"
        : missing ? "Fill the remaining required fields to continue."
        : completed ? "Review your answers on the form before submitting."
        : paused ? "Paused. Press Resume to continue."
        : reading ? "Reading the form to see what it asks…"
        : !total ? (working || filledCount ? `${filledCount} ${filledCount === 1 ? "step" : "steps"} done` : stopped ? "Review the form and finish any remaining fields." : "Try again once the form has loaded")
        : `${done}/${total} steps`;
      const indeterminate = reading || unknownTotal;
      return el("div", { class: "hero" },
        el("div", { class: "hero-top" },
          el("strong", {}, headline),
          !reading && total ? el("span", { class: "count", "aria-label": `${done} of ${total} steps completed` }, `${done}/${total}`) : null),
        el("div", {
          class: `bar${full ? " full" : ""}${indeterminate ? " indeterminate" : ""}`, role: "progressbar", "aria-label": "Form progress",
          ...(indeterminate ? {} : { "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }),
        }, el("i", { style: indeterminate ? "" : `width:${pct}%` })),
        el("div", { class: "meta", role: "status" }, meta));
    }

    /** A transient status describes current work, never repeats an earlier assistant reply. */
    function agentActivity() {
      if (!ctl.agent || !agentBusy()) return null;
      const paused = ctl.agent.status === "paused";
      const steps = ctl.agent.log ?? [];
      if (paused) {
        const last = steps.at(-1) ?? "";
        const why = /Paused to avoid|temporarily unavailable/.test(last) ? last : "Paused.";
        if (ctl.chat.lines.some((line) => line.text === why || line.parts?.includes(why))) return null;
        return el("div", { class: "thinking", role: "status" }, why);
      }
      const replied = ctl.chat.lines.some((line) => line.role === "user");
      const text = replied ? "Applying your answer and checking the form…"
        : steps.length ? "Filling and checking the form…"
        : "Reading the form and matching your profile. The first fill may take a moment…";
      return el("div", { class: "thinking", role: "status" }, el("span", { class: "spin" }), text);
    }

    function agentControls() {
      return el("div", { class: "f" },
        ctl.agent.status === "paused"
          ? btn("Resume", () => void ctl.agentControl("resume"), "primary")
          : ctl.agent.status === "waiting" ? null : btn("Pause", () => void ctl.agentControl("pause"), ""),
        el("span", { class: "grow" }),
        btn("Stop and take over", () => void ctl.agentControl("stop"), "ghost"));
    }

    // Long replies arrive as one block: break on newlines, else after every two sentences.
    function paragraphs(text) {
      const blocks = String(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
      if (blocks.length > 1 || text.length <= 140) return blocks;
      const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
      const out = [];
      for (let i = 0; i < sentences.length; i += 2) out.push(sentences.slice(i, i + 2).join(" "));
      return out;
    }

    function chatView(results) {
      const hello = ctl.state?.ctx ? P.assistantGreeting(results) : null;
      const greeting = hello ? [{ role: "assistant", greeting: true, ...hello }] : [];
      const lines = ctl.chat.lines.length ? ctl.chat.lines : greeting;
      const log = el("div", { class: "chat", "aria-live": "polite" });
      lines.forEach((line, i) => {
        if (line.role === "user") return void log.append(el("div", { class: "bubble user" }, line.text));
        // Like the website's chat: a bot avatar, the message, what it filled, then the question it asks.
        const q = line.question;
        const quick = i === lines.length - 1 && line.choices?.length
          ? el("div", { class: `quick${line.choices.length > 4 || line.choices.some((c) => String(c).length > 60) ? " options-list" : ""}`, role: "group", "aria-label": "Quick replies" },
            line.choices.map((c) => el("button", { type: "button", disabled: ctl.chat.pending || agentBusy(), onclick: () => void ctl.askAssistant(c) }, c)))
          : null;
        log.append(el("div", { class: line.step ? "turn step-turn" : "turn" },
          el("span", { class: "avatar" }, icon(BOT)),
          el("div", { class: "said" },
            line.text ? el("div", { class: line.step ? "bubble assistant stepline" : "bubble assistant" }, ...paragraphs(line.text).map((t) => el("p", {}, t))) : null,
            line.filled?.length ? el("ul", { class: "filled", "aria-label": "Filled" }, line.filled.map((f) => el("li", { title: f }, icon(CHECK), el("span", {}, f)))) : null,
            q ? el("div", { class: "bubble assistant question" },
              q.step ? el("p", { class: "step" }, q.step) : null,
              el("p", { class: "label" }, q.label),
              q.note ? el("p", { class: "note" }, q.note) : null,
              quick) : quick,
            line.warnings?.map((w) => el("p", { class: "warn" }, w)))));
      });
      if (ctl.chat.pending) log.append(el("div", { class: "thinking", role: "status" }, el("span", { class: "spin" }), "Thinking…"));
      else {
        const activity = agentActivity();
        if (activity) log.append(activity);
      }
      return log;
    }

    // Lucide icons, as on the website's chat.
    const SEND = ["M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
      "m21.854 2.147-10.94 10.939"];
    const BOT = ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"];
    const CHEVRONS_IN = ["m7 20 5-5 5 5", "m7 4 5 5 5-5"];
    const CHEVRONS_OUT = ["m7 15 5 5 5-5", "m7 9 5-5 5 5"];
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
      // Stays open while the agent works: a question queues for its next step.
      const busy = false;
      const input = el("textarea", {
        class: "composer-input", rows: "1", "aria-label": "Message the agent", disabled: busy,
        placeholder: ctl.agent?.status === "waiting" ? "Type your answer…" : "Type your answer, or ask to change one…",
      }) as HTMLTextAreaElement;
      input.value = ctl.chat.draft;
      const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
      input.addEventListener("input", () => { ctl.chat.draft = input.value; grow(); });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // keep the job site's own shortcuts out of the chat box
        if (e.key === "Escape") { e.preventDefault(); setMinimized(true); } // not the site's modal too
        else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ctl.askAssistant(input.value); }
      });
      queueMicrotask(grow);
      return el("div", { class: "composer" },
        el("div", { class: "box" }, input,
          btn(icon(SEND), () => void ctl.askAssistant(input.value), "primary send", { disabled: ctl.chat.pending || busy, "aria-label": "Send", title: "Send" })),
      );
    }

    // The stylesheet stays in place between renders; only the content is swapped, so nothing
    // restyles or flashes between updates.
    const styleEl = el("style", {}, css);
    function mount(wrap) {
      if (!root.contains(styleEl)) root.replaceChildren(styleEl);
      const old = root.querySelector(".wrap");
      // The agent reports several times per step, mostly with nothing new to show: keeping the
      // identical panel avoids restarting its spinner and animations (a visible flicker).
      if (old && old.outerHTML === wrap.outerHTML) return;
      if (old) old.replaceWith(wrap);
      else root.append(wrap);
    }

    function render() {
      ensure();
      // Re-rendering replaces the panel; keep the chat box focused while the user is typing.
      const focused = root.activeElement;
      const typingIn = ["composer-input", "note-input"].find((name) => focused?.classList?.contains(name));
      const typing = typingIn ? focused.selectionStart : null;
      const refocus = () => {
        if (typing === null) return;
        const input = root.querySelector(`.${typingIn}`);
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(typing, typing);
      };
      const prevScroll = root.querySelector(".body")?.scrollTop ?? 0;
      const app = ctl.state?.ctx?.app;
      const results = ctl.state?.results ?? [];
      const summary = P.summarize(results, { submitted: ctl.submittedReported });
      const title = app?.title || document.title || "ApplyShortly autofill";
      const subtitle = [app?.company_name, ctl.state && ctl.state.appId == null ? "Not tracked in ApplyShortly" : null]
        .filter(Boolean).join(" · ");

      const wrap = el("div", { class: "wrap", "data-theme": view.theme === "light" || view.theme === "dark" ? view.theme : null });

      if (view.launcher && !view.busy && !view.error && !ctl.state?.ctx && !ctl.submittedReported && !ctl.agent) {
        wrap.append(el("div", {
          class: root.querySelector(".launcher") ? "launcher" : "launcher enter",
          role: "region",
          "aria-label": "ApplyShortly form detected",
        },
          el("button", {
            class: "launcher-go",
            type: "button",
            title: "Start filling this application with ApplyShortly",
            onclick: () => { void ctl.launch?.(); },
          }, el("span", { class: "mark", "aria-hidden": "true" }), "Start applying"),
          el("button", {
            class: "launcher-close",
            type: "button",
            title: "Dismiss",
            "aria-label": "Dismiss ApplyShortly button",
            onclick: () => { view.launcher = false; host?.remove(); ctl.dismissLauncher?.(); },
          }, "×"),
        ));
        mount(wrap);
        return;
      }

      if (view.minimized) {
        const badge = ctl.submittedReported ? "Submitted ✓" : summary.todo ? `${summary.todo} to do` : "All set";
        wrap.append(el("button", {
          class: `${root.querySelector(".pill") ? "pill" : "pill enter"}${view.dock === "left" ? " left" : ""}`, type: "button", title: "Open ApplyShortly autofill",
          onclick: () => setMinimized(false),
        }, el("span", { class: "mark", "aria-hidden": "true" }), "ApplyShortly",
          view.busy ? el("span", { class: "spin" })
            : el("span", { class: `badge ${summary.todo ? "" : "ok"}` }, badge)));
        mount(wrap);
        return;
      }

      // Slide in only when the panel appears, not on every re-render (agent updates, typing).
      const entering = !root.querySelector(".p");
      const p = el("div", { class: `p${entering ? " enter" : ""}${view.dock === "left" ? " left" : ""}${view.compact ? " compact" : ""}`, role: "dialog", "aria-label": "ApplyShortly autofill", tabindex: "-1" });
      p.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault(); // inside a site's modal dialog, Escape would close the application too
        setMinimized(true);
      });
      const head = header(title, subtitle);
      p.append(head);
      applyPos(p);
      makeDraggable(p, head);
      if (ctl.agent) {
        if (ctl.agent.filling_notice) p.append(el("div", { class: "sub", role: "status" }, ctl.agent.filling_notice));
      }

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
        p.append(heroSection(summary, results));

        const body = el("div", { class: "body" });
        if (ctl.submittedReported) {
          body.append(el("div", { class: "msg good" },
            el("b", {}, "Saved in ApplyShortly"),
            el("p", {}, ctl.state.appId != null ? "This application is now marked Submitted. Good luck!" : "Done."),
            ctl.state.ctx?.baseUrl ? btn("Open ApplyShortly", () => window.open(`${ctl.state.ctx.baseUrl}/applications`, "_blank"), "primary") : null,
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

        if (view.toast) {
          p.append(el("div", { class: view.toastPersist ? "toast sticky" : "toast", role: view.toastPersist ? "alert" : "status" },
            el("span", { class: "grow" }, view.toast),
            view.toastPersist ? btn("Dismiss", dismissToast, "ghost", { "aria-label": "Dismiss message" }) : null));
        }

        // Submit is in the footer (not while the agent is working). It runs the guarded flow: refuses and says why unless every required
        // answer is in, then clicks the form's own Submit after a countdown the user can cancel.
        const blockersNow = () => {
          const blockers = P.autoApplyBlockers(results, ctl.state.ctx.app, ctl.state.readiness ?? ctl.agent?.readiness, ctl.state.captchaPending);
          if (["stopped", "failed"].includes(ctl.agent?.status)) blockers.push("The form agent stopped before completing its review");
          return blockers;
        };
        const submit = () => {
          const blockers = blockersNow();
          // Enabled only when every required answer is in; the note above it and the tooltip say what's missing.
          return btn("Submit", () => void ctl.autoApply(), "primary submit-main", {
            disabled: blockers.length > 0,
            title: blockers.length
              ? `Not ready: ${blockers.join(". ")}.`
              : `Clicks the form's Submit button for you after a ${ctl.AUTO_APPLY_DELAY_S}-second countdown.`,
          });
        };
        // Announced once, when it appears. The ticking number is hidden from screen readers and
        // updated in place (see countdown() below), so Cancel keeps focus and nothing re-reads.
        const countdown = () => el("div", { class: "f counting" },
          el("span", { class: "sr", role: "alert" }, "Submitting soon. Press Cancel to stop it."),
          el("span", { class: "grow cd", "aria-hidden": "true" }, `Submitting in ${view.countdown.left}s…`),
          btn("Cancel", view.countdown.cancel, "primary", { "data-cancel": "" }),
        );
        // Sites where the confirmation can't be detected: the user says it was sent.
        const confirmSubmitted = () => el("div", { class: "f" },
          el("span", { class: "grow meta" }, "Did you submit it?"),
          btn("Yes, I submitted it", () => { view.confirmSubmit = false; void ctl.markSubmitted("marked from the extension panel"); }, "primary"),
          btn("Not yet", () => { view.confirmSubmit = false; render(); }, "ghost"));
        if (working) {
          p.append(composer(), agentControls());
        } else if (!ctl.submittedReported && ctl.agent && !ctl.state?.ctx) {
          p.append(composer(), el("div", { class: "f" }, el("small", { class: "meta" }, "Review and submit using the form on this page.")));
        } else if (!ctl.submittedReported && ctl.state?.ctx && !ctl.state.postingGone) {
          if (view.countdown) p.append(countdown());
          p.append(composer());
          if (view.confirmSubmit) p.append(confirmSubmitted());
          else if (!view.countdown) {
            const why = blockersNow();
            p.append(el("div", { class: "f wrap-actions" },
              why.length ? el("small", { class: "submit-hint" }, `${why[0]}.`) : null,
              ctl.state.appId != null ? btn("Already submitted", () => { view.confirmSubmit = true; render(); }, "ghost submit-main secondary") : el("span", { class: "grow" }),
              submit()));
          }
          
        }
      }

      wrap.append(p);
      mount(wrap);
      refocus();
    }

    let retryAppId = null;
    return {
      render,
      toast,
      busy(text) { Object.assign(view, { busy: text, error: null, launcher: false }); render(); },
      idle() { view.busy = null; render(); },
      fail(err) {
        view.busy = null;
        view.launcher = false;
        view.error = P.friendlyError(err.message, err.status, ctl.state?.ctx?.baseUrl, err.code);
        render();
      },
      async showLauncher() {
        try {
          const saved = await chrome.storage.local.get("theme");
          if (saved?.theme) view.theme = saved.theme;
        } catch { /* keep system theme */ }
        view.launcher = true;
        render();
      },
      hideLauncher() {
        if (!view.launcher) return;
        view.launcher = false;
        if (!ctl.state?.ctx && !ctl.agent && !view.busy && !view.error) host?.remove();
      },
      setRetry(appId) { retryAppId = appId; },
      /** Shows the agent's latest update. */
      agent(show) {
        view.launcher = false;
        if (show) Object.assign(view, { minimized: false, busy: null, error: null });
        render();
      },
      /** Shows the panel with a message, e.g. why Auto apply didn't submit. */
      stop(text) {
        view.minimized = false;
        toast(text, { persist: true });
      },
      /** Counts down before Auto apply submits; resolves false if the user cancels. */
      countdown(seconds) {
        return new Promise((resolve) => {
          const c: any = { left: seconds };
          const finish = (go) => {
            if (view.countdown !== c) return;
            clearInterval(c.timer);
            view.countdown = null;
            render();
            resolve(go);
          };
          c.cancel = () => finish(false);
          c.timer = setInterval(() => {
            if (--c.left <= 0) return finish(true);
            // Change the number in place: re-rendering would replace the Cancel button each second.
            const label = root.querySelector(".cd");
            if (label) label.textContent = `Submitting in ${c.left}s…`;
            else render();
          }, 1000);
          Object.assign(view, { countdown: c, minimized: false });
          render();
          root.querySelector("[data-cancel]")?.focus({ preventScroll: true }); // Enter cancels
        });
      },
      focus: focusField,
      countdownLeft() { return view.countdown?.left ?? null; },
      cancelCountdown() { view.countdown?.cancel(); },
      async restore({ show = false } = {}) {
        try {
          const saved = await chrome.storage.local.get(["panelDock", "panelCompact", "theme", "autoApply", "aiDrafts", "fillOptional"]);
          view.dock = "right"; // the left/right button was removed; the panel is dragged instead
          view.compact = saved.panelCompact === true;
          view.theme = saved.theme;
          view.autoApply = saved.autoApply === true;
          view.aiDrafts = saved.aiDrafts !== false;
          view.fillOptional = saved.fillOptional !== false;
          if (!watchingTheme) {
            watchingTheme = true;
            chrome.storage.onChanged.addListener((changes, area) => {
              if (area !== "local") return;
              if ("theme" in changes) view.theme = changes.theme.newValue;
              if ("autoApply" in changes) view.autoApply = changes.autoApply.newValue === true;
              if ("aiDrafts" in changes) view.aiDrafts = changes.aiDrafts.newValue !== false;
              if ("fillOptional" in changes) view.fillOptional = changes.fillOptional.newValue !== false;
              if (("theme" in changes || "autoApply" in changes || "aiDrafts" in changes || "fillOptional" in changes) && host?.isConnected) render(); // a panel the user closed stays closed
            });
          }
        } catch { /* no storage: right side, full size, the page's colour scheme */ }
        view.launcher = false;
        if (show) view.minimized = false;
        else view.minimized = Boolean((await chrome.runtime.sendMessage({ type: "panelPreference" }).catch(() => ({}))).data);
      },
    };
  }

  globalThis.JobHuntPanelView = { create };
})();
