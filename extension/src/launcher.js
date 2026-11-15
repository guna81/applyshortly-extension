// The "launcher" used by the side panel: connection status, the starting of a run as soon as the
// panel opens, the two bottom switches, and the connected assistant's activity box. Each page passes in what differs
// (how to dismiss itself, which tab it acts on).
import { activityList, attention } from "./external-activity.js";

/** The page's own elements, mostly form controls. @type {(id: string) => any} */
export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "onclick") node.addEventListener("click", v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c);
  return node;
}
export const button = (label, onclick, cls = "") => el("button", { type: "button", class: cls, onclick }, label);

// If the extension's background worker doesn't answer, show a retry instead of spinning forever.
const STATUS_TIMEOUT_MS = 8000;

/**
 * @param {{
 *   getTab: () => any,
 *   dismiss?: () => void,
 *   wrap?: (node: HTMLElement) => HTMLElement,
 *   openHint: string,
 *   beforeStart?: () => Promise<void>,
 *   afterStart: (data: any) => Promise<void>,
 * }} o
 */
export function createLauncher({ getTab, dismiss = () => {}, wrap = (n) => n, openHint, beforeStart, afterStart }) {
  const P = globalThis.JobHuntPanel;
  const show = (...nodes) => $("view").replaceChildren(...nodes.map((n) => wrap(n)));
  const setConn = (kind, text) => {
    $("dot").className = `status-dot ${kind}`;
    $("connText").textContent = text;
  };
  const openOptions = () => { chrome.runtime.openOptionsPage(); dismiss(); };

  async function openTab(url) {
    const u = new URL(url);
    const path = u.pathname === "/applications" && u.searchParams.has("add") ? u.pathname + u.search : u.pathname;
    const result = await chrome.runtime.sendMessage({ type: "openWebsite", path });
    if (!result?.ok) { setConn("bad", result?.error || "Could not open ApplyShortly."); return; }
    dismiss();
  }

  async function shortcut() {
    try {
      return (await chrome.commands.getAll()).find((c) => c.name === "autofill")?.shortcut || null;
    } catch {
      return null;
    }
  }

  async function status() {
    const tab = getTab();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), STATUS_TIMEOUT_MS); });
    const res = await Promise.race([chrome.runtime.sendMessage({ type: "status", tabId: tab?.id, url: tab?.url }), timeout]).finally(() => clearTimeout(timer));
    if (res === "timeout") return { configured: true, connected: false, error: "The extension didn't answer in time. Try again." };
    return res?.data ?? { configured: false };
  }

  async function start(allowUntracked, btn, autoSubmit) {
    const tab = getTab();
    if (!tab?.id) return;
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    else show(el("div", { class: "loading" }, el("span", { class: "spin" }), "Opening the chat…"));
    autoSubmit ??= Boolean((await chrome.storage.local.get("autoApply")).autoApply);
    await beforeStart?.();
    const r = await chrome.runtime.sendMessage({ type: "start", tabId: tab.id, url: tab.url, allowUntracked, autoSubmit });
    if (!r?.ok) {
      const e = P.friendlyError(r?.error, r?.status);
      show(el("div", { class: "card bad" }, el("b", {}, e.title), el("p", {}, e.detail)));
      return;
    }
    if (!r.data?.found) return render(await status(), { notFound: true });
    await afterStart(r.data);
  }

  // The chat opens by itself, once per site in a tab; later pages of the same form never restart it.
  const started = new Set();
  const startKey = (tab) => { try { return `${tab.id}|${new URL(tab.url).origin}`; } catch { return `${tab?.id}`; } };

  async function render(s, { notFound = false } = {}) {
    const tab = getTab();
    $("prefs").hidden = true;
    $("foot").hidden = true;

    if (!s.configured) {
      setConn("off", "Not connected");
      return show(el("div", { class: "card" },
        el("b", {}, "Connect to your ApplyShortly account"),
        el("p", { class: "muted" }, "Sign in with ApplyShortly to use your profile, credits or your on-device AI provider."),
        el("ol", { class: "first-run muted" },
          el("li", {}, "Sign in and check your profile"),
          el("li", {}, "Open a job application page"),
          el("li", {}, "Open a job application; the chat starts by itself. Answer anything it asks")),
        button("Set up now", openOptions, "primary block"),
      ));
    }

    if (!s.connected) {
      const e = P.friendlyError(s.error, s.status, s.baseUrl);
      setConn("bad", "Can't connect");
      return show(el("div", { class: "card bad" },
        el("b", {}, e.title),
        el("p", {}, e.detail),
        el("div", { class: "row-btns" },
          button("Try again", async () => {
            show(el("div", { class: "loading" }, el("span", { class: "spin" }), "Reconnecting…"));
            await chrome.runtime.sendMessage({ type: "test" });
            render(await status());
          }, "primary"),
          button("Settings", openOptions),
        ),
      ));
    }

    setConn("good", `Connected as ${s.name ?? "you"}`);
    await loadSwitches();
    $("connText").textContent += s.ai?.mode === "personal" ? ` · Re-enter AI key in extension settings` : ` · ${s.credits ?? 0} credits`;
    const key = await shortcut();
    $("foot").replaceChildren(
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openTab(`${s.baseUrl}/applications`); } }, "Open ApplyShortly"),
      key ? el("span", {}, "Shortcut ", el("kbd", {}, key)) : null,
    );
    $("foot").hidden = false;

    if (!(tab?.url && /^https?:/.test(tab.url))) {
      return show(el("div", { class: "card" },
        el("b", {}, "Open a job application to get started"),
        el("p", { class: "muted" }, openHint),
        button("Go to Applications", () => openTab(`${s.baseUrl}/applications`), "block"),
      ));
    }

    const runKey = startKey(tab);
    const sent = s.app && !["saved", "queued", "filling", "ready_for_review"].includes(s.app.status);
    if (!sent && !notFound && !started.has(runKey)) {
      started.add(runKey);
      return start(!s.app, null);
    }
    const again = (e) => void start(!s.app, e.currentTarget);
    return show(el("div", { class: "card" },
      s.app ? el("div", { class: "eyebrow" }, "This page is in ApplyShortly") : null,
      el("b", { class: s.app ? "title" : "" }, s.app ? s.app.title || "Application" : "Fill this page"),
      s.app ? el("div", { class: "muted" }, s.app.company_name ?? "") : el("p", { class: "muted" }, "It won't be tracked in ApplyShortly."),
      sent ? el("p", { class: "hint good" }, "✓ You've already applied to this job.") : null,
      button(sent ? "Fill it again anyway" : "Start the chat again", again, "block"),
      s.app ? null : button("Add this job to ApplyShortly", () => openTab(`${s.baseUrl}/applications?${new URLSearchParams({ add: "1", url: tab.url || "" })}`), "ghost block"),
    ));
  }

  $("settings").addEventListener("click", openOptions);
  // The two switches at the bottom: both live in storage, so the page's panel reacts at once.
  async function loadSwitches() {
    const prefs = await chrome.storage.local.get(["aiDrafts", "autoApply"]);
    $("aiDrafts").checked = prefs.aiDrafts !== false;
    $("autoApply").checked = prefs.autoApply === true;
    $("prefs").hidden = false;
  }
  for (const key of ["aiDrafts", "autoApply"]) {
    $(key).addEventListener("change", (e) => void chrome.storage.local.set({ [key]: /** @type {HTMLInputElement} */ (e.target).checked }));
  }
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && ("aiDrafts" in changes || "autoApply" in changes) && !$("prefs").hidden) void loadSwitches();
  });

  return { show, setConn, status, render, start, openTab, loadSwitches };
}

