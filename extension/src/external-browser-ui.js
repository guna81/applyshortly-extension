import { connectionState, queueStatus, connectorUrl } from "./external-browser-state.js";
import { activityList } from "./external-activity.js";

const send = async (action, extra = {}) => {
  const response = await chrome.runtime.sendMessage({ type: "externalBrowser", action, ...extra });
  if (!response.ok) throw new Error(response.error);
  return response.data;
};
const $ = (id) => document.getElementById(id);
const trust = /** @type {HTMLInputElement} */ (document.getElementById("trust"));
const status = $("status");
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
const act = (label, onclick, cls = "") => { const button = el("button", cls, label); button.type = "button"; button.onclick = onclick; return button; };

$("connect").onclick = async () => {
  try { await send("connect"); status.textContent = "Connected. Ask your assistant to choose applications to fill."; }
  catch (error) { status.textContent = error.message; }
};
trust.onchange = async () => {
  try { await send("autoApprove", { on: trust.checked }); }
  catch (error) { status.textContent = error.message; trust.checked = !trust.checked; }
};
const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };
const standing = /** @type {HTMLInputElement} */ (document.getElementById("standing"));
standing.onchange = async () => {
  // Turning it on also asks for Chrome's all-sites access in this same click (Chrome only grants it
  // from a user click), so the first hands-off batch is not stopped by a site prompt.
  const on = standing.checked;
  try {
    if (on) await chrome.permissions.request(ALL_SITES).catch(() => false);
    await send("standing", { on });
  } catch (error) { status.textContent = error.message; standing.checked = !on; }
};
$("sites").onclick = async () => {
  // Chrome only grants site access from a click on this page, so this is the one manual step.
  try {
    if (!await chrome.permissions.request(ALL_SITES)) status.textContent = "Site access was declined. New sites will still ask each time.";
  } catch (error) { status.textContent = error.message; }
};
$("continue").onclick = () => send("continue").catch((error) => { status.textContent = error.message; });
$("stop").onclick = () => send("stop").catch((error) => { status.textContent = error.message; });

let signature = "";
function renderAttention(data) {
  const main = $("batches");
  const nodes = [];
  if (data.pendingNavigation) {
    const card = el("div", "ask");
    card.append(el("b", "", `Allow the application to continue on ${data.pendingNavigation}?`),
      el("p", "muted", "The application moved to a new domain. Only approve it if it matches the employer."),
      act("Allow this domain", async () => {
        try {
          if (await chrome.permissions.request({ origins: [`${data.pendingNavigation}/*`] })) await send("approveNavigation");
        } catch (error) { status.textContent = error.message; }
      }, "primary"));
    nodes.push(card);
  }
  if (data.pendingReview) {
    const card = el("div", "ask");
    card.append(el("b", "", "Review the new answers"), el("p", "muted", "Your assistant wants to submit these. Read each one first."));
    const list = el("ul", "answers");
    for (const [key, value] of data.pendingReview.answers) list.append(el("li", "", `${key}: ${value}`));
    card.append(list, act("Approve these answers", async () => { await send("reviewAnswers"); }, "primary"));
    nodes.push(card);
  }
  for (const batch of data.batches.filter((b) => b.state === "pending")) {
    const card = el("div", "ask");
    card.append(el("b", "", `${batch.assistant} wants to fill ${batch.jobs.length} application${batch.jobs.length === 1 ? "" : "s"}`));
    for (const job of batch.jobs) card.append(el("p", "job", `${job.title} · ${job.company} · ${new URL(job.url).hostname}`));
    if (batch.auto_submit) card.append(el("p", "hint bad", "You are also allowing submission for these applications. New answers still need your review before a cancellable countdown."));
    const row = el("div", "row-btns");
    row.append(
      act(batch.auto_submit ? "Approve filling and submitting" : "Approve filling", async () => {
        try {
          const origins = [...new Set(batch.jobs.map((job) => `${new URL(job.url).origin}/*`))];
          if (!await chrome.permissions.request({ origins })) {
            status.textContent = "Application site access was declined. The selected applications were not approved.";
            return;
          }
          await send("decision", { batchId: batch.id, approve: true });
        } catch (error) { status.textContent = error.message; }
      }, "primary"),
      act("Reject", () => send("decision", { batchId: batch.id, approve: false }).catch((error) => { status.textContent = error.message; })));
    card.append(row);
    nodes.push(card);
  }
  $("attn").hidden = nodes.length === 0;
  main.replaceChildren(...nodes);
}

async function refresh() {
  try {
    const data = await send("status");
    if (data.enabled === false) {
      const banner = $("disabled-banner");
      if (banner) banner.hidden = false;
      $("dot").className = "status-dot bad";
      $("state").textContent = "Feature disabled";
      $("recovery").textContent = "External assistant browser control is currently disabled. Connected agents (such as ChatGPT, Claude or Codex) cannot connect to or control this browser.";
      const connectBtn = /** @type {HTMLButtonElement} */ ($("connect"));
      connectBtn.hidden = false;
      connectBtn.disabled = true;
      connectBtn.textContent = "Disabled";
      $("stop").hidden = true;
      $("continue").hidden = true;
      trust.disabled = true;
      standing.disabled = true;
      const sitesBtn = /** @type {HTMLButtonElement} */ ($("sites"));
      sitesBtn.disabled = true;
      $("activity").replaceChildren(activityList([], 30));
      return;
    }
    $("dot").className = `status-dot ${data.connected ? "good" : "bad"}`;
    const state = connectionState(data);
    $("state").textContent = state.label;
    $("recovery").textContent = state.hint;
    $("continue").hidden = !data.paused || !data.connected;
    $("connect").hidden = data.connected;
    $("connect").textContent = data.wanted ? "Reconnect" : "Connect browser";
    $("stop").hidden = !data.connected && !data.wanted;
    const all = await chrome.permissions.contains(ALL_SITES).catch(() => false);
    $("sites").hidden = all;
    $("sites-state").textContent = all ? "All application sites allowed." : "";
    if (document.activeElement !== trust) trust.checked = data.autoApprove === true;
    if (document.activeElement !== standing) standing.checked = data.standing === true;
    const next = JSON.stringify([data.pendingNavigation, data.pendingReview, data.batches.filter((b) => b.state === "pending")]);
    if (next !== signature) { signature = next; renderAttention(data); } // keep a clicked button from being rebuilt under the cursor
    const running = data.batches.filter((b) => b.state !== "pending");
    const summary = el("p", "muted", running.length
      ? running.map((b) => `${b.assistant}: ${queueStatus(b)}${b.state === "complete" ? "" : ` · application ${Math.min(b.policy.index + 1, b.jobs.length)} of ${b.jobs.length}`}`).join(" · ")
      : "");
    $("activity").replaceChildren(...(running.length ? [summary] : []), activityList(data.activity ?? [], 30));
  } catch (error) { status.textContent = error.message; }
}
try {
  const connection = await chrome.runtime.sendMessage({ type: "connectionSettings" });
  if (connection?.ok && connection.data?.baseUrl) $("connector-url").textContent = connectorUrl(connection.data.baseUrl);
} catch { /* Keep the Settings instruction when the connection is not configured. */ }
await refresh();
setInterval(refresh, 1500);
