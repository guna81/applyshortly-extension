// Drives one tab through chrome.debugger (the Chrome DevTools Protocol) for the form agent:
// - every frame, cross-origin iframes included (auto-attached flat sessions, Chrome 125+);
// - page code runs in an isolated world, so the site's scripts can't see or tamper with it;
// - clicks and typing are real input events (isTrusted), which React/Workday-style forms expect.
// While attached, Chrome shows its "started debugging this browser" bar; closing it stops the agent.

const PROTOCOL = "1.3";
const WORLD = "applyshortly-agent";
// Frames that only hold a CAPTCHA widget or ads: never shown to the planner.
const SKIP_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|doubleclick|googlesyndication/i;
const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};
const CALL = "function (name, args) { return globalThis.JobHuntAgentPage[name](...args); }";
const IN_DIALOG = 'function () { return Boolean(this.closest(\'[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]\')); }';
const OWNER_OFFSET = `function () {
  const r = this.getBoundingClientRect();
  const s = getComputedStyle(this);
  return { x: r.left + this.clientLeft + parseFloat(s.paddingLeft), y: r.top + this.clientTop + parseFloat(s.paddingTop) };
}`;

export class TabDriver {
  /** @param {number} tabId @param {string} sources fill.js + agent/page.js, injected per frame */
  constructor(tabId, sources, api = globalThis.chrome) {
    this.tabId = tabId;
    this.sources = sources;
    this.api = api;
    this.sessions = new Map(); // OOPIF sessionId → targetInfo
    this.worlds = new Map(); // "session:frame" → executionContextId
    this.attached = false;
    this.onDetached = null; // set by the agent: the user closed the debugging bar, or the tab went away
    this.handleEvent = this.handleEvent.bind(this);
    this.handleDetach = this.handleDetach.bind(this);
  }

  async attach() {
    await this.api.debugger.attach({ tabId: this.tabId }, PROTOCOL);
    this.attached = true;
    this.api.debugger.onEvent.addListener(this.handleEvent);
    this.api.debugger.onDetach.addListener(this.handleDetach);
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  async detach() {
    if (!this.attached) return;
    this.attached = false;
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    await this.api.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  handleEvent(source, method, params) {
    if (source.tabId !== this.tabId) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      this.sessions.set(params.sessionId, params.targetInfo);
      // Frames nested inside a cross-origin frame need their own auto-attach.
      void this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => {});
      void this.send("DOM.enable", {}, params.sessionId).catch(() => {});
    } else if (method === "Target.detachedFromTarget") {
      this.sessions.delete(params.sessionId);
    } else if (method === "Page.frameNavigated" || method === "Page.loadEventFired") {
      this.worlds.clear(); // contexts are per document
    }
  }

  handleDetach(source, reason) {
    if (source.tabId !== this.tabId || !this.attached) return;
    this.attached = false;
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    this.onDetached?.(reason);
  }

  send(method, params = {}, sessionId = undefined) {
    const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    return this.api.debugger.sendCommand(target, method, params);
  }

  /** Every frame with a document: {frameId, sessionId, parentId, url, isTop}. */
  async frames() {
    const byId = new Map();
    const walk = (tree, sessionId) => {
      const { id, parentId, url } = tree.frame;
      const known = byId.get(id);
      // An OOPIF shows up in its parent's tree too; its own session is the one with its document.
      if (!known || (sessionId && !known.sessionId)) {
        byId.set(id, { frameId: id, sessionId, parentId: parentId ?? known?.parentId ?? null, url, isTop: !sessionId && !parentId });
      } else if (!known.parentId && parentId) {
        known.parentId = parentId;
      }
      for (const child of tree.childFrames ?? []) walk(child, sessionId);
    };
    walk((await this.send("Page.getFrameTree")).frameTree, undefined);
    for (const sessionId of [...this.sessions.keys()]) {
      try { walk((await this.send("Page.getFrameTree", {}, sessionId)).frameTree, sessionId); }
      catch { this.sessions.delete(sessionId); }
    }
    return [...byId.values()].filter((f) => /^(https?:|about:blank)/.test(f.url) && !SKIP_FRAME.test(f.url));
  }

  async world(frame) {
    const key = `${frame.sessionId ?? ""}:${frame.frameId}`;
    if (this.worlds.has(key)) return this.worlds.get(key);
    const { executionContextId } = await this.send(
      "Page.createIsolatedWorld",
      { frameId: frame.frameId, worldName: WORLD, grantUniveralAccess: false },
      frame.sessionId,
    );
    const loaded = await this.send("Runtime.evaluate", { contextId: executionContextId, expression: this.sources, returnByValue: true }, frame.sessionId);
    if (loaded.exceptionDetails) throw new Error("Couldn't load the agent into this frame.");
    this.worlds.set(key, executionContextId);
    return executionContextId;
  }

  /** Calls JobHuntAgentPage[name](...args) in the frame's isolated world; JSON in and out. */
  async call(frame, name, ...args) {
    const key = `${frame.sessionId ?? ""}:${frame.frameId}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const executionContextId = await this.world(frame);
        const res = await this.send("Runtime.callFunctionOn", {
          executionContextId,
          functionDeclaration: CALL,
          arguments: [{ value: name }, { value: args }],
          awaitPromise: true,
          returnByValue: true,
        }, frame.sessionId);
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
        return res.result?.value;
      } catch (error) {
        this.worlds.delete(key); // navigated or destroyed: a fresh world on the retry
        if (attempt >= 1) throw error;
      }
    }
  }

  /** Where a frame's viewport sits in the tab's viewport (sum of iframe content-box offsets). */
  async offset(frame, frames) {
    let x = 0;
    let y = 0;
    for (let f = frame; f && !f.isTop && f.parentId; f = frames.find((p) => p.frameId === f.parentId)) {
      const parent = frames.find((p) => p.frameId === f.parentId);
      if (!parent) break;
      const { backendNodeId } = await this.send("DOM.getFrameOwner", { frameId: f.frameId }, parent.sessionId);
      const contextId = await this.world(parent);
      const { object } = await this.send("DOM.resolveNode", { backendNodeId, executionContextId: contextId }, parent.sessionId);
      const res = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: OWNER_OFFSET, returnByValue: true }, parent.sessionId);
      x += res.result.value.x;
      y += res.result.value.y;
    }
    return { x, y };
  }

  /** Whether a frame's iframe (or its outermost ancestor's) sits inside an open modal in the tab. */
  async inDialog(frame, frames) {
    let outer = frame;
    for (let parent = frames.find((p) => p.frameId === outer.parentId); parent && !parent.isTop; parent = frames.find((p) => p.frameId === outer.parentId)) {
      outer = parent;
    }
    const top = frames.find((p) => p.isTop);
    if (!top || outer.isTop) return true;
    const { backendNodeId } = await this.send("DOM.getFrameOwner", { frameId: outer.frameId }, top.sessionId);
    const contextId = await this.world(top);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId, executionContextId: contextId }, top.sessionId);
    const res = await this.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: IN_DIALOG, returnByValue: true }, top.sessionId);
    return Boolean(res.result?.value);
  }

  async click(x, y) {
    const at = { x: Math.round(x), y: Math.round(y) };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at });
  }

  insertText(text) {
    return this.send("Input.insertText", { text });
  }

  async press(name) {
    const info = KEYS[name];
    if (!info) throw new Error(`Unsupported key ${name}`);
    await this.send("Input.dispatchKeyEvent", { type: info.text ? "keyDown" : "rawKeyDown", ...info });
    const { text: _text, ...up } = info;
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
  }

  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 55 });
    return data;
  }
}

export { KEYS, SKIP_FRAME };
