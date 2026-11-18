const PROTOCOL = "1.3";
const WORLD = "applyshortly-agent";
const SKIP_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|doubleclick|googlesyndication/i;
const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }
};
const CALL = "function (name, args) { return globalThis.JobHuntAgentPage[name](...args); }";
const IN_DIALOG = `function () { return Boolean(this.closest('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')); }`;
const OWNER_OFFSET = `function () {
  const r = this.getBoundingClientRect();
  const s = getComputedStyle(this);
  return { x: r.left + this.clientLeft + parseFloat(s.paddingLeft), y: r.top + this.clientTop + parseFloat(s.paddingTop) };
}`;
const SHOT_MAX = 1280;
class DialogOpenError extends Error {
  dialog;
  constructor(dialog) {
    super(`The page opened a browser dialog${dialog?.message ? `: "${String(dialog.message).slice(0, 200)}"` : ""}.`);
    this.name = "DialogOpenError";
    this.dialog = dialog;
  }
}
function jpegSize(base64) {
  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64.slice(0, 2e5)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 255) return null;
    const marker = bytes[i + 1];
    const length = bytes[i + 2] << 8 | bytes[i + 3];
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      return { height: bytes[i + 5] << 8 | bytes[i + 6], width: bytes[i + 7] << 8 | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}
const DIAGNOSTIC_LIMIT = 50;
const redactUrl = (raw) => {
  try {
    const url = new URL(String(raw));
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return String(raw ?? "").split(/[?#]/)[0].slice(0, 200);
  }
};
const cleanText = (text) => String(text ?? "").replace(/[A-Za-z0-9+/_=-]{32,}/g, "\u2026").replace(/\s+/g, " ").trim().slice(0, 200);
const SUBMIT_GUARD = `(() => { if (window.__asSubmitGuard) return; window.__asSubmitGuard = true;
  addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  HTMLFormElement.prototype.submit = function () {}; HTMLFormElement.prototype.requestSubmit = function () {}; })()`;
class TabDriver {
  tabId;
  sources;
  api;
  sessions;
  // OOPIF sessionId → targetInfo
  worlds;
  // "session:frame" → executionContextId
  attached;
  candidateTabs;
  axRefs;
  lastInteractionAt;
  onTabChanged;
  dialog;
  dialogWaiters;
  dialogClosedWaiters;
  shotScale;
  labelsDrawn;
  logged;
  requests;
  handleCreated;
  onDetached;
  observedTabs;
  constructor(tabId, sources, api = globalThis.chrome) {
    this.tabId = tabId;
    this.sources = sources;
    this.api = api;
    this.sessions = /* @__PURE__ */ new Map();
    this.worlds = /* @__PURE__ */ new Map();
    this.attached = false;
    this.candidateTabs = /* @__PURE__ */ new Map();
    this.axRefs = /* @__PURE__ */ new Map();
    this.lastInteractionAt = 0;
    this.onTabChanged = null;
    this.dialog = null;
    this.dialogWaiters = /* @__PURE__ */ new Set();
    this.dialogClosedWaiters = /* @__PURE__ */ new Set();
    this.shotScale = 1;
    this.labelsDrawn = false;
    this.logged = { console: [], network: [] };
    this.requests = /* @__PURE__ */ new Map();
    this.handleCreated = (tab) => {
      if (tab.openerTabId === this.tabId && Date.now() - this.lastInteractionAt < 5e3 && tab.id)
        this.candidateTabs.set(tab.id, tab);
    };
    this.onDetached = null;
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
    await this.send("Log.enable").catch(() => {
    });
    await this.send("Network.enable").catch(() => {
    });
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }
  async detach() {
    if (!this.attached) return;
    this.attached = false;
    this.api.tabs?.onCreated?.removeListener(this.handleCreated);
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    await this.api.debugger.detach({ tabId: this.tabId }).catch(() => {
    });
  }
  handleEvent(source, method, params) {
    if (source.tabId !== this.tabId) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      this.sessions.set(params.sessionId, params.targetInfo);
      void this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => {
      });
      void this.send("DOM.enable", {}, params.sessionId).catch(() => {
      });
    } else if (method === "Target.detachedFromTarget") {
      this.sessions.delete(params.sessionId);
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = { type: params.type, message: params.message ?? "" };
      for (const reject of this.dialogWaiters) reject(new DialogOpenError(this.dialog));
      this.dialogWaiters.clear();
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
      for (const resolve of this.dialogClosedWaiters) resolve();
      this.dialogClosedWaiters.clear();
    } else if (method === "Log.entryAdded") {
      const entry = params?.entry;
      if (entry && ["error", "warning"].includes(entry.level))
        this.record("console", {
          level: entry.level,
          source: String(entry.source ?? "").slice(0, 30),
          text: cleanText(entry.text),
          url: redactUrl(entry.url ?? "")
        });
    } else if (method === "Network.requestWillBeSent") {
      this.requests.set(params.requestId, {
        method: String(params.request?.method ?? "GET").slice(0, 10),
        url: redactUrl(params.request?.url)
      });
      if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value);
    } else if (method === "Network.responseReceived") {
      const status = params.response?.status ?? 0;
      if (status >= 400)
        this.record("network", {
          status,
          method: this.requests.get(params.requestId)?.method ?? "GET",
          url: redactUrl(params.response?.url)
        });
    } else if (method === "Network.loadingFailed") {
      const known = this.requests.get(params.requestId);
      if (!params.canceled)
        this.record("network", {
          status: 0,
          method: known?.method ?? "GET",
          url: known?.url ?? "",
          error: cleanText(params.errorText)
        });
    } else if (method === "Page.frameNavigated" || method === "Page.loadEventFired") {
      this.axRefs.clear();
      this.worlds.clear();
    }
  }
  record(kind, entry) {
    const list = this.logged[kind];
    list.push(entry);
    if (list.length > DIAGNOSTIC_LIMIT) list.shift();
  }
  diagnostics() {
    return {
      console: this.logged.console.map((e) => ({ ...e })),
      network: this.logged.network.map((e) => ({ ...e }))
    };
  }
  handleDetach(source, reason) {
    if (source.tabId !== this.tabId || !this.attached) return;
    this.attached = false;
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    this.api.tabs?.onCreated?.removeListener(this.handleCreated);
    this.onDetached?.(reason);
  }
  send(method, params = {}, sessionId) {
    const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    if (this.dialog && !method.startsWith("Page.") && !method.startsWith("Target."))
      return Promise.reject(new DialogOpenError(this.dialog));
    let reject;
    const blocked = new Promise((_, r) => {
      reject = r;
      this.dialogWaiters.add(r);
    });
    const command = Promise.resolve(this.api.debugger.sendCommand(target, method, params));
    return Promise.race([command, blocked]).finally(() => this.dialogWaiters.delete(reject));
  }
  async evaluate(code) {
    await this.send("Runtime.evaluate", { expression: SUBMIT_GUARD, returnByValue: true }).catch(() => {
    });
    const res = await this.send("Runtime.evaluate", {
      expression: String(code),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 8e3
    });
    if (res?.exceptionDetails)
      return {
        error: String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "The script failed.").slice(
          0,
          1e3
        )
      };
    const value = res?.result?.value;
    const text = value === void 0 ? String(res?.result?.description ?? res?.result?.type ?? "undefined") : typeof value === "string" ? value : JSON.stringify(value);
    return { value: text.slice(0, 4e3) };
  }
  dialogClosed() {
    if (!this.dialog) return Promise.resolve();
    return new Promise((resolve) => this.dialogClosedWaiters.add(resolve));
  }
  async frames() {
    const byId = /* @__PURE__ */ new Map();
    const walk = (tree, sessionId) => {
      const { id, parentId, url } = tree.frame;
      const known = byId.get(id);
      if (!known || sessionId && !known.sessionId) {
        byId.set(id, {
          frameId: id,
          sessionId,
          parentId: parentId ?? known?.parentId ?? null,
          url,
          isTop: !sessionId && !parentId
        });
      } else if (!known.parentId && parentId) {
        known.parentId = parentId;
      }
      for (const child of tree.childFrames ?? []) walk(child, sessionId);
    };
    walk((await this.send("Page.getFrameTree")).frameTree, void 0);
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        walk((await this.send("Page.getFrameTree", {}, sessionId)).frameTree, sessionId);
      } catch {
        this.sessions.delete(sessionId);
      }
    }
    return [...byId.values()].filter((f) => /^(https?:|about:blank)/.test(f.url) && !SKIP_FRAME.test(f.url));
  }
  async world(frame) {
    const key = `${frame.sessionId ?? ""}:${frame.frameId}`;
    if (this.worlds.has(key)) return this.worlds.get(key);
    const { executionContextId } = await this.send(
      "Page.createIsolatedWorld",
      { frameId: frame.frameId, worldName: WORLD, grantUniveralAccess: false },
      frame.sessionId
    );
    const expression = Array.isArray(this.sources) ? this.sources.join("\n") : this.sources;
    const loaded = await this.send(
      "Runtime.evaluate",
      { contextId: executionContextId, expression, returnByValue: true },
      frame.sessionId
    );
    if (loaded.exceptionDetails) throw new Error("Couldn't load the agent into this frame.");
    this.worlds.set(key, executionContextId);
    return executionContextId;
  }
  async call(frame, name, ...args) {
    const key = `${frame.sessionId ?? ""}:${frame.frameId}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const executionContextId = await this.world(frame);
        const res = await this.send(
          "Runtime.callFunctionOn",
          {
            executionContextId,
            functionDeclaration: CALL,
            arguments: [{ value: name }, { value: args }],
            awaitPromise: true,
            returnByValue: true
          },
          frame.sessionId
        );
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
        return res.result?.value;
      } catch (error) {
        if (error instanceof DialogOpenError) throw error;
        this.worlds.delete(key);
        if (attempt >= 1) throw error;
      }
    }
  }
  async accessible(frame, observed, query = "") {
    const { nodes } = await this.send("Accessibility.getFullAXTree", { frameId: frame.frameId }, frame.sessionId);
    const candidates = nodes.filter(
      (n) => !n.ignored && n.backendDOMNodeId && (!query || (n.name?.value || "").toLowerCase().includes(query.toLowerCase())) && /^(textbox|textField|searchbox|combobox|listbox|option|button|link|radio|checkbox|popUpButton)$/.test(n.role?.value)
    );
    const elements = [];
    let failed = false;
    for (const node of candidates.slice(0, 400)) {
      if (observed.includes(this.axRefs.get(node.backendDOMNodeId))) continue;
      let objectId;
      try {
        const { object } = await this.send(
          "DOM.resolveNode",
          { backendNodeId: node.backendDOMNodeId, executionContextId: await this.world(frame) },
          frame.sessionId
        );
        objectId = object.objectId;
        const result = await this.send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: "function(role, name, observed) { return globalThis.JobHuntAgentPage.describeAccessible(this, role, name, observed); }",
            arguments: [{ value: node.role.value }, { value: node.name?.value || "" }, { value: observed }],
            returnByValue: true
          },
          frame.sessionId
        );
        if (result.result?.value) {
          elements.push(result.result.value);
          this.axRefs.set(node.backendDOMNodeId, result.result.value.ref);
        }
      } catch {
        failed = true;
      } finally {
        if (objectId) await this.send("Runtime.releaseObject", { objectId }, frame.sessionId).catch(() => {
        });
      }
    }
    return { elements, incomplete: failed || candidates.length > 400 };
  }
  async offset(frame, frames) {
    let x = 0;
    let y = 0;
    for (let f = frame; f && !f.isTop && f.parentId; f = frames.find((p) => p.frameId === f.parentId)) {
      const parent = frames.find((p) => p.frameId === f.parentId);
      if (!parent) break;
      const { backendNodeId } = await this.send("DOM.getFrameOwner", { frameId: f.frameId }, parent.sessionId);
      const contextId = await this.world(parent);
      const { object } = await this.send(
        "DOM.resolveNode",
        { backendNodeId, executionContextId: contextId },
        parent.sessionId
      );
      const res = await this.send(
        "Runtime.callFunctionOn",
        { objectId: object.objectId, functionDeclaration: OWNER_OFFSET, returnByValue: true },
        parent.sessionId
      );
      x += res.result.value.x;
      y += res.result.value.y;
    }
    return { x, y };
  }
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
    const res = await this.send(
      "Runtime.callFunctionOn",
      { objectId: object.objectId, functionDeclaration: IN_DIALOG, returnByValue: true },
      top.sessionId
    );
    return Boolean(res.result?.value);
  }
  async applicationTabs() {
    const out = [];
    for (const id of [...this.candidateTabs.keys()].slice(-10)) {
      try {
        const tab = await this.api.tabs.get(id);
        if (/^https?:/.test(tab.url || ""))
          out.push({ id, url: tab.url.slice(0, 2e3), title: (tab.title || "").slice(0, 300) });
      } catch {
        this.candidateTabs.delete(id);
      }
    }
    this.observedTabs = new Map(out.map((t) => [t.id, t.url]));
    return out;
  }
  async switchTab(id) {
    if (!this.candidateTabs.has(id)) throw new Error("That tab was not opened by this application flow.");
    const tab = await this.api.tabs.get(id);
    if (!/^https?:/.test(tab.url || "") || this.observedTabs?.get(id) !== tab.url)
      throw new Error("Application tab changed; inspect again.");
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
  async typeKeys(text) {
    this.lastInteractionAt = Date.now();
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  }
  async hover(x, y) {
    this.lastInteractionAt = Date.now();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
  }
  async drag(from, to) {
    this.lastInteractionAt = Date.now();
    const at = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(from) });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at(from) });
    for (let i = 1; i <= 8; i++) {
      const p = { x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8 };
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
  get canDrawLabels() {
    return typeof globalThis.OffscreenCanvas === "function" && typeof globalThis.createImageBitmap === "function";
  }
  async screenshot(labels = []) {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    let cssWidth = 0;
    try {
      cssWidth = (await this.send("Page.getLayoutMetrics")).cssVisualViewport.clientWidth;
    } catch {
    }
    this.labelsDrawn = false;
    let out = data;
    if (this.canDrawLabels) {
      try {
        out = await shrink(data, cssWidth, labels);
        this.labelsDrawn = true;
      } catch {
        out = data;
      }
    }
    const size = jpegSize(out);
    this.shotScale = size && cssWidth ? size.width / cssWidth : 1;
    return out;
  }
}
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
  for (let i = 0; i < buffer.length; i += 32768) binary += String.fromCharCode(...buffer.subarray(i, i + 32768));
  return btoa(binary);
}
export {
  DialogOpenError,
  KEYS,
  SHOT_MAX,
  SKIP_FRAME,
  TabDriver,
  jpegSize,
  redactUrl
};
