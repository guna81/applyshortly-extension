import { createAssistantBox, createLauncher, $, el, button } from "./launcher.js";

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

const launcher = createLauncher({
  getTab: () => currentTab,
  wrap: (n) => el("div", { class: "launcher-view" }, n),
  openHint: "Go to an application form (or use Apply in ApplyShortly) in any tab to fill with this sidebar.",
  async afterStart() {
    // Tell the content script to hide the in-page panel and ask for the active panel state.
    try {
      await chrome.tabs.sendMessage(currentTab.id, { type: "sidepanelStatus", active: true });
      const stateRes = await chrome.tabs.sendMessage(currentTab.id, { type: "panelGetState" });
      if (stateRes?.ok && stateRes.data) {
        activePanelState = stateRes.data;
        renderAssistant(activePanelState);
        return;
      }
    } catch { /* fall back to a refresh */ }
    await refresh();
  },
});
const { show, setConn, status, loadSwitches } = launcher;
const renderLauncher = launcher.render;

function paragraphs(text) {
  const blocks = String(text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (blocks.length > 1 || text.length <= 140) return blocks;
  const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
  const out = [];
  for (let i = 0; i < sentences.length; i += 2) out.push(sentences.slice(i, i + 2).join(" "));
  return out;
}

// ------------------------------------------------------------------ Assistant View

// Small on/off chips in the chat input; same storage keys the page's panel listens to.
let chatPinned = true;
function prefChip(key, label, title, on) {
  const b = el("button", { type: "button", class: `chip ${on ? "on" : ""}`, role: "switch", "aria-checked": String(on), title }, label);
  b.addEventListener("click", () => {
    const next = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", String(next));
    b.classList.toggle("on", next);
    void chrome.storage.local.set({ [key]: next });
  });
  return b;
}

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
  const subtitle = [data.company || app?.company_name, !app ? "Not tracked in ApplyShortly" : null, agent?.planner === "custom" ? "Using your own AI provider" : null]
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

  // Until the form has been read there is no count to show: say what's happening and animate the bar
  // instead of "0/?". Every step itself is told in the chat below.
  // While the agent works, the page's field list isn't re-read, so count what it has filled so far.
  const filledCount = agent?.filled_count ?? 0;
  const total = summary.total;
  const live = agentWorking ? Math.max(summary.answered, filledCount) : summary.answered;
  const done = full && total ? total : total ? Math.min(live, total) : live;
  const pct = full ? 100 : total ? Math.round((done / total) * 100) : 0;
  const reading = agentBusy && !full && !total && !filledCount;
  const unknownTotal = agentBusy && !full && !total && filledCount > 0;
  const meta = data.submittedReported ? "Tracked in ApplyShortly"
    : reading ? "Reading the form to see what it asks…"
    : !total ? `${filledCount} ${filledCount === 1 ? "step" : "steps"} done`
    : `${done}/${total} steps`;
  const progressSection = el("div", { class: "hero" },
    el("div", { class: "hero-top" },
      el("strong", {}, headline),
      !reading && total ? el("span", { class: "count", "aria-label": `${done} of ${total} steps completed` }, `${done}/${total}`) : null),
    el("div", {
      class: `bar ${full ? "full" : ""} ${reading || unknownTotal ? "indeterminate" : ""}`, role: "progressbar", "aria-label": "Form progress",
      ...(reading || unknownTotal ? {} : { "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }),
    }, el("i", { style: reading || unknownTotal ? "" : `width:${pct}%` })),
    el("div", { class: "meta", role: "status" }, meta),
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
    // One thing the agent just did on the page, told as it happens; together they are the history.
    if (line.step) {
      chatLog.append(el("div", { class: "turn step-turn" },
        el("span", { class: "avatar" }, icon(BOT)),
        el("div", { class: "said" }, el("div", { class: "bubble assistant stepline" }, line.text))));
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

  // Nothing in the chat yet: say what is going on instead of leaving the panel blank.
  if (!lines.length && !data.chat?.pending && agentWorking) {
    chatLog.append(el("div", { class: "turn" },
      el("span", { class: "avatar" }, icon(BOT)),
      el("div", { class: "said" }, el("div", { class: "bubble assistant" },
        el("p", {}, agent.status === "paused" ? "Paused. Nothing on the page changes until you resume."
          : agent.status === "waiting" ? "I need an answer from you to carry on."
            : "I'm filling in what your profile already covers. If something is missing I'll ask you here, and nothing is submitted without your say-so.")))));
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

  const chipRow = el("div", { class: "chips" });
  void chrome.storage.local.get(["aiDrafts", "autoApply"]).then((p) => chipRow.append(
    prefChip("autoApply", "Auto apply", "Submit once every required answer is in, after a 3-second countdown you can cancel", p.autoApply === true),
    prefChip("aiDrafts", "Let AI answer", "Draft what your profile doesn't cover (uses AI credits; drafts are marked Check)", p.aiDrafts !== false)));
  const composerBox = el("div", { class: "composer" },
    el("div", { class: "box" },
      textarea,
      el("button", {
        type: "button",
        class: "primary send",
        disabled: data.chat?.pending || agentBusy,
        onclick: handleSend,
      }, icon(SEND))),
  );

  // Footer Actions
  const actionsBox = el("div", { class: "panel-actions" });
  if (data.countdown != null) {
    actionsBox.append(el("div", { class: "countdown-alert", style: "width: 100%;" },
      el("span", {}, `Submitting in ${data.countdown}s…`),
      button("Cancel", () => void sendTabAction("cancelCountdown"), "primary")));
  } else if (agentWorking) {
    if (agent.status === "paused") {
      actionsBox.append(button("Resume", () => void sendTabAction("agentControl", { subAction: "resume" }), "primary"));
    } else if (agent.status !== "waiting") {
      actionsBox.append(button("Pause", () => void sendTabAction("agentControl", { subAction: "pause" })));
    }
    actionsBox.append(el("span", { class: "grow" }));
    actionsBox.append(button("Stop and take over", () => void sendTabAction("agentControl", { subAction: "stop" }), "ghost"));
  } else if (!data.submittedReported) {
    const blockers = data.blockers ?? [];
    // The user's own Submit: same required-field checks and 3-second cancellable countdown as Auto apply.
    if (blockers.length) actionsBox.append(el("small", { class: "hint submit-hint" }, `${blockers[0]}.`));
    actionsBox.append(button("Already submitted", () => void sendTabAction("markSubmitted"), "ghost submit-main secondary"));
    actionsBox.append(el("button", {
      type: "button", class: "primary submit-main", disabled: blockers.length > 0 || null,
      title: blockers.length ? blockers.join(". ") : "Submit the application after a 3-second countdown you can cancel",
      onclick: () => void sendTabAction("autoApply"),
    }, "Submit application"));
  } else {
    actionsBox.append(button("Re-check page", () => void sendTabAction("run"), "primary block"));
  }

  const topArea = el("div", { class: "assistant-top" }, headerCard, progressSection);
  const bodyArea = el("div", { class: "assistant-body" }, chatLog);
  const bottomArea = el("div", { class: "assistant-bottom" }, composerBox, actionsBox, chipRow);
  const assistantView = el("div", { class: "assistant-view" }, topArea, bodyArea, bottomArea);

  // The view is rebuilt on every update: stay at the bottom if the user was there (or this is the
  // first draw), otherwise keep the place they scrolled to.
  const oldBody = document.querySelector(".assistant-body");
  const keepTop = oldBody ? oldBody.scrollTop : 0;
  // "Pinned" = the reader hasn't scrolled up; set by their own scrolling, so a long new message
  // can't unpin the view the way a distance check on the old, shorter page would.
  const stick = !oldBody || chatPinned;
  bodyArea.addEventListener("scroll", () => {
    chatPinned = bodyArea.scrollHeight - bodyArea.scrollTop - bodyArea.clientHeight < 60;
  }, { passive: true });
  show(assistantView);
  const settle = () => { bodyArea.scrollTop = stick ? bodyArea.scrollHeight : keepTop; };
  settle();
  requestAnimationFrame(() => { settle(); requestAnimationFrame(settle); });
  setTimeout(settle, 150);
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

const renderExternalAssistant = createAssistantBox({ skip: () => Boolean(activePanelState?.active) });
if (await renderExternalAssistant()) {
  setInterval(renderExternalAssistant, 1500);
}
