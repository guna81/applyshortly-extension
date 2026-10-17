// Side panel: chat assistant plus compact Today / Apply / Board / Profile tabs.
// All data and the API key stay in the background worker; this page only sends messages.

const $ = (id) => document.getElementById(id);
const C = globalThis.JobHuntChat;

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

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Object.assign(new Error(result?.error || "Something went wrong."), { status: result?.status });
  return result.data;
}

const state = {
  tab: "chat",
  messages: [], // [{role, text, choices?, actions?}]
  busy: false,
  page: null, // {url, title, app} while sharing is on
  boardFilter: null,
};

const HISTORY_KEY = "assistantChat";
async function loadHistory() {
  try {
    const stored = (await chrome.storage.session.get(HISTORY_KEY))[HISTORY_KEY];
    if (Array.isArray(stored)) state.messages = stored;
  } catch { /* session storage unavailable: start empty */ }
}
function saveHistory() {
  const keep = state.messages.slice(-C.MAX_HISTORY);
  chrome.storage.session.set({ [HISTORY_KEY]: keep }).catch(() => {});
}

function setConn(kind, text) {
  $("dot").className = `status-dot ${kind}`;
  $("connText").textContent = text;
}

function errorCard(err) {
  if (err.status === 401 || /sign in/i.test(err.message)) {
    return el("div", { class: "msg error" }, "Sign in to use the assistant. ", button("Open settings", () => chrome.runtime.openOptionsPage()));
  }
  return el("div", { class: "msg error" }, err.message);
}

// ---- tabs ----

function renderTabs() {
  $("tabs").replaceChildren(
    ...C.TABS.map((t) =>
      el("button", {
        type: "button", role: "tab", "aria-selected": String(t.id === state.tab),
        onclick: () => { state.tab = t.id; renderTabs(); void render(); },
      }, t.label)),
  );
}

async function render() {
  const view = $("view");
  const tab = state.tab;
  if (tab === "chat") return renderChat();
  view.replaceChildren(el("div", { class: "loading" }, el("span", { class: "spin" }), "Loading…"));
  try {
    const data = await send({ type: "tabData", tab });
    if (state.tab !== tab) return; // user moved on
    if (tab === "today") renderToday(data);
    else if (tab === "apply") renderApply(data);
    else if (tab === "board") renderBoard(data);
    else renderProfile(data);
  } catch (err) {
    if (state.tab === tab) view.replaceChildren(errorCard(err));
  }
}

function askAbout(text) {
  state.tab = "chat";
  renderTabs();
  void ask(text);
}

function empty(text) {
  return el("p", { class: "muted" }, text);
}

function renderToday(jobs) {
  const view = $("view");
  if (!jobs.length) return view.replaceChildren(empty("No new matches right now."), chipRow(C.starterChoices("today")));
  view.replaceChildren(
    ...jobs.map((j) => {
      const row = el("div", { class: "item" },
        el("div", {}, el("b", {}, j.title), el("small", { class: "muted" }, [j.company_name, j.location, j.work_mode].filter(Boolean).join(" · "))),
        j.match_score != null && el("span", { class: `score ${C.scoreClass(j.match_score)}` }, `${j.match_score}% match`),
        j.fit_summary && el("small", { class: "muted" }, j.fit_summary),
      );
      row.append(el("div", { class: "row-btns" },
        button("Queue", () => act({ type: "queue_job", job_id: j.job_id }, row), "primary"),
        button("Dismiss", () => act({ type: "dismiss_job", job_id: j.job_id }, row)),
        button("Ask about it", () => askAbout(`Tell me about ${j.title} at ${j.company_name}.`)),
      ));
      return row;
    }),
  );
}

function renderApply(apps) {
  const view = $("view");
  const rows = apps.filter((a) => ["saved", "queued", "ready_for_review"].includes(a.status));
  if (!rows.length) return view.replaceChildren(empty("Nothing waiting to apply. Queue jobs from Today."), chipRow(C.starterChoices("apply")));
  view.replaceChildren(
    ...rows.map((a) =>
      el("div", { class: "item" },
        el("div", {}, el("b", {}, a.title ?? "Application"), el("small", { class: "muted" }, `${a.company_name ?? ""} · ${C.statusLabel(a.status)}`)),
        el("div", { class: "row-btns" },
          C.canAutofill(a.status) && button("Open & autofill", () => run({ type: "autofill", application_id: a.id }), "primary"),
          button("Ask about it", () => askAbout(`What should I do next for ${a.title} at ${a.company_name}?`)),
        ))),
  );
}

function renderBoard(apps) {
  const view = $("view");
  if (!apps.length) return view.replaceChildren(empty("No applications yet."));
  const groups = C.groupByStatus(apps);
  const shown = state.boardFilter ? apps.filter((a) => a.status === state.boardFilter) : apps;
  view.replaceChildren(
    el("div", { class: "chips" },
      button(`All (${apps.length})`, () => { state.boardFilter = null; renderBoard(apps); }),
      ...groups.map((g) => button(`${g.label} (${g.count})`, () => { state.boardFilter = g.status; renderBoard(apps); }))),
    ...shown.map((a) =>
      el("div", { class: "item" },
        el("div", {}, el("b", {}, a.title ?? "Application"), el("small", { class: "muted" }, `${a.company_name ?? ""} · ${C.statusLabel(a.status)}`)),
        el("div", { class: "row-btns" }, button("Ask about it", () => askAbout(`What's the status of ${a.title} at ${a.company_name}?`))))),
  );
}

