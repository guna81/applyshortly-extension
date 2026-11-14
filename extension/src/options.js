import { PROVIDER_PRESETS } from "./custom-ai.js";
/** The page's own elements, mostly form controls. @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
const P = globalThis.JobHuntPanel;
let pollTimer;
let stopped = false;
let aiBusy = false;
let connected = false;
let connecting;
let currentAI;
let currentCustomAI;


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
  if (currentCustomAI?.enabled) $("aiFunding").add(new Option(`My AI provider (${currentCustomAI.model})`, "custom"));
  if (ai?.mode === "personal" && !currentCustomAI?.enabled) $("aiFunding").add(new Option("Re-enter your key on this device", "migration"));
  $("aiFunding").value = currentCustomAI?.enabled ? "custom" : ai?.mode === "personal" ? "migration" : "platform";
  $("aiFunding").disabled = aiBusy || !connected;
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
    $("aiMode").textContent = s.ai?.mode === "personal" ? "Server-stored keys are disabled. Re-enter your key below to use it on this device, or explicitly choose credits." : s.billingEnabled === false ? "ApplyShortly AI — no credit charges." : `ApplyShortly credits: ${s.credits ?? 0} available.`;
    // Automatic connections share this browser's website session; manual keys stand alone.
    $("logoutHint").textContent = s.connectionType === "automatic" ? "Logging out also signs this browser out of the ApplyShortly website." : "Logging out revokes this extension's API key.";
    const custom = await send("customAISettings");
    currentCustomAI = custom;
    renderAI(s.ai);
    if (custom?.enabled) $("aiMode").textContent = `Custom endpoint: ${custom.model}. AI chat, drafts and AI-led planning are billed by your provider.`;
    return true;
  }
  $("aiMode").textContent = "Connect your account to see AI settings.";
  currentAI = undefined;
  currentCustomAI = undefined;
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
  $("extensionEngine").value = s.extensionEngine === "rules_led" ? "rules_led" : "ai_led";
  $("aiDrafts").checked = Boolean(s.aiDrafts);
  $("autopilotWindows").checked = s.autopilotWindows !== false;
  $("version").textContent = chrome.runtime.getManifest().version;
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === "autofill");
    if (cmd?.shortcut) $("shortcutHint").textContent = ` or press ${cmd.shortcut}`;
  } catch { /* No keyboard shortcut available. */ }
  await connect();
  const custom = await send("customAISettings");
  if (custom?.enabled) {
    $("customDetails").open = true;
    $("providerPreset").value = Object.keys(PROVIDER_PRESETS).find((key) => PROVIDER_PRESETS[key].baseUrl === custom.baseUrl) || "custom";
    $("customBaseUrl").value = custom.baseUrl;
    $("customModel").value = custom.model;
    $("customStatus").textContent = "Custom provider is active for AI chat, drafts and AI-led planning. Re-enter the key when saving changes.";
  }
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
    $("customKey").value = "";
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
$("aiFunding").addEventListener("change", () => {
  const selection = $("aiFunding").value;
  if (selection !== "platform") { $("customDetails").open = true; return; }
  void aiAction(async () => {
    await send("disableCustomAI");
    currentCustomAI = undefined;
    $("customStatus").textContent = "Using ApplyShortly provider settings.";
    return send("selectAI", { mode: "platform" });
  });
});
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
$("extensionEngine").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ extensionEngine: /** @type {HTMLSelectElement} */ (event.target).value });
  $("prefMsg").textContent = "Saved for new extension sessions";
});
$("aiDrafts").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ aiDrafts: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("autopilotWindows").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ autopilotWindows: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("shortcuts").addEventListener("click", (event) => { event.preventDefault(); void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); });
$("manageAI").addEventListener("click", async () => { try { await send("openWebsite", { path: "/settings#extension-ai" }); } catch (error) { setMsg(error.message, "bad"); } });
$("openWebsite").addEventListener("click", async () => { try { await send("openWebsite"); } catch (error) { setMsg(error.message, "bad"); } });
void load().catch((error) => showConn("bad", "Could not load settings", error.message));

$("customAIForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!$("customAIForm").reportValidity()) return;
  try {
    const raw = $("customBaseUrl").value.trim();
    const url = new URL(raw);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS URL or a local HTTP URL without credentials, query or fragment.");
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new Error("Provider access was not granted.");
    $("deleteRetainedKey").disabled = true;
    await send("saveCustomAI", { baseUrl: raw, model: $("customModel").value.trim() || PROVIDER_PRESETS[$("providerPreset").value]?.model || "", apiKey: $("customKey").value.trim() });
    $("customKey").value = "";
    $("customStatus").textContent = "Custom provider saved and active for AI chat, drafts and AI-led planning.";
    await test();
  } catch (error) { $("customStatus").textContent = error.message; }
});
$("customTest").addEventListener("click", async () => {
  $("customStatus").textContent = "Testing…";
  try {
    await send("testCustomAI");
    $("customStatus").textContent = "Connection successful. You can now delete this provider's retained server key.";
    $("deleteRetainedKey").disabled = false;
  }
  catch (error) { $("customStatus").textContent = error.message; }
});
$("customDisable").addEventListener("click", async () => {
  try { await send("disableCustomAI"); $("customKey").value = ""; $("customStatus").textContent = "Custom provider removed."; await test(); }
  catch (error) { $("customStatus").textContent = error.message; }
});

$("providerPreset").addEventListener("change", () => {
  const preset = PROVIDER_PRESETS[$("providerPreset").value];
  $("customBaseUrl").value = preset?.baseUrl || "";
  $("customModel").value = "";
  $("customModel").placeholder = preset?.model || "Enter a model identifier";
  $("customKey").value = "";
});
if (!$("customBaseUrl").value) $("customBaseUrl").value = PROVIDER_PRESETS.openai.baseUrl;

$("deleteRetainedKey").addEventListener("click", async () => {
  try {
    await send("deleteAIProvider");
    $("deleteRetainedKey").disabled = true;
    $("customStatus").textContent = "Retained server key deleted. Your on-device provider remains active.";
  } catch (error) { $("customStatus").textContent = error.message; }
});
