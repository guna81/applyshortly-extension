// Drives one tab through chrome.debugger (the Chrome DevTools Protocol) for the form agent:
// - every frame, cross-origin iframes included (auto-attached flat sessions, Chrome 125+);
// - page code runs in an isolated world, so the site's scripts can't see or tamper with it;
// - clicks and typing are real input events (isTrusted), which React/Workday-style forms expect.
// While attached, Chrome shows its "started debugging this browser" bar; closing it stops the agent.

const PROTOCOL = "1.3";
const WORLD = "applyshortly-agent";
// Frames that only hold a CAPTCHA widget or ads: never shown to the planner.
const SKIP_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|doubleclick|googlesyndication/i;

export interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const KEYS: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
};

const CALL = "function (name, args) { return globalThis.JobHuntAgentPage[name](...args); }";
const IN_DIALOG =
  'function () { return Boolean(this.closest(\'[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]\')); }';
const OWNER_OFFSET = `function () {
  const r = this.getBoundingClientRect();
  const s = getComputedStyle(this);
  return { x: r.left + this.clientLeft + parseFloat(s.paddingLeft), y: r.top + this.clientTop + parseFloat(s.paddingTop) };
}`;

// Longest side of the screenshot sent to the model, in pixels. Retina tabs otherwise send twice
// the CSS size, and the model's screenshot points would not match the page's coordinates.
const SHOT_MAX = 1280;

export interface DialogInfo {
  type: string;
  message: string;
}

/** A JavaScript alert/confirm/prompt/beforeunload is open: the page is frozen until it closes. */
export class DialogOpenError extends Error {
  dialog?: DialogInfo | null;
  constructor(dialog?: DialogInfo | null) {
    super(`The page opened a browser dialog${dialog?.message ? `: "${String(dialog.message).slice(0, 200)}"` : ""}.`);
    this.name = "DialogOpenError";
    this.dialog = dialog;
  }
}

/** Width and height of a base64 JPEG, read from its frame header; null if unreadable. */
export function jpegSize(base64: string): { width: number; height: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64.slice(0, 200_000)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker! >= 0xc0 && marker! <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker!)) {
      return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    }
    i += 2 + length;
  }
  return null;
}

const DIAGNOSTIC_LIMIT = 50;

