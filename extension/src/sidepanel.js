import { activityList, attention } from "./external-activity.js";

/** The page's own elements, mostly form controls. @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const P = globalThis.JobHuntPanel;

// Lucide icons
const SEND = [
  "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
  "m21.854 2.147-10.94 10.939",
];
const BOT = ["M12 8V4H8", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"];
const CHECK = ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z", "m9 12 2 2 4-4"];

function icon(paths) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) svg.setAttribute(k, v);
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

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
  if (!result?.ok) { setConn("bad", result?.error || "Could not open ApplyShortly."); return; }
}

$("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

let currentTab = null;
let activePanelState = null;

async function sendTabAction(action, extra = {}) {
  if (!currentTab?.id) return;
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: "panelAction", action, ...extra });
  } catch (err) {
    console.warn("[JobHunt] action failed:", err);
  }
}

async function updateActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab ?? null;
  } catch {
    currentTab = null;
  }
  if (currentTab?.id) {
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: "sidepanelStatus", active: true });
    } catch { /* content script might not be injected yet */ }
  }
  await refresh();
}

async function shortcut() {
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "autofill");
    return cmd?.shortcut || null;
  } catch {
    return null;
  }
}

/** A full-width option: a bold title and one plain line on what it does. */
const choice = (title, detail, onclick, cls = "") =>
  el("button", { type: "button", class: `choice block ${cls}`, onclick }, el("span", { class: "t" }, title), el("span", { class: "d" }, detail));

const FILL_DETAIL = "Fills from your profile and asks you the rest. You submit.";
const AUTO_DETAIL = "Fills it, then submits after a 3-second countdown you can cancel.";

async function start(allowUntracked, btn, autoSubmit = false) {
  if (!currentTab?.id) return;
  btn.disabled = true;
  (btn.querySelector(".t") ?? btn).textContent = "Starting…";
  const r = await chrome.runtime.sendMessage({
    type: "start",
    tabId: currentTab.id,
    url: currentTab.url,
    allowUntracked,
    autoSubmit,
  });
  if (!r?.ok) {
    const e = P.friendlyError(r?.error, r?.status);
    show(el("div", { class: "card bad" }, el("b", {}, e.title), el("p", {}, e.detail)));
    return;
  }
  if (!r.data?.found) return renderLauncher(await status(), { notFound: true });

  // Inform content script to hide in-page panel and request active panel state
  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: "sidepanelStatus", active: true });
    const stateRes = await chrome.tabs.sendMessage(currentTab.id, { type: "panelGetState" });
    if (stateRes?.ok && stateRes.data) {
      activePanelState = stateRes.data;
      renderAssistant(activePanelState);
      return;
    }
  } catch { /* fallback */ }

  await refresh();
}

async function status() {
  const res = await chrome.runtime.sendMessage({ type: "status", tabId: currentTab?.id, url: currentTab?.url });
  return res?.data ?? { configured: false };
}

