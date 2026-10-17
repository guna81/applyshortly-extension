// What the side-panel assistant shows, derived from API data. Pure functions (no chrome.*, no
// rendering) so they're tested without a browser. Exposed as globalThis.JobHuntChat.

(() => {
  const MAX_HISTORY = 40;
  const MAX_TEXT = 4000;
  const MAX_CHOICES = 5;

  const TABS = [
    { id: "chat", label: "Chat" },
    { id: "today", label: "Today" },
    { id: "apply", label: "Apply" },
    { id: "board", label: "Board" },
    { id: "profile", label: "Profile" },
  ];

  const STATUS_LABELS = {
    saved: "Saved", queued: "Queued", filling: "Filling", ready_for_review: "Ready for review",
    submission_unconfirmed: "Needs verification", submitted: "Submitted", assessment: "Assessment",
    interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn", ghosted: "Ghosted",
  };

  // Board columns, in funnel order.
  const BOARD_ORDER = [
    "saved", "queued", "filling", "ready_for_review", "submission_unconfirmed", "submitted",
    "assessment", "interview", "offer", "rejected", "withdrawn", "ghosted",
  ];

  const statusLabel = (status) => STATUS_LABELS[status] ?? String(status ?? "").replace(/_/g, " ");

  /** Last MAX_HISTORY turns, text capped to what the API accepts, blank turns dropped. */
  function trimHistory(messages) {
    return messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
      .map((m) => ({ role: m.role, text: m.text.trim().slice(0, MAX_TEXT) }))
      .slice(-MAX_HISTORY);
  }

  /** Quick replies from the API: trimmed, de-duplicated, capped. */
  function normalizeChoices(choices) {
    const seen = new Set();
    for (const c of Array.isArray(choices) ? choices : []) {
      const text = typeof c === "string" ? c.trim() : "";
      if (text && text.length <= 60) seen.add(text);
    }
    return [...seen].slice(0, MAX_CHOICES);
  }

  /** Tappable starters shown before the first message, and when a reply offers none. */
  function starterChoices(tab, { hasPage = false, tracked = false } = {}) {
    const byTab = {
      chat: ["What's new today?", "What's in my apply queue?", "Where do my applications stand?"],
      today: ["Which of today's matches should I apply to first?", "Show me remote roles"],
      apply: ["What's ready for me to review?", "What should I do next?"],
      board: ["Any applications I should follow up on?", "Summarize my pipeline"],
      profile: ["What's missing from my profile?", "Which skills should I highlight?"],
    };
    const out = [...(byTab[tab] ?? byTab.chat)];
    if (hasPage) out.unshift(tracked ? "Autofill this page" : "Is this page one of my applications?");
    return out.slice(0, MAX_CHOICES);
  }

  /** Counts per status for the Board tab, in funnel order, empty statuses omitted. */
  function groupByStatus(applications) {
    const counts = new Map();
    for (const a of applications) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    const known = BOARD_ORDER.filter((s) => counts.has(s));
    const extra = [...counts.keys()].filter((s) => !BOARD_ORDER.includes(s));
    return [...known, ...extra].map((status) => ({ status, label: statusLabel(status), count: counts.get(status) }));
  }

  const scoreClass = (score) => (score == null ? "" : score >= 80 ? "good" : score >= 60 ? "ok" : "low");

  /** A tracked application can be autofilled while it is still waiting to be applied to. */
  const canAutofill = (status) => status === "saved" || status === "queued";

  function profileLines(p) {
    if (!p) return [];
    const lines = [];
    if (p.full_name) lines.push(["Name", p.full_name]);
    if (p.location) lines.push(["Location", p.location]);
    if (p.total_experience_years != null) lines.push(["Experience", `${p.total_experience_years} years`]);
    if (p.skills?.length) lines.push(["Skills", p.skills.slice(0, 12).join(", ")]);
    const prefs = p.preferences;
    if (prefs?.notice_period_days != null) lines.push(["Notice period", `${prefs.notice_period_days} days`]);
    if (prefs?.expected_ctc) lines.push(["Expected pay", `${prefs.expected_ctc}${prefs.currency ? ` ${prefs.currency}` : ""}`]);
    lines.push(["Saved answers", String(p.answers?.length ?? 0)]);
    lines.push(["Resume", p.resume_url ? "Uploaded" : "Not uploaded"]);
    return lines;
  }

  globalThis.JobHuntChat = {
    TABS, MAX_HISTORY, statusLabel, trimHistory, normalizeChoices, starterChoices,
    groupByStatus, scoreClass, canAutofill, profileLines,
  };
})();