/** A URL without its query or fragment: tokens and personal data ride there. */
export const redactUrl = (raw: unknown): string => {
  try {
    const url = new URL(String(raw));
    return `${url.origin}${url.pathname}`.slice(0, 200);
  } catch {
    return String(raw ?? "").split(/[?#]/)[0]!.slice(0, 200);
  }
};

/** Console text for the model: bounded, and long token-like strings are cut out. */
const cleanText = (text: unknown): string =>
  String(text ?? "")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

// Installed before any page script of the agent runs: the form agent never submits.
const SUBMIT_GUARD = `(() => { if (window.__asSubmitGuard) return; window.__asSubmitGuard = true;
  addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  HTMLFormElement.prototype.submit = function () {}; HTMLFormElement.prototype.requestSubmit = function () {}; })()`;

export interface FrameInfo {
  frameId: string;
  sessionId?: string;
  parentId?: string | null;
  url: string;
  isTop: boolean;
}

export interface LabelOverlay {
  ref: string;
  bounds: [number, number, number, number];
}

export interface CdpTabInfo {
  id?: number;
  openerTabId?: number;
  url?: string;
  title?: string;
}

export interface CdpDebuggee {
  tabId?: number;
  sessionId?: string;
}

export interface CdpApi {
  debugger: {
    attach: (target: CdpDebuggee, requiredVersion: string) => Promise<void>;
    detach: (target: CdpDebuggee) => Promise<void>;
    sendCommand: (target: CdpDebuggee, method: string, params?: Record<string, any>) => Promise<any>;
    onEvent: {
      addListener: (cb: (source: CdpDebuggee, method: string, params?: any) => void) => void;
      removeListener: (cb: (source: CdpDebuggee, method: string, params?: any) => void) => void;
    };
    onDetach: {
      addListener: (cb: (source: CdpDebuggee, reason: string) => void) => void;
      removeListener: (cb: (source: CdpDebuggee, reason: string) => void) => void;
    };
  };
  tabs?: {
    onCreated?: {
      addListener: (cb: (tab: CdpTabInfo) => void) => void;
      removeListener: (cb: (tab: CdpTabInfo) => void) => void;
    };
    get?: (tabId: number) => Promise<CdpTabInfo>;
    update?: (tabId: number, props: Record<string, any>) => Promise<any>;
    query?: (queryInfo: Record<string, any>) => Promise<CdpTabInfo[]>;
  };
}

export class TabDriver {
  tabId: number;
  sources: string | string[];
  api: CdpApi;
  sessions: Map<string, any>; // OOPIF sessionId → targetInfo
  worlds: Map<string, number>; // "session:frame" → executionContextId
  attached: boolean;
  candidateTabs: Map<number, CdpTabInfo>;
  axRefs: Map<number, string>;
  lastInteractionAt: number;
  onTabChanged: ((tabId: number, url?: string) => Promise<void> | void) | null;
  dialog: DialogInfo | null;
  dialogWaiters: Set<(err: any) => void>;
  dialogClosedWaiters: Set<() => void>;
  shotScale: number;
  labelsDrawn: boolean;
  logged: {
    console: Array<{ level: string; source: string; text: string; url: string }>;
    network: Array<{ status: number; method: string; url: string; error?: string }>;
  };
  requests: Map<string, { method: string; url: string }>;
  handleCreated: (tab: CdpTabInfo) => void;
  onDetached: ((reason: string) => void) | null;
  observedTabs?: Map<number, string>;

  constructor(tabId: number, sources: string | string[], api: CdpApi = (globalThis as any).chrome) {
    this.tabId = tabId;
    this.sources = sources;
    this.api = api;
    this.sessions = new Map();
    this.worlds = new Map();
    this.attached = false;
    this.candidateTabs = new Map();
    this.axRefs = new Map();
    this.lastInteractionAt = 0;
    this.onTabChanged = null;
    this.dialog = null;
    this.dialogWaiters = new Set();
    this.dialogClosedWaiters = new Set();
    this.shotScale = 1;
    this.labelsDrawn = false;
    this.logged = { console: [], network: [] };
    this.requests = new Map();
    this.handleCreated = (tab) => {
      if (tab.openerTabId === this.tabId && Date.now() - this.lastInteractionAt < 5000 && tab.id)
        this.candidateTabs.set(tab.id, tab);
    };
    this.onDetached = null;
    this.handleEvent = this.handleEvent.bind(this);
    this.handleDetach = this.handleDetach.bind(this);
  }

  async attach(): Promise<void> {
    await this.api.debugger.attach({ tabId: this.tabId }, PROTOCOL);
    this.attached = true;
    this.api.tabs?.onCreated?.addListener(this.handleCreated);
    this.api.debugger.onEvent.addListener(this.handleEvent);
    this.api.debugger.onDetach.addListener(this.handleDetach);
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Log.enable").catch(() => {});
    await this.send("Network.enable").catch(() => {});
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    this.attached = false;
    this.api.tabs?.onCreated?.removeListener(this.handleCreated);
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    await this.api.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }

  handleEvent(source: CdpDebuggee, method: string, params?: any): void {
    if (source.tabId !== this.tabId) return;
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      this.sessions.set(params.sessionId, params.targetInfo);
      void this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => {});
      void this.send("DOM.enable", {}, params.sessionId).catch(() => {});
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
          url: redactUrl(entry.url ?? ""),
        });
    } else if (method === "Network.requestWillBeSent") {
      this.requests.set(params.requestId, {
        method: String(params.request?.method ?? "GET").slice(0, 10),
        url: redactUrl(params.request?.url),
      });
      if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value!);
    } else if (method === "Network.responseReceived") {
      const status = params.response?.status ?? 0;
      if (status >= 400)
        this.record("network", {
          status,
          method: this.requests.get(params.requestId)?.method ?? "GET",
          url: redactUrl(params.response?.url),
        });
    } else if (method === "Network.loadingFailed") {
      const known = this.requests.get(params.requestId);
      if (!params.canceled)
        this.record("network", {
          status: 0,
          method: known?.method ?? "GET",
          url: known?.url ?? "",
          error: cleanText(params.errorText),
        });
    } else if (method === "Page.frameNavigated" || method === "Page.loadEventFired") {
      this.axRefs.clear();
      this.worlds.clear();
    }
  }

  record(kind: "console" | "network", entry: any): void {
    const list = this.logged[kind];
    list.push(entry);
    if (list.length > DIAGNOSTIC_LIMIT) list.shift();
  }

  diagnostics(): {
    console: Array<{ level: string; source: string; text: string; url: string }>;
    network: Array<{ status: number; method: string; url: string; error?: string }>;
  } {
    return {
      console: this.logged.console.map((e) => ({ ...e })),
      network: this.logged.network.map((e) => ({ ...e })),
    };
  }

  handleDetach(source: CdpDebuggee, reason: string): void {
    if (source.tabId !== this.tabId || !this.attached) return;
    this.attached = false;
    this.api.debugger.onEvent.removeListener(this.handleEvent);
    this.api.debugger.onDetach.removeListener(this.handleDetach);
    this.api.tabs?.onCreated?.removeListener(this.handleCreated);
    this.onDetached?.(reason);
  }

  send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    const target: any = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    if (this.dialog && !method.startsWith("Page.") && !method.startsWith("Target."))
      return Promise.reject(new DialogOpenError(this.dialog));
    let reject: (reason?: any) => void;
    const blocked = new Promise<never>((_, r) => {
      reject = r;
      this.dialogWaiters.add(r);
    });
    const command = Promise.resolve(this.api.debugger.sendCommand(target, method, params));
    return Promise.race([command, blocked]).finally(() => this.dialogWaiters.delete(reject));
  }

  async evaluate(code: string): Promise<{ value?: string; error?: string }> {
    await this.send("Runtime.evaluate", { expression: SUBMIT_GUARD, returnByValue: true }).catch(() => {});
    const res = await this.send("Runtime.evaluate", {
      expression: String(code),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 8000,
    });
    if (res?.exceptionDetails)
      return {
        error: String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "The script failed.").slice(
          0,
          1000,
        ),
      };
    const value = res?.result?.value;
    const text =
      value === undefined
        ? String(res?.result?.description ?? res?.result?.type ?? "undefined")
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
    return { value: text.slice(0, 4000) };
  }

  dialogClosed(): Promise<void> {
    if (!this.dialog) return Promise.resolve();
    return new Promise((resolve) => this.dialogClosedWaiters.add(resolve));
  }

  async frames(): Promise<FrameInfo[]> {
    const byId = new Map<string, FrameInfo>();
    const walk = (tree: any, sessionId?: string) => {
      const { id, parentId, url } = tree.frame;
      const known = byId.get(id);
      if (!known || (sessionId && !known.sessionId)) {
        byId.set(id, {
          frameId: id,
          sessionId,
          parentId: parentId ?? known?.parentId ?? null,
          url,
          isTop: !sessionId && !parentId,
        });
      } else if (!known.parentId && parentId) {
        known.parentId = parentId;
      }
      for (const child of tree.childFrames ?? []) walk(child, sessionId);
    };
    walk((await this.send("Page.getFrameTree")).frameTree, undefined);
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        walk((await this.send("Page.getFrameTree", {}, sessionId)).frameTree, sessionId);
      } catch {
        this.sessions.delete(sessionId);
      }
    }
    return [...byId.values()].filter((f) => /^(https?:|about:blank)/.test(f.url) && !SKIP_FRAME.test(f.url));
  }

  async world(frame: FrameInfo): Promise<number> {
    const key = `${frame.sessionId ?? ""}:${frame.frameId}`;
    if (this.worlds.has(key)) return this.worlds.get(key)!;
    const { executionContextId } = await this.send(
      "Page.createIsolatedWorld",
      { frameId: frame.frameId, worldName: WORLD, grantUniveralAccess: false },
      frame.sessionId,
    );
    const expression = Array.isArray(this.sources) ? this.sources.join("\n") : this.sources;
    const loaded = await this.send(
      "Runtime.evaluate",
      { contextId: executionContextId, expression, returnByValue: true },
      frame.sessionId,
    );
    if (loaded.exceptionDetails) throw new Error("Couldn't load the agent into this frame.");
    this.worlds.set(key, executionContextId);
    return executionContextId;
  }

  async call(frame: FrameInfo, name: string, ...args: any[]): Promise<any> {
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
            returnByValue: true,
          },
          frame.sessionId,
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

  async accessible(
    frame: FrameInfo,
    observed: string[],
    query: string = "",
  ): Promise<{ elements: any[]; incomplete: boolean }> {
    const { nodes } = await this.send("Accessibility.getFullAXTree", { frameId: frame.frameId }, frame.sessionId);
    const candidates = (nodes as any[]).filter(
      (n) =>
        !n.ignored &&
        n.backendDOMNodeId &&
        (!query || (n.name?.value || "").toLowerCase().includes(query.toLowerCase())) &&
        /^(textbox|textField|searchbox|combobox|listbox|option|button|link|radio|checkbox|popUpButton)$/.test(n.role?.value),
    );
    const elements: any[] = [];
    let failed = false;
    for (const node of candidates.slice(0, 400)) {
      if (observed.includes(this.axRefs.get(node.backendDOMNodeId)!)) continue;
      let objectId: string | undefined;
      try {
        const { object } = await this.send(
          "DOM.resolveNode",
          { backendNodeId: node.backendDOMNodeId, executionContextId: await this.world(frame) },
          frame.sessionId,
        );
        objectId = object.objectId;
        const result = await this.send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration:
              "function(role, name, observed) { return globalThis.JobHuntAgentPage.describeAccessible(this, role, name, observed); }",
            arguments: [{ value: node.role.value }, { value: node.name?.value || "" }, { value: observed }],
            returnByValue: true,
          },
          frame.sessionId,
        );
        if (result.result?.value) {
          elements.push(result.result.value);
          this.axRefs.set(node.backendDOMNodeId, result.result.value.ref);
        }
      } catch {
        failed = true;
      } finally {
        if (objectId) await this.send("Runtime.releaseObject", { objectId }, frame.sessionId).catch(() => {});
      }
    }
    return { elements, incomplete: failed || candidates.length > 400 };
  }

  async offset(frame: FrameInfo, frames: FrameInfo[]): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;
    for (
      let f: FrameInfo | undefined = frame;
      f && !f.isTop && f.parentId;
      f = frames.find((p) => p.frameId === f!.parentId)
    ) {
      const parent = frames.find((p) => p.frameId === f.parentId);
      if (!parent) break;
      const { backendNodeId } = await this.send("DOM.getFrameOwner", { frameId: f.frameId }, parent.sessionId);
      const contextId = await this.world(parent);
      const { object } = await this.send(
        "DOM.resolveNode",
        { backendNodeId, executionContextId: contextId },
        parent.sessionId,
      );
      const res = await this.send(
        "Runtime.callFunctionOn",
        { objectId: object.objectId, functionDeclaration: OWNER_OFFSET, returnByValue: true },
        parent.sessionId,
      );
      x += res.result.value.x;
      y += res.result.value.y;
    }
    return { x, y };
  }

  async inDialog(frame: FrameInfo, frames: FrameInfo[]): Promise<boolean> {
    let outer = frame;
    for (
      let parent = frames.find((p) => p.frameId === outer.parentId);
      parent && !parent.isTop;
      parent = frames.find((p) => p.frameId === outer.parentId)
    ) {
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
      top.sessionId,
    );
    return Boolean(res.result?.value);
  }

  async applicationTabs(): Promise<Array<{ id: number; url: string; title: string }>> {
    const out: Array<{ id: number; url: string; title: string }> = [];
    for (const id of [...this.candidateTabs.keys()].slice(-10)) {
      try {
        const tab = await this.api.tabs.get(id);
        if (/^https?:/.test(tab.url || ""))
          out.push({ id, url: tab.url!.slice(0, 2000), title: (tab.title || "").slice(0, 300) });
      } catch {
        this.candidateTabs.delete(id);
      }
    }
    this.observedTabs = new Map(out.map((t) => [t.id, t.url]));
    return out;
  }

  async switchTab(id: number): Promise<void> {
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

  async click(x: number, y: number): Promise<void> {
    this.lastInteractionAt = Date.now();
    const at = { x: Math.round(x), y: Math.round(y) };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at });
  }

  insertText(text: string): Promise<any> {
    return this.send("Input.insertText", { text });
  }

  async typeKeys(text: string): Promise<void> {
    this.lastInteractionAt = Date.now();
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
  }

  async hover(x: number, y: number): Promise<void> {
    this.lastInteractionAt = Date.now();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    this.lastInteractionAt = Date.now();
    const at = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(from) });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...at(from) });
    for (let i = 1; i <= 8; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 };
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...at(p) });
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...at(to) });
  }

  async press(name: string): Promise<void> {
    const info = KEYS[name];
    if (!info) throw new Error(`Unsupported key ${name}`);
    await this.send("Input.dispatchKeyEvent", { type: info.text ? "keyDown" : "rawKeyDown", ...info });
    const { text: _text, ...up } = info;
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
  }

  get canDrawLabels(): boolean {
    return (
      typeof (globalThis as any).OffscreenCanvas === "function" &&
      typeof (globalThis as any).createImageBitmap === "function"
    );
  }

  async screenshot(labels: LabelOverlay[] = []): Promise<string> {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    let cssWidth = 0;
    try {
      cssWidth = (await this.send("Page.getLayoutMetrics")).cssVisualViewport.clientWidth;
    } catch {
      /* unknown */
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

async function shrink(base64: string, cssWidth: number, labels: LabelOverlay[]): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await (globalThis as any).createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const scale = Math.min(1, SHOT_MAX / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new (globalThis as any).OffscreenCanvas(width, height);
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