function paragraphs(text) {
  const blocks = String(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (blocks.length > 1 || text.length <= 140) return blocks;
  const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
  const out = [];
  for (let i = 0; i < sentences.length; i += 2) out.push(sentences.slice(i, i + 2).join(" "));
  return out;
}

// ------------------------------------------------------------------ Assistant View

function renderAssistant(data) {
  $("prefs").hidden = true;
  $("foot").hidden = true;

  const app = data.app;
  const summary = data.summary ?? { answered: 0, total: 0, progress: 0, headline: "Filling" };
  const agent = data.agent;
  const agentWorking = agent && ["starting", "running", "waiting", "paused"].includes(agent.status);
  const agentBusy = agentWorking && agent.status !== "waiting";
  const full = data.submittedReported || summary.progress >= 1;

  // Header & Subtitle
  const title = data.title || app?.title || "Job Application";
  const subtitle = [data.company || app?.company_name, agent?.planner === "custom" ? "Run by: Your custom AI provider" : (agent ? "Run by: ApplyShortly" : null)]
    .filter(Boolean).join(" · ");

  const headerCard = el("div", { class: "card" },
    el("div", { class: "eyebrow" }, "Job Application"),
    el("b", { class: "title" }, title),
    subtitle ? el("div", { class: "sub" }, subtitle) : null,
    agent?.filling_notice ? el("div", { class: "sub" }, agent.filling_notice) : null,
  );

  // Status & Progress bar
  const headline = data.submittedReported
    ? "Saved in ApplyShortly ✓"
    : agent && ["stopped", "failed"].includes(agent.status)
      ? "Stopped: review the form"
      : agentWorking
        ? (agent.status === "waiting" ? "Needs you" : agent.status === "paused" ? "Paused" : "Working through the form…")
        : summary.headline;

  const progressSection = el("div", { class: "hero" },
    el("strong", {}, headline),
    el("div", { class: `bar ${full ? "full" : ""}`, role: "progressbar" },
      el("i", { style: `width:${full ? 100 : Math.round(summary.progress * 100)}%` })),
    el("div", { class: "meta" }, data.submittedReported ? "Tracked in ApplyShortly" : `${summary.answered} of ${summary.total || "?"} answered`),
  );

  // Chat conversation
  const chatLog = el("div", { class: "chat", "aria-live": "polite" });
  const lines = data.chat?.lines?.length
    ? data.chat.lines
    : (data.chat?.greeting ? [{ role: "assistant", greeting: true, ...data.chat.greeting }] : []);

  lines.forEach((line, i) => {
    if (line.role === "user") {
      chatLog.append(el("div", { class: "bubble user" }, line.text));
      return;
    }
    const q = line.question;
    const isLast = i === lines.length - 1;
    const quickReplies = isLast && line.choices?.length
      ? el("div", { class: "quick", role: "group" },
        line.choices.map((c) => el("button", {
          type: "button",
          disabled: data.chat?.pending || agentBusy,
          onclick: () => void sendTabAction("ask", { text: c }),
        }, c)))
      : null;

    chatLog.append(el("div", { class: "turn" },
      el("span", { class: "avatar" }, icon(BOT)),
      el("div", { class: "said" },
        line.text ? el("div", { class: "bubble assistant" }, ...paragraphs(line.text).map((t) => el("p", {}, t))) : null,
        line.filled?.length ? el("ul", { class: "filled" }, line.filled.map((f) => el("li", { title: f }, icon(CHECK), el("span", {}, f)))) : null,
        q ? el("div", { class: "question" },
          q.step ? el("p", { class: "step" }, q.step) : null,
          el("p", { class: "label" }, q.label),
          q.note ? el("p", { class: "note" }, q.note) : null,
          quickReplies) : quickReplies,
        line.warnings?.map((w) => el("p", { class: "warn" }, w)))));
  });

  if (data.chat?.pending) {
    chatLog.append(el("div", { class: "thinking", role: "status" }, el("span", { class: "spin" }), "Thinking…"));
  }

  // Agent activity logs & review chips
  if (agent?.log?.length) {
    const logList = el("ul", { class: "alog" });
    for (const line of agent.log.slice(-10)) logList.append(el("li", {}, line));
    const reviewChips = (data.review ?? []).map((f) => el("span", { class: "chip", title: `${f.label}: ${f.value}` }, f.label));
    chatLog.append(el("div", { class: "activity" },
      reviewChips.length ? el("div", { class: "recheck" },
        el("div", { class: "recheck-h" }, `Double-check ${reviewChips.length === 1 ? "this answer" : `these ${reviewChips.length} answers`}`),
        el("div", { class: "recheck-chips" }, reviewChips)) : null,
      el("details", {}, el("summary", {}, "What I did on the page"), logList)));
  }

  // Composer / Input Box
  const textarea = el("textarea", {
    placeholder: agentBusy ? "Working on the form… I'll ask here when I need you." : agent?.status === "waiting" ? "Type your answer…" : "Type your answer, or ask to change one…",
    disabled: agentBusy,
  });
  if (data.chat?.draft) textarea.value = data.chat.draft;

  const handleSend = () => {
    const val = textarea.value.trim();
    if (!val) return;
    textarea.value = "";
    void sendTabAction("ask", { text: val });
  };

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  const composerBox = el("div", { class: "composer" },
    el("div", { class: "box" },
      textarea,
      el("button", {
        type: "button",
        class: "primary send",
        disabled: data.chat?.pending || agentBusy,
        onclick: handleSend,
      }, icon(SEND))),
    el("small", { class: "hint" }, "AI chat, drafts and AI-led planning use your selected provider."),
  );

  // Footer Actions
  const actionsBox = el("div", { class: "panel-actions" });
  if (data.countdown != null) {
    actionsBox.append(el("div", { class: "countdown-alert", style: "width: 100%;" },
      el("span", {}, `Submitting in ${data.countdown}s…`),
      button("Cancel", () => void sendTabAction("agentControl", { subAction: "cancel" }), "primary")));
  } else if (agentWorking) {
    if (agent.status === "paused") {
      actionsBox.append(button("Resume", () => void sendTabAction("agentControl", { subAction: "resume" }), "primary"));
    } else if (agent.status !== "waiting") {
      actionsBox.append(button("Pause", () => void sendTabAction("agentControl", { subAction: "pause" })));
    }
    actionsBox.append(el("span", { class: "grow" }));
    actionsBox.append(button("Stop and take over", () => void sendTabAction("agentControl", { subAction: "stop" }), "ghost"));
  } else if (!data.submittedReported) {
    actionsBox.append(button("I already submitted it", () => void sendTabAction("markSubmitted"), "ghost"));
    actionsBox.append(el("span", { class: "grow" }));
    const blockers = data.blockers ?? [];
    actionsBox.append(el("button", {
      type: "button",
      class: "primary",
      disabled: blockers.length > 0,
      title: blockers.length ? `Not ready: ${blockers.join(". ")}` : "Clicks the form's Submit button for you",
      onclick: () => void sendTabAction("autoApply"),
    }, "Submit for me"));
  } else {
    actionsBox.append(button("Re-check page", () => void sendTabAction("run"), "primary block"));
  }

  const topArea = el("div", { class: "assistant-top" }, headerCard, progressSection);
  const bodyArea = el("div", { class: "assistant-body" }, chatLog);
  const bottomArea = el("div", { class: "assistant-bottom" }, composerBox, actionsBox);
  const assistantView = el("div", { class: "assistant-view" }, topArea, bodyArea, bottomArea);

  show(assistantView);

  queueMicrotask(() => {
    bodyArea.scrollTop = bodyArea.scrollHeight;
  });
}

// ------------------------------------------------------------------ Launcher View

async function renderLauncher(s, { notFound = false } = {}) {
  $("prefs").hidden = true;
  $("foot").hidden = true;

  if (!s.configured) {
    setConn("off", "Not connected");
    return show(el("div", { class: "launcher-view" },
      el("div", { class: "card" },
        el("b", {}, "Connect to your ApplyShortly account"),
        el("p", { class: "muted" }, "Sign in with ApplyShortly to use your profile, credits or your on-device AI provider."),
        button("Set up now", () => chrome.runtime.openOptionsPage(), "primary block"),
      )
    ));
  }

  if (!s.connected) {
    const e = P.friendlyError(s.error, s.status, s.baseUrl);
    setConn("bad", "Can't connect");
    return show(el("div", { class: "launcher-view" },
      el("div", { class: "card bad" },
        el("b", {}, e.title),
        el("p", {}, e.detail),
        el("div", { class: "row-btns" },
          button("Try again", async () => {
            show(el("div", { class: "loading" }, el("span", { class: "spin" }), "Reconnecting…"));
            await chrome.runtime.sendMessage({ type: "test" });
            renderLauncher(await status());
          }, "primary"),
          button("Settings", () => chrome.runtime.openOptionsPage()),
        ),
      )
    ));
  }

  setConn("good", `Connected as ${s.name ?? "you"}`);
  $("aiDrafts").checked = Boolean(s.aiDrafts);
  $("prefs").hidden = false;
  $("connText").textContent += s.ai?.mode === "personal" ? ` · Re-enter AI key in extension settings` : ` · ${s.credits ?? 0} credits`;
  const key = await shortcut();
  $("foot").replaceChildren(
    el("a", { href: "#", onclick: (e) => { e.preventDefault(); openTab(`${s.baseUrl}/applications`); } }, "Open ApplyShortly"),
    key ? el("span", {}, "Shortcut ", el("kbd", {}, key)) : null,
  );
  $("foot").hidden = false;

  const fillable = Boolean(currentTab?.url && /^https?:/.test(currentTab.url));
  if (!fillable) {
    return show(el("div", { class: "launcher-view" },
      el("div", { class: "card" },
        el("b", {}, "Open a job application to get started"),
        el("p", { class: "muted" }, "Go to an application form (or use Apply in ApplyShortly) in any tab to fill with this sidebar."),
        button("Go to Applications", () => openTab(`${s.baseUrl}/applications`), "block"),
      )
    ));
  }

  if (s.app) {
    const sent = !["saved", "queued", "filling", "ready_for_review"].includes(s.app.status);
    return show(el("div", { class: "launcher-view" },
      el("div", { class: "card" },
        el("div", { class: "eyebrow" }, "This page is in ApplyShortly"),
        el("b", { class: "title" }, s.app.title || "Application"),
        el("div", { class: "muted" }, s.app.company_name ?? ""),
        s.app.status ? el("span", { class: "pill" }, s.app.status.replace(/_/g, " ")) : null,
        sent ? el("p", { class: "hint good" }, "✓ You've already applied to this job.") : null,
        sent
          ? button("Fill it again anyway", (e) => void start(false, e.currentTarget), "block")
          : [
            choice("Fill this form", FILL_DETAIL, (e) => void start(false, e.currentTarget), "primary"),
            choice("Fill and submit", AUTO_DETAIL, (e) => void start(false, e.currentTarget, true)),
          ],
      )
    ));
  }

  return show(el("div", { class: "launcher-view" },
    el("div", { class: "card" },
      el("b", {}, notFound ? "Not in ApplyShortly yet" : "Fill this page"),
      el("p", { class: "muted" }, "You can fill it, but it won't be tracked."),
      choice("Fill this form", FILL_DETAIL, (e) => void start(true, e.currentTarget), "primary"),
      choice("Fill and submit", AUTO_DETAIL, (e) => void start(true, e.currentTarget, true)),
      button("Add this job to ApplyShortly", () => openTab(`${s.baseUrl}/applications?${new URLSearchParams({ add: "1", url: currentTab?.url || "" })}`), "ghost block"),
    )
  ));
}

async function refresh() {
  if (currentTab?.id) {
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: "sidepanelStatus", active: true }).catch(() => {});
      const stateRes = await chrome.tabs.sendMessage(currentTab.id, { type: "panelGetState" });
      if (stateRes?.ok && stateRes.data && stateRes.data.active) {
        activePanelState = stateRes.data;
        renderAssistant(activePanelState);
        return;
      }
    } catch { /* content script not responding / idle */ }
  }
  activePanelState = null;
  await renderLauncher(await status());
}

