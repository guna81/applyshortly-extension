/** The page's own elements, mostly form controls. @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const P = globalThis.JobHuntPanel;
let pollTimer;
let stopped = false;
let aiBusy = false;
let connected = false;
let connecting;
let currentAI;
const providerNames = { openai: "OpenAI", anthropic: "Anthropic Claude", gemini: "Google Gemini" };

async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "Connection failed.");
  return result.data;
}
function showConn(kind, title, detail = "") {
  $("dot").className = `status-dot ${kind}`;
  $("connCard").className = `card conn-card ${kind}`;
  $("connTitle").textContent = title;
  $("connDetail").textContent = detail;
}
function setMsg(text, kind = "") {
  $("formMsg").textContent = text;
  $("formMsg").className = kind;
}
function renderAI(ai = currentAI) {
  currentAI = ai;
  $("aiFunding").replaceChildren(new Option("ApplyShortly credits", "platform"));
  $("savedProviders").replaceChildren();
  for (const item of ai?.configured ?? []) {
    $("aiFunding").add(new Option(`${providerNames[item.provider]} (${item.model})`, item.provider));
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${providerNames[item.provider]} · ${item.model} · Key stored `;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = `Delete ${providerNames[item.provider]} key`;
    remove.disabled = aiBusy || !connected;
    remove.addEventListener("click", () => void aiAction(() => send("deleteAIProvider", { provider: item.provider })));
    row.append(label, remove);
    $("savedProviders").append(row);
  }
  if (ai?.mode === "personal" && !ai.configured?.some((item) => item.provider === ai.provider)) {
    $("aiFunding").add(new Option("Personal key missing — add a key or choose credits", ai.provider));
  }
  $("aiFunding").value = ai?.mode === "personal" ? ai.provider : "platform";
  $("aiFunding").disabled = aiBusy || !connected;
  $("saveProvider").disabled = aiBusy || !connected;
}
async function aiAction(action) {
  aiBusy = true;
  renderAI();
  $("aiMessage").textContent = "Saving…";
  try {
    const ai = await action();
    renderAI(ai);
    $("aiMessage").textContent = "AI settings saved.";
    await test();
  } catch (error) { $("aiMessage").textContent = error.message; }
  finally { aiBusy = false; renderAI(); }
}
async function test() {
  showConn("wait", "Checking connection…");
  const res = await chrome.runtime.sendMessage({ type: "test" });
  const s = res?.data;
  connected = Boolean(s?.connected);
  $("accountSummary").hidden = !connected;
  $("signin").hidden = connected;
  $("manual").hidden = connected;
  $("logout").hidden = !connected;
  $("logoutHint").hidden = !connected;
  $("retest").hidden = true;
  if (connected) {
    showConn("good", `Connected as ${s.name ?? s.email ?? "your account"}`, "You're ready to autofill.");
    const plan = s.plan ? s.plan[0].toUpperCase() + s.plan.slice(1) : "Account";
    $("accountSummary").textContent = s.billingEnabled === false ? `${s.email} · No credit charges` : `${s.email} · ${plan} plan · ${s.credits ?? 0} credits available`;
    $("aiMode").textContent = s.ai?.mode === "personal" ? `Personal key: ${providerNames[s.ai.provider] ?? s.ai.provider}. No ApplyShortly credits used.` : s.billingEnabled === false ? "ApplyShortly AI — no credit charges." : `ApplyShortly credits: ${s.credits ?? 0} available.`;
    // Automatic connections share this browser's website session; manual keys stand alone.
    $("logoutHint").textContent = s.connectionType === "automatic" ? "Logging out also signs this browser out of the ApplyShortly website." : "Logging out revokes this extension's API key.";
    renderAI(s.ai);
    return true;
  }
  $("aiMode").textContent = "Connect your account to see AI settings.";
  currentAI = undefined;
  renderAI();
  if (s && !s.configured) showConn("off", "Not connected yet", "Sign in with ApplyShortly to connect your account.");
  else {
    const error = P.friendlyError(s?.error ?? res?.error, s?.status);
    showConn("bad", error.title, error.detail);
    $("retest").hidden = false;
  }
  return false;
}
async function load() {
  const s = await send("connectionSettings");
  $("token").value = "";
  $("aiDrafts").checked = Boolean(s.aiDrafts);
  $("version").textContent = chrome.runtime.getManifest().version;
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "autofill");
    if (cmd?.shortcut) $("shortcutHint").textContent = ` or press ${cmd.shortcut}`;
  } catch { /* No keyboard shortcut available. */ }
  await connect();
}
/** Checks the stored connection; without one, silently reuses the website sign-in. */
function connect() {
  connecting ??= (async () => {
    try {
      if (await test()) return;
      if ((await chrome.storage.session.get("pairing")).pairing) return pollSignIn();
      // A rejected key is cleared by the check, so a website sign-in can replace it.
      if (!stopped && !(await send("connectionSettings")).configured) await signIn(false);
    } catch (error) {
      showConn("bad", "Could not check connection", error.message);
      $("retest").hidden = false;
    }
  })().finally(() => { connecting = undefined; });
  return connecting;
}
async function pollSignIn() {
  try {
    const result = await send("pairingPoll");
    if (result.state === "pending") {
      $("pairingMsg").textContent = `Approve code ${result.code} in ApplyShortly. Only approve if it matches this code.`;
      $("cancelSignin").hidden = false;
      $("signin").disabled = true;
      pollTimer = setTimeout(pollSignIn, 3000);
      return;
    }
    $("cancelSignin").hidden = true;
    $("signin").disabled = false;
    $("pairingMsg").textContent = result.state === "connected" ? "Account connected." : "Sign-in ended. You can start again.";
    if (result.state === "connected") await test();
  } catch (error) {
    $("pairingMsg").textContent = `${error.message} Retrying…`;
    pollTimer = setTimeout(pollSignIn, 5000);
  }
}
async function signIn(interactive) {
  let legacy = false;
  try {
    clearTimeout(pollTimer);
    $("signin").disabled = true;
    $("cancelSignin").hidden = false;
    $("pairingMsg").textContent = interactive ? "Complete sign-in in the ApplyShortly window…" : "Checking your ApplyShortly sign-in…";
    const result = await send("browserSignIn", { interactive });
    if (result.state === "legacy") { legacy = true; await pollSignIn(); return; }
    $("pairingMsg").textContent = result.state === "connected" ? "Account connected." : "Sign in with ApplyShortly to connect.";
    if (result.state === "connected") await test();
  } catch (error) { $("pairingMsg").textContent = error.message; }
  finally { if (!legacy) { $("signin").disabled = false; $("cancelSignin").hidden = true; } }
}
$("signin").addEventListener("click", () => void signIn(true));
$("cancelSignin").addEventListener("click", async () => {
  stopped = true;
  clearTimeout(pollTimer);
  await send("pairingCancel");
  $("cancelSignin").hidden = true;
  $("signin").disabled = false;
  $("pairingMsg").textContent = "Sign-in cancelled.";
});
$("logout").addEventListener("click", async () => {
  $("logout").disabled = true;
  try {
    await send("disconnect");
    $("providerKey").value = "";
    $("pairingMsg").textContent = "Logged out.";
    await test();
  } catch (error) { $("pairingMsg").textContent = `Could not log out: ${error.message}`; }
  finally { $("logout").disabled = false; }
});
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("token").value.trim().replace(/^EXTENSION_API_TOKEN=/, "").replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  if (!token) return setMsg("Paste your ApplyShortly account API key.", "bad");
  try {
    await send("saveManualConnection", { token });
    $("token").value = "";
    setMsg("Saved.", "good");
    await test();
  } catch (error) { setMsg(error.message, "bad"); }
});
$("providerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("providerForm").reportValidity()) return;
  await aiAction(async () => {
    const provider = $("provider").value;
    await send("saveAIProvider", { provider, apiKey: $("providerKey").value.trim(), model: $("providerModel").value.trim() });
    $("providerKey").value = "";
    return send("selectAI", { mode: "personal", provider });
  });
});
$("aiFunding").addEventListener("change", () => void aiAction(() => send("selectAI", $("aiFunding").value === "platform" ? { mode: "platform" } : { mode: "personal", provider: $("aiFunding").value })));
$("retest").addEventListener("click", () => void connect());
// The background follows website sign-in and sign-out; show the result here as it happens.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("token" in changes)) return;
  if (changes.token.newValue) $("pairingMsg").textContent = ""; // e.g. a stale "Logged out."
  void test();
});
// Returning from the website (signed in, out, or as another account) refreshes the connection.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("signin").disabled) void connect();
});
$("reveal").addEventListener("click", () => {
  const hidden = $("token").type === "password";
  $("token").type = hidden ? "text" : "password";
  $("reveal").title = hidden ? "Hide key" : "Show key";
  $("reveal").setAttribute("aria-label", $("reveal").title);
});
$("aiDrafts").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ aiDrafts: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("shortcuts").addEventListener("click", (event) => { event.preventDefault(); void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); });
$("manageAI").addEventListener("click", async () => { try { await send("openWebsite", { path: "/settings#extension-ai" }); } catch (error) { setMsg(error.message, "bad"); } });
$("openWebsite").addEventListener("click", async () => { try { await send("openWebsite"); } catch (error) { setMsg(error.message, "bad"); } });
void load().catch((error) => showConn("bad", "Could not load settings", error.message));