/**
 * The connected assistant's live steps. A quiet link when nothing is connected. Returns a function
 * that redraws the box and says whether it is showing (so the caller can keep polling).
 * @param {{ dismiss?: () => void, skip?: () => boolean }} [o]
 */
export function createAssistantBox({ dismiss = () => {}, skip = () => false } = {}) {
  const controlUrl = chrome.runtime.getURL("src/external-browser.html");
  const openControl = (e) => { e?.preventDefault(); void chrome.tabs.create({ url: controlUrl }); dismiss(); };
  return async function renderAssistantBox() {
    if (skip()) return false;
    const box = $("assist");
    if (!box) return false;
    let data = null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "externalBrowser", action: "status" });
      data = res?.ok ? res.data : null;
    } catch { data = null; }
    if (data?.enabled === false) {
      box.hidden = true;
      box.replaceChildren();
      return false;
    }
    box.hidden = false;
    if (!data?.connected) {
      box.replaceChildren(el("a", { href: controlUrl, onclick: openControl }, "Let your assistant fill applications"));
      return true;
    }
    const waiting = attention(data);
    box.replaceChildren(
      el("div", { class: "row-head" },
        el("b", {}, "Assistant activity"),
        waiting ? el("span", { class: "badge" }, "Needs you") : el("span", { class: "muted" }, "Connected")),
      activityList(data.activity ?? [], 6),
      el("a", { href: controlUrl, onclick: openControl }, waiting ? "Review and approve" : "Open full view"),
    );
    return true;
  };
}