$("aiDrafts").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ aiDrafts: /** @type {HTMLInputElement} */ (e.target).checked });
});

// React dynamically to active tab switches and page navigations
chrome.tabs?.onActivated?.addListener(() => {
  void updateActiveTab();
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (tabId === currentTab?.id && (changeInfo.url || changeInfo.status === "complete")) {
    currentTab = tab;
    void refresh();
  }
});

// Listen for live panel updates pushed from content script
chrome.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type === "panelSync" && msg.data) {
    activePanelState = msg.data;
    if (activePanelState.active) {
      renderAssistant(activePanelState);
    } else {
      void refresh();
    }
  }
});

// Track sidepanel open state so content script can suppress in-page popup
void chrome.runtime.sendMessage({ type: "setSidepanelOpen", open: true }).catch(() => {});
window.addEventListener("pagehide", () => {
  void chrome.runtime.sendMessage({ type: "setSidepanelOpen", open: false }).catch(() => {});
  if (currentTab?.id) {
    void chrome.tabs.sendMessage(currentTab.id, { type: "sidepanelStatus", active: false }).catch(() => {});
  }
});

await updateActiveTab();

const controlUrl = chrome.runtime.getURL("src/external-browser.html");
const openControl = (e) => { e?.preventDefault(); void chrome.tabs.create({ url: controlUrl }); };

/** The connected assistant's live steps. Quiet link when nothing is connected. */
async function renderExternalAssistant() {
  if (activePanelState?.active) return false;
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
}

if (await renderExternalAssistant()) {
  setInterval(renderExternalAssistant, 1500);
}
