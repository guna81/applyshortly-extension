import { activityList, attention } from "../shared/external-activity.js";
const $ = (id) => document.getElementById(id);
const P = globalThis.JobHuntPanel;
function el(tag, attrs = {}, ...children) {
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
const button = (label, onclick, cls = "") => el("button", { type: "button", class: cls, onclick }, label);
function show(...nodes) {
  $("view").replaceChildren(...nodes);
}
function setConn(kind, text) {
  $("dot").className = `status-dot ${kind}`;
  $("connText").textContent = text;
}
async function openTab(url) {
  const u = new URL(url);
  const path = u.pathname === "/applications" && u.searchParams.has("add") ? u.pathname + u.search : u.pathname;
  const result = await chrome.runtime.sendMessage({ type: "openWebsite", path });
  if (!result?.ok) {
    setConn("bad", result?.error || "Could not open ApplyShortly.");
    return;
  }
  window.close();
}
$("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const fillable = Boolean(tab?.url && /^https?:/.test(tab.url));
async function shortcut() {
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "autofill");
    return cmd?.shortcut || null;
  } catch {
    return null;
  }
}
async function start(allowUntracked, btn, autoSubmit = false) {
  btn.disabled = true;
  (btn.querySelector(".t") ?? btn).textContent = "Starting\u2026";
  const r = await chrome.runtime.sendMessage({ type: "start", tabId: tab.id, url: tab.url, allowUntracked, autoSubmit });
  if (!r?.ok) {
    const e = P.friendlyError(r?.error, r?.status);
    show(el("div", { class: "card bad" }, el("b", {}, e.title), el("p", {}, e.detail)));
    return;
  }
  if (!r.data.found) return render(await status(), { notFound: true });
  window.close();
}
async function status() {
  const res = await chrome.runtime.sendMessage({ type: "status", tabId: tab?.id, url: tab?.url });
  return res?.data ?? { configured: false };
}
async function render(s, { notFound = false } = {}) {
  $("prefs").hidden = true;
  $("foot").hidden = true;
  $("setup").hidden = true;
  if (!s.configured) {
    setConn("off", "Not connected");
    return show(el(
      "div",
      { class: "card" },
      el("b", {}, "Connect to your ApplyShortly account"),
      el("p", { class: "muted" }, "Sign in to use your profile."),
      button("Set up now", () => {
        chrome.runtime.openOptionsPage();
        window.close();
      }, "primary block")
    ));
  }
  if (!s.connected) {
    const e = P.friendlyError(s.error, s.status, s.baseUrl);
    setConn("bad", "Can't connect");
    return show(el(
      "div",
      { class: "card bad" },
      el("b", {}, e.title),
      el("p", {}, e.detail),
      el(
        "div",
        { class: "row-btns" },
        button("Try again", async () => {
          show(el("div", { class: "loading" }, el("span", { class: "spin" }), "Reconnecting\u2026"));
          await chrome.runtime.sendMessage({ type: "test" });
          render(await status());
        }, "primary"),
        button("Settings", () => {
          chrome.runtime.openOptionsPage();
          window.close();
        })
      )
    ));
  }
  setConn("good", "Connected");
  $("conn").title = s.name ?? "";
  const saved = await chrome.storage.local.get(["autoApply", "aiDrafts", "fillOptional"]);
  $("autoApply").checked = saved.autoApply === true;
  $("aiDrafts").checked = saved.aiDrafts != null ? saved.aiDrafts === true : Boolean(s.aiDrafts);
  $("fillOptional").checked = saved.fillOptional !== false;
  $("prefs").hidden = false;
  $("connText").textContent += s.ai?.mode === "personal" ? ` \xB7 Re-enter AI key in extension settings` : ` \xB7 ${s.credits ?? 0} credits`;
  const engine = s.extensionEngine === "rules_led" ? "Rule based" : "Agent based";
  let provider = "ApplyShortly AI";
  if (s.customAI) {
    let host2 = "";
    try {
      host2 = new URL(s.customAI.baseUrl).hostname.replace(/^(api|generativelanguage)\./, "");
    } catch {
    }
    provider = `${s.customAI.model || "Custom"}${host2 ? ` \xB7 ${host2}` : ""}`;
  }
  $("setup").replaceChildren(
    el("div", { title: "Form assistant engine" }, el("small", {}, "Engine:"), el("b", {}, engine)),
    el("div", { title: "AI provider" }, el("small", {}, "AI:"), el("b", {}, provider))
  );
  $("setup").hidden = false;
  const key = await shortcut();
  $("foot").replaceChildren(
    el("a", { href: "#", onclick: (e) => {
      e.preventDefault();
      openTab(`${s.baseUrl}/applications`);
    } }, "Open ApplyShortly"),
    key ? el("span", {}, "Shortcut ", el("kbd", {}, key)) : null
  );
  $("foot").hidden = false;
  if (!fillable) {
    return show(el(
      "div",
      { class: "card" },
      el("b", {}, "Open a job application to get started"),
      el("p", { class: "muted" }, "Then click this icon again."),
      button("Go to Applications", () => openTab(`${s.baseUrl}/applications`), "block")
    ));
  }
  if (s.app) {
    const sent = !["saved", "queued", "filling", "ready_for_review"].includes(s.app.status);
    return show(el(
      "div",
      { class: "card" },
      el("div", { class: "eyebrow" }, "This page is in ApplyShortly"),
      el("b", { class: "title" }, s.app.title || "Application"),
      el("div", { class: "muted" }, s.app.company_name ?? ""),
      s.app.status ? el("span", { class: "pill" }, "\u25CF " + s.app.status.replace(/_/g, " ")) : null,
      sent ? el("p", { class: "hint good" }, "\u2713 Already applied.") : null,
      sent ? button("Fill again", (e) => void start(false, e.currentTarget), "block") : button("Start applying", (e) => void start(false, e.currentTarget), "primary block")
    ));
  }
  let host = "";
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {
  }
  return show(el(
    "div",
    { class: "card" },
    el("div", { class: "eyebrow" }, host || "This page"),
    el("b", { class: "title" }, notFound ? "Not in ApplyShortly yet" : "Fill this page"),
    el("p", { class: "muted" }, "Start the agent here, or add this job to ApplyShortly to track it."),
    button("Start applying", (e) => void start(true, e.currentTarget), "primary block"),
    button("Add this job to ApplyShortly", () => openTab(`${s.baseUrl}/applications?${new URLSearchParams({ add: "1", url: tab.url })}`), "block")
  ));
}
for (const key of ["autoApply", "aiDrafts", "fillOptional"]) {
  $(key).addEventListener("change", async (e) => {
    await chrome.storage.local.set({ [key]: e.target.checked });
  });
}
await render(await status());
const controlUrl = chrome.runtime.getURL("src/ui/external-browser.html");
const openControl = (e) => {
  e?.preventDefault();
  void chrome.tabs.create({ url: controlUrl });
  window.close();
};
async function renderAssistant() {
  const box = $("assist");
  if (!box) return false;
  let data = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "externalBrowser", action: "status" });
    data = res?.ok ? res.data : null;
  } catch {
    data = null;
  }
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
    el(
      "div",
      { class: "row-head" },
      el("b", {}, "Assistant activity"),
      waiting ? el("span", { class: "badge" }, "Needs you") : el("span", { class: "muted" }, "Connected")
    ),
    activityList(data.activity ?? [], 6),
    el("a", { href: controlUrl, onclick: openControl }, waiting ? "Review and approve" : "Open full view")
  );
  return true;
}
if (await renderAssistant()) {
  setInterval(renderAssistant, 1500);
}
