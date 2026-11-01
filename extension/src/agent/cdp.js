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
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
};
const CALL = "function (name, args) { return globalThis.JobHuntAgentPage[name](...args); }";
const IN_DIALOG = 'function () { return Boolean(this.closest(\'[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]\')); }';
const OWNER_OFFSET = `function () {
  const r = this.getBoundingClientRect();
  const s = getComputedStyle(this);
  return { x: r.left + this.clientLeft + parseFloat(s.paddingLeft), y: r.top + this.clientTop + parseFloat(s.paddingTop) };
}`;

// Longest side of the screenshot sent to the model, in pixels. Retina tabs otherwise send twice
// the CSS size, and the model's screenshot points would not match the page's coordinates.
const SHOT_MAX = 1280;

/** A JavaScript alert/confirm/prompt/beforeunload is open: the page is frozen until it closes. */
export class DialogOpenError extends Error {
  constructor(dialog) {
    super(`The page opened a browser dialog${dialog?.message ? `: "${String(dialog.message).slice(0, 200)}"` : ""}.`);
    this.name = "DialogOpenError";
    this.dialog = dialog;
  }
}

/** Width and height of a base64 JPEG, read from its frame header; null if unreadable. */
export function jpegSize(base64) {
  let bytes;
  try { bytes = Uint8Array.from(atob(base64.slice(0, 200_000)), (c) => c.charCodeAt(0)); } catch { return null; }
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

export class TabDriver {
  /** @param {number} tabId @param {string} sources fill.js + agent/page.js, injected per frame */
  constructor(tabId, sources, api = globalThis.chrome) {
    this.tabId = tabId;
    this.sources = sources;
    this.api = api;
    this.sessions = new Map(); // OOPIF sessionId → targetInfo
    this.worlds = new Map(); // "session:frame" → executionContextId
    this.attached = false;
    this.candidateTabs = new Map();
    this.axRefs = new Map();
    this.lastInteractionAt = 0;
    this.onTabChanged = null;
    this.dialog = null; // {type, message} while a JavaScript dialog blocks the page
    this.dialogWaiters = new Set(); // rejecters of in-flight commands, released when one opens
    this.dialogClosedWaiters = new Set();
    this.shotScale = 1;
    this.handleCreated = (tab) => {
      if (tab.openerTabId === this.tabId && Date.now() - this.lastInteractionAt < 5000 && tab.id) this.candidateTabs.set(tab.id, tab);
    };
    this.onDetached = null; // set by the agent: the user closed the debugging bar, or the tab went away
    this.handleEvent = this.handleEvent.bind(this);
    this.handleDetach = this.handleDetach.bind(this);
  }

  async attach() {
    await this.api.debugger.attach({ tabId: this.tabId }, PROTOCOL);
    this.attached = true;
    this.api.tabs?.onCreated?.addListener(this.handleCreated);
    this.api.debugger.onEvent.addListener(this.handleEvent);
    this.api.debugger.onDetach.addListener(this.handleDetach);
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  async detach() {
    if (!this.attached) return;
    this.attached = false;
    this.api.tabs?.onCreated?.removeListener(this.handleCreated);
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
    } else if (method === "Page.javascriptDialogOpening") {
      // Never answered here: the user reads it and chooses (a "Leave site?" one especially).
      this.dialog = { type: params.type, message: params.message ?? "" };
      for (const reject of this.dialogWaiters) reject(new DialogOpenError(this.dialog));
      this.dialogWaiters.clear();
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
      for (const resolve of this.dialogClosedWaiters) resolve();
      this.dialogClosedWaiters.clear();
    } else if (method === "Page.frameNavigated" || method === "Page.loadEventFired") {
      this.axRefs.clear();
      this.worlds.clear(); // contexts are per document
    }
  }

  handleDetach(source, reason) {
    if (source.tabId !== this.tabId || !this.attached) return;
    this.attached = false;
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    this.api.tabs?.onCreated?.removeListener(this.handleCreated);
    this.onDetached?.(reason);
  }

  /** @returns {Promise<any>} the command's result; CDP results aren't typed here */
  send(method, params = {}, sessionId = undefined) {
    const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    // While a dialog is open the page's scripts and input wait for it: fail instead of hanging.
    if (this.dialog && !method.startsWith("Page.") && !method.startsWith("Target.")) return Promise.reject(new DialogOpenError(this.dialog));
    let reject;
    const blocked = new Promise((_, r) => { reject = r; this.dialogWaiters.add(r); });
    const command = Promise.resolve(this.api.debugger.sendCommand(target, method, params));
    return Promise.race([command, blocked]).finally(() => this.dialogWaiters.delete(reject));
  }

  /** Resolves when no JavaScript dialog is open (now, or once the user closes it). */
  dialogClosed() {
    if (!this.dialog) return Promise.resolve();
    return new Promise((resolve) => this.dialogClosedWaiters.add(resolve));
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
        if (error instanceof DialogOpenError) throw error; // retrying would only wait again
        this.worlds.delete(key); // navigated or destroyed: a fresh world on the retry
        if (attempt >= 1) throw error;
      }
    }
  }

  async accessible(frame, observed, query = "") {
    const { nodes } = await this.send("Accessibility.getFullAXTree", { frameId: frame.frameId }, frame.sessionId);
    const candidates = nodes.filter((n) => !n.ignored && n.backendDOMNodeId && (!query || (n.name?.value || "").toLowerCase().includes(query.toLowerCase())) &&
      /^(textbox|textField|searchbox|combobox|listbox|option|button|link|radio|checkbox|popUpButton)$/.test(n.role?.value));
    const elements = [];
    let failed = false;
    for (const node of candidates.slice(0, 400)) {
      if (observed.includes(this.axRefs.get(node.backendDOMNodeId))) continue;
      let objectId;
      try {
        const { object } = await this.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId, executionContextId: await this.world(frame) }, frame.sessionId);
        objectId = object.objectId;
        const result = await this.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(role, name, observed) { return globalThis.JobHuntAgentPage.describeAccessible(this, role, name, observed); }",
          arguments: [{ value: node.role.value }, { value: node.name?.value || "" }, { value: observed }],
          returnByValue: true,
        }, frame.sessionId);
        if (result.result?.value) {
          elements.push(result.result.value);
          this.axRefs.set(node.backendDOMNodeId, result.result.value.ref);
        }
      } catch { failed = true; }
      finally { if (objectId) await this.send("Runtime.releaseObject", { objectId }, frame.sessionId).catch(() => {}); }
    }
    return { elements, incomplete: failed || candidates.length > 400 };
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

  async applicationTabs() {
    const out = [];
    for (const id of [...this.candidateTabs.keys()].slice(-10)) {
      try {
        const tab = await this.api.tabs.get(id);
        if (/^https?:/.test(tab.url || "")) out.push({ id, url: tab.url.slice(0, 2000), title: (tab.title || "").slice(0, 300) });
      } catch { this.candidateTabs.delete(id); }
    }
    this.observedTabs = new Map(out.map((t) => [t.id, t.url]));
    return out;
  }

  async switchTab(id) {
    if (!this.candidateTabs.has(id)) throw new Error("That tab was not opened by this application flow.");
    const tab = await this.api.tabs.get(id);
    if (!/^https?:/.test(tab.url || "") || this.observedTabs?.get(id) !== tab.url) throw new Error("Application tab changed; inspect again.");
    const previous = this.tabId;
    await this.detach();
    this.tabId = id;
    this.worlds.clear();
    this.sessions.clear();
    try {
      await this.attach();
      await this.onTabChanged?.(id, tab.url);
      this.candidateTabs.delete(id);
    } catch (error) {
      this.tabId = previous;
      throw error;
    }
  }

  async click(x, y) {
    this.lastInteractionAt = Date.now();
    const at = { x: Math.round(x), y: Math.round(y) };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at });
  }

  insertText(text) {
    return this.send("Input.insertText", { text });
  }

  /**
   * One key event per character, as a person types. Masked inputs (phone, currency) rebuild
   * their value on every keystroke and drop a whole string inserted at once.
   */
  async typeKeys(text) {
    this.lastInteractionAt = Date.now();
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  }

  /** Pointer over a point, for menus and buttons that appear on hover. */
  async hover(x, y) {
    this.lastInteractionAt = Date.now();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
  }

  /** Press at one point, move in steps (drag handlers listen for moves), release at another. */
  async drag(from, to) {
    this.lastInteractionAt = Date.now();
    const at = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(from) });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at(from) });
    for (let i = 1; i <= 8; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 };
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...at(p) });
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at(to) });
  }

  async press(name) {
    const info = KEYS[name];
    if (!info) throw new Error(`Unsupported key ${name}`);
    await this.send("Input.dispatchKeyEvent", { type: info.text ? "keyDown" : "rawKeyDown", ...info });
    const { text: _text, ...up } = info;
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
  }

  /** Whether ref labels can be drawn into the screenshot image instead of onto the page. */
  get canDrawLabels() {
    return typeof globalThis.OffscreenCanvas === "function" && typeof globalThis.createImageBitmap === "function";
  }

  /**
   * The visible viewport as JPEG, at most SHOT_MAX pixels on its longest side. shotScale is
   * image pixels per CSS pixel, so a point the model picks maps back to the page.
   *
   * The capture never uses `clip`: Chrome applies a clip by emulating a different viewport for
   * the moment of capture, which re-lays out and visibly flickers the user's page. The image is
   * shrunk afterwards instead, and `labels` ([{ref, bounds:[x,y,w,h]}] in CSS pixels) are drawn
   * into it, so nothing is ever added to the page itself.
   */
  async screenshot(labels = []) {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    let cssWidth = 0;
    try { cssWidth = (await this.send("Page.getLayoutMetrics")).cssVisualViewport.clientWidth; } catch { /* unknown */ }
    this.labelsDrawn = false;
    let out = data;
    if (this.canDrawLabels) {
      try {
        out = await shrink(data, cssWidth, labels);
        this.labelsDrawn = true;
      } catch { out = data; }
    }
    const size = jpegSize(out);
    this.shotScale = size && cssWidth ? size.width / cssWidth : 1;
    return out;
  }
}

/** Downscale a base64 JPEG to SHOT_MAX and draw ref labels on it (service worker canvas). */
async function shrink(base64, cssWidth, labels) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await globalThis.createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const scale = Math.min(1, SHOT_MAX / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new globalThis.OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const px = cssWidth ? width / cssWidth : scale;
  ctx.font = "12px monospace";
  ctx.textBaseline = "top";
  for (const { ref, bounds } of labels) {
    if (!bounds || !bounds[2] || !bounds[3]) continue;
    const x = Math.max(0, bounds[0] * px);
    const y = Math.max(0, bounds[1] * px - 15);
    if (x >= width || bounds[1] * px > height || (bounds[1] + bounds[3]) * px < 0) continue;
    const w = ctx.measureText(ref).width + 6;
    ctx.fillStyle = "#111";
    ctx.fillRect(x, y, w, 15);
    ctx.fillStyle = "#fff";
    ctx.fillText(ref, x + 3, y + 1);
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.55 });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

export { KEYS, SKIP_FRAME, SHOT_MAX };
