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
  const path = u.pathname === "/apply-queue" && u.searchParams.has("add") ? u.pathname + u.search : u.pathname;
  const result = await chrome.runtime.sendMessage({ type: "openWebsite", path });
  if (!result?.ok) { setConn("bad", result?.error || "Could not open ApplyShortly."); return; }
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

const AUTO_APPLY_HINT = "Auto apply fills the form, then clicks Submit after a 3-second countdown you can cancel. It stops and tells you what's missing if any required answer is still open.";

async function start(allowUntracked, btn, autoSubmit = false) {
  btn.disabled = true;
  btn.textContent = "Starting…";
  const r = await chrome.runtime.sendMessage({ type: "start", tabId: tab.id, url: tab.url, allowUntracked, autoSubmit });
  if (!r?.ok) {
    const e = P.friendlyError(r?.error, r?.status);
    show(el("div", { class: "card bad" }, el("b", {}, e.title), el("p", {}, e.detail)));
    return;
  }
  if (!r.data.found) return render(await status(), { notFound: true });
  window.close(); // the panel on the page takes it from here
}

async function status() {
  const res = await chrome.runtime.sendMessage({ type: "status", tabId: tab?.id, url: tab?.url });
  return res?.data ?? { configured: false };
}

async function render(s, { notFound = false } = {}) {
  $("prefs").hidden = true;
  $("foot").hidden = true;

  if (!s.configured) {
    setConn("off", "Not connected");
    return show(el("div", { class: "card" },
      el("b", {}, "Connect to your ApplyShortly account"),
      el("p", { class: "muted" }, "Sign in with ApplyShortly to use your profile, credits or personal AI keys."),
      button("Set up now", () => { chrome.runtime.openOptionsPage(); window.close(); }, "primary block"),
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
        button("Settings", () => { chrome.runtime.openOptionsPage(); window.close(); }),
      ),
    ));
  }

  setConn("good", `Connected as ${s.name ?? "you"}`);
  $("aiDrafts").checked = Boolean(s.aiDrafts);
  $("prefs").hidden = false;
  $("connText").textContent += s.ai?.mode === "personal" ? ` · Personal ${s.ai.provider} key` : ` · ${s.credits ?? 0} credits`;
  const key = await shortcut();
  $("foot").replaceChildren(
    el("a", { href: "#", onclick: (e) => { e.preventDefault(); openTab(`${s.baseUrl}/apply-queue`); } }, "Open ApplyShortly"),
    key ? el("span", {}, "Shortcut ", el("kbd", {}, key)) : null,
  );
  $("foot").hidden = false;

  if (!fillable) {
    return show(el("div", { class: "card" },
      el("b", {}, "Open a job application to get started"),
      el("p", { class: "muted" }, "Go to an application form (or use Open & Autofill in ApplyShortly), then click this icon."),
      button("Go to Apply Queue", () => openTab(`${s.baseUrl}/apply-queue`), "block"),
    ));
  }

  if (s.app) {
    const sent = !["saved", "queued", "filling", "ready_for_review"].includes(s.app.status);
    const fill = button(sent ? "Fill it again anyway" : "Autofill this form", (e) => void start(false, e.currentTarget), "block");
    return show(el("div", { class: "card" },
      el("div", { class: "eyebrow" }, "This page is in ApplyShortly"),
      el("b", { class: "title" }, s.app.title || "Application"),
      el("div", { class: "muted" }, s.app.company_name ?? ""),
      s.app.status ? el("span", { class: "pill" }, s.app.status.replace(/_/g, " ")) : null,
      sent ? el("p", { class: "hint good" }, "✓ You've already applied to this job.") : null,
      sent ? null : button("⚡ Auto apply", (e) => void start(false, e.currentTarget, true), "primary block"),
      fill,
      sent ? null : el("p", { class: "hint" }, AUTO_APPLY_HINT),
    ));
  }

  return show(el("div", { class: "card" },
    el("b", {}, notFound ? "This page isn't in ApplyShortly yet" : "Fill this page"),
    el("p", { class: "muted" },
      "To track this application, add the job in ApplyShortly first. Or just fill the form now; nothing is recorded."),
    button("⚡ Auto apply", (e) => void start(true, e.currentTarget, true), "primary block"),
    button("Fill without tracking", (e) => void start(true, e.currentTarget), "block"),
    el("p", { class: "hint" }, AUTO_APPLY_HINT),
    button("Add this job to ApplyShortly", () => openTab(`${s.baseUrl}/apply-queue?${new URLSearchParams({ add: "1", url: tab.url })}`), "block"),
  ));
}

$("aiDrafts").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ aiDrafts: e.target.checked });
});

await render(await status());