function renderProfile(profile) {
  const lines = C.profileLines(profile);
  $("view").replaceChildren(
    el("dl", { class: "kv" }, lines.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
    chipRow(C.starterChoices("profile")),
    button("Edit in ApplyShortly", () => send({ type: "openWebsite", path: "/dashboard" }).catch(() => {})),
  );
}

// ---- actions ----

/** Confirmed actions that change data (queue, dismiss, status). */
async function act(action, row) {
  const buttons = row ? [...row.querySelectorAll("button")] : [];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const r = await send({ type: "chatAction", action });
    if (row) row.replaceChildren(el("small", { class: "good" }, r.message));
    return r;
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    if (row) row.append(el("small", { class: "bad" }, err.message));
    else state.messages.push({ role: "assistant", text: err.message, error: true });
    return null;
  }
}

/** Actions the assistant suggested: shown as buttons, run only on click. */
async function run(action, message) {
  const r = await act(action);
  if (message && r) {
    message.actions = message.actions.filter((a) => a !== action);
    state.messages.push({ role: "assistant", text: r.message });
    saveHistory();
  }
  if (state.tab === "chat") renderChat();
}

// ---- chat ----

function chipRow(choices, cls = "") {
  return el("div", { class: `chips ${cls}`.trim() }, choices.map((c) => button(c, () => askAbout(c))));
}

function renderChat() {
  const view = $("view");
  const nodes = [];
  if (!state.messages.length) {
    nodes.push(el("div", { class: "msg assistant" }, "Hi! I can look through your matches and applications, and help with the job page you're on. What would you like to do?"));
    nodes.push(chipRow(C.starterChoices("chat", { hasPage: Boolean(state.page), tracked: Boolean(state.page?.app) })));
  }
  state.messages.forEach((m, i) => {
    nodes.push(el("div", { class: `msg ${m.error ? "error" : m.role}` }, m.text));
    const last = i === state.messages.length - 1;
    if (m.role === "assistant" && m.actions?.length) {
      nodes.push(el("div", { class: "chips actions" }, m.actions.map((a) => button(a.label, () => run(a, m)))));
    }
    if (last && m.role === "assistant" && !m.error) {
      const choices = C.normalizeChoices(m.choices);
      nodes.push(chipRow(choices.length ? choices : C.starterChoices("chat", { hasPage: Boolean(state.page) })));
    }
  });
  if (state.busy) nodes.push(el("div", { class: "msg assistant" }, el("span", { class: "spin" }), " Thinking…"));
  view.replaceChildren(...nodes);
  view.scrollTop = view.scrollHeight;
}

async function ask(text) {
  const message = text.trim();
  if (!message || state.busy) return;
  state.messages.push({ role: "user", text: message });
  state.busy = true;
  saveHistory();
  if (state.tab === "chat") renderChat();
  try {
    const history = C.trimHistory(state.messages.filter((m) => !m.error));
    const reply = await send({
      type: "chat",
      messages: history,
      tab: state.tab === "chat" ? "chat" : state.tab,
      page: state.page ? { url: state.page.url, title: state.page.title } : null,
    });
    state.messages.push({ role: "assistant", text: reply.reply, choices: reply.choices, actions: reply.actions });
  } catch (err) {
    state.messages.push({ role: "assistant", text: err.message, error: true });
  } finally {
    state.busy = false;
    saveHistory();
    if (state.tab === "chat") renderChat();
  }
}

// ---- page sharing (opt-in: nothing about the tab leaves the browser until switched on) ----

async function refreshPage() {
  if (!$("sharePage").checked) {
    state.page = null;
    $("pageLabel").textContent = "Off. Only the page address and title are sent.";
    return;
  }
  try {
    state.page = await send({ type: "activePage" });
    $("pageLabel").textContent = state.page
      ? state.page.app ? `Tracked: ${state.page.app.title ?? "application"} at ${state.page.app.company_name ?? ""}` : "On. This page isn't one of your applications."
      : "On. Open a job page to share it.";
  } catch {
    state.page = null;
  }
}

$("sharePage").addEventListener("change", async () => {
  await chrome.storage.local.set({ sharePage: $("sharePage").checked });
  await refreshPage();
  if (state.tab === "chat") renderChat();
});

for (const event of ["onActivated", "onUpdated"]) {
  chrome.tabs[event].addListener(() => {
    if ($("sharePage").checked) void refreshPage();
  });
}

// ---- composer ----

const input = $("input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  input.style.height = "auto";
  state.tab = "chat";
  renderTabs();
  void ask(text);
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---- boot ----

renderTabs();
await loadHistory();
$("sharePage").checked = Boolean((await chrome.storage.local.get("sharePage")).sharePage);
try {
  const status = await send({ type: "status" });
  if (!status.configured) setConn("bad", "Not signed in");
  else if (!status.connected) setConn("bad", status.error || "Can't reach ApplyShortly");
  else setConn("good", `${status.name}${status.billingEnabled ? ` · ${status.credits} credits` : ""}`);
} catch {
  setConn("bad", "Can't reach ApplyShortly");
}
await refreshPage();
await render();
