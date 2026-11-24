import { PROVIDER_PRESETS, providerSupport } from "../shared/custom-ai.js";
/** The page's own elements, mostly form controls. */
const $ = (id: string): any => document.getElementById(id);
const P = globalThis.JobHuntPanel;
let pollTimer: any;
let stopped = false;
let aiBusy = false;
let connected = false;
let connecting: any;
let currentAI: any;
let currentCustomAI: any;


async function send(type: string, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "Connection failed.");
  return result.data;
}
function showConn(kind: string, title: string, detail = "") {
  $("dot").className = `status-dot ${kind}`;
  $("connCard").className = `card conn-card ${kind}`;
  $("connTitle").textContent = title;
  $("connDetail").textContent = detail;
}
function setMsg(text: string, kind = "") {
  $("formMsg").textContent = text;
  $("formMsg").className = kind;
}
let customPicked = false;
let clearKeyFlag = false;
function setCustomStatus(text: string, kind = "") {
  $("customStatus").textContent = text;
  $("customStatus").className = kind;
}
function renderAI(ai = currentAI) {
  currentAI = ai;
  const custom = Boolean(currentCustomAI?.enabled) || customPicked;
  $("aiFunding").replaceChildren(new Option("ApplyShortly credits", "platform"), new Option("Custom AI provider", "custom"));
  $("aiFunding").value = custom ? "custom" : "platform";
  $("aiFunding").disabled = aiBusy || !connected;
  $("customDetails").hidden = !custom;
  if (custom) $("customDetails").open = true;
}
async function aiAction(action: any) {
  aiBusy = true;
  renderAI();
  $("aiMessage").textContent = "Saving…";
  try {
    const ai = await action();
    renderAI(ai);
    $("aiMessage").textContent = "AI settings saved.";
    await test();
  } catch (error: any) { $("aiMessage").textContent = error?.message; }
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
  if ($("profileSetupCard")) $("profileSetupCard").hidden = true;
  if (connected) {
    const needsProfile = s.hasProfile === false;
    const needsDetails = !needsProfile && (s.resumeReady === false || s.contactReady === false);
    if (needsProfile) {
      showConn("wait", `Connected as ${s.name ?? s.email ?? "your account"}`, "Finish setting up your profile to autofill.");
      if ($("profileSetupCard")) {
        $("profileSetupCard").hidden = false;
        $("profileSetupTitle").textContent = "Set up your profile";
        $("profileSetupDetail").textContent = "Upload your resume and confirm your basic details so the extension can autofill applications.";
        $("setupProfileBtn").textContent = "Upload resume & set up profile";
      }
    } else if (needsDetails) {
      const missing = [
        s.resumeReady === false ? "resume" : null,
        s.contactReady === false ? "contact details" : null,
      ].filter(Boolean).join(" and ");
      showConn("good", `Connected as ${s.name ?? s.email ?? "your account"}`, `Connected. Add your ${missing} so forms fill completely.`);
      if ($("profileSetupCard")) {
        $("profileSetupCard").hidden = false;
        $("profileSetupTitle").textContent = "Complete your profile";
        $("profileSetupDetail").textContent = `Your ${missing} ${missing.includes(" and ") ? "are" : "is"} not set yet.`;
        $("setupProfileBtn").textContent = "Complete profile";
      }
    } else {
      showConn("good", `Connected as ${s.name ?? s.email ?? "your account"}`, "You're ready to autofill.");
    }
    const plan = s.plan ? s.plan[0].toUpperCase() + s.plan.slice(1) : "Account";
    $("accountSummary").textContent = s.billingEnabled === false ? `${s.email} · No credit charges` : `${s.email} · ${plan} plan · ${s.credits ?? 0} credits available`;
    $("aiMode").textContent = s.ai?.mode === "personal" ? "Server-stored keys are disabled. Re-enter your key below to use it on this device, or explicitly choose credits." : s.billingEnabled === false ? "ApplyShortly AI — no credit charges." : `ApplyShortly credits: ${s.credits ?? 0} available.`;
    // Automatic connections share this browser's website session; manual keys stand alone.
    $("logoutHint").textContent = s.connectionType === "automatic" ? "Logging out also signs this browser out of the ApplyShortly website." : "Logging out revokes this extension's API key.";
    const custom = await send("customAISettings");
    currentCustomAI = custom;
    renderAI(s.ai);
    if (custom?.enabled) {
      $("aiMode").textContent = `Custom endpoint: ${custom.model}. AI chat, drafts and Agent based form assistant planning are billed by your provider.`;
      if ($("customKeyHint")) {
        $("customKeyHint").hidden = !custom.hasKey;
        $("customKey").placeholder = custom.hasKey ? "Leave blank to keep saved key" : "";
      }
    }
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
  $("extensionEngine").value = ["auto", "ai_led", "rules_led"].includes(s.extensionEngine) ? s.extensionEngine : "auto";
  $("agentVision").checked = s.agentVision !== false;
  $("autoApply").checked = s.autoApply === true;
  $("fillOptional").checked = s.fillOptional !== false;
  $("aiDrafts").checked = Boolean(s.aiDrafts);
  $("saveLearnedAnswers").checked = s.saveLearnedAnswers === true;
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
    const presetKey = Object.keys(PROVIDER_PRESETS).find((key) => (PROVIDER_PRESETS as any)[key].baseUrl === custom.baseUrl) || "custom";
    $("providerPreset").value = presetKey;
    $("customBaseUrl").value = custom.baseUrl;
    updatePresetVisibility(presetKey);
    $("customModel").value = custom.model;
    const support = providerSupport(custom);
    $("customSupportsTools").checked = support.tools;
    $("customSupportsVision").checked = support.vision;
    if (custom.hasKey) {
      $("customKeyHint").hidden = false;
      $("customKey").placeholder = "Leave blank to keep saved key";
    } else {
      $("customKeyHint").hidden = true;
      $("customKey").placeholder = "";
    }
    setCustomStatus(`Custom provider is active (${custom.model}).`, "good");
  } else {
    updatePresetVisibility($("providerPreset")?.value || "openai");
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
    } catch (error: any) {
      showConn("bad", "Could not check connection", error?.message);
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
  } catch (error: any) {
    $("pairingMsg").textContent = `${error?.message} Retrying…`;
    pollTimer = setTimeout(pollSignIn, 5000);
  }
}
async function signIn(interactive: boolean) {
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
  } catch (error: any) { $("pairingMsg").textContent = error?.message; }
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
  } catch (error: any) { $("pairingMsg").textContent = `Could not log out: ${error?.message}`; }
  finally { $("logout").disabled = false; }
});
$("form").addEventListener("submit", async (event: any) => {
  event.preventDefault();
  const token = $("token").value.trim().replace(/^EXTENSION_API_TOKEN=/, "").replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  if (!token) return setMsg("Paste your ApplyShortly account API key.", "bad");
  try {
    await send("saveManualConnection", { token });
    $("token").value = "";
    setMsg("Saved.", "good");
    await test();
  } catch (error: any) { setMsg(error?.message, "bad"); }
});
$("aiFunding").addEventListener("change", () => {
  const selection = $("aiFunding").value;
  if (selection !== "platform") { customPicked = true; renderAI(); return; }
  customPicked = false;
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
  if (area !== "local") return;
  if ("extensionEngine" in changes && $("extensionEngine")) {
    const v = changes.extensionEngine.newValue;
    $("extensionEngine").value = v === "ai_led" || v === "rules_led" ? v : "auto";
  }
  if (!("token" in changes)) return;
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
  $("reveal").setAttribute("aria-pressed", String(hidden));
  const eye = $("reveal").querySelector(".icon-eye");
  const eyeOff = $("reveal").querySelector(".icon-eye-off");
  if (eye) eye.toggleAttribute("hidden", hidden);
  if (eyeOff) eyeOff.toggleAttribute("hidden", !hidden);
});
(() => {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".section-nav a[href^='#']"));
  if (!links.length) return;
  const setActive = (id: string) => {
    for (const link of links) {
      const match = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("active", match);
      if (match) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  const initialId = (location.hash && links.some((l) => l.getAttribute("href") === location.hash))
    ? location.hash.slice(1)
    : (links[0].getAttribute("href")?.slice(1) || "");
  if (initialId) setActive(initialId);
  for (const link of links) {
    link.addEventListener("click", () => {
      const id = link.getAttribute("href")?.slice(1);
      if (id) setActive(id);
    });
  }
  if (typeof IntersectionObserver === "function") {
    const sections = links
      .map((l) => document.getElementById(l.getAttribute("href")?.slice(1) || ""))
      .filter((el): el is HTMLElement => Boolean(el));
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const firstVisible = sections.find((s) => visible.has(s.id));
      if (firstVisible) setActive(firstVisible.id);
    }, { rootMargin: "-10% 0px -65% 0px", threshold: 0 });
    for (const section of sections) observer.observe(section);
  }
})();
$("extensionEngine").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ extensionEngine: /** @type {HTMLSelectElement} */ (event.target).value });
  $("prefMsg").textContent = "Saved for new extension sessions";
});
$("agentVision").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ agentVision: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved for new extension sessions";
});
$("autoApply").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ autoApply: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("fillOptional").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ fillOptional: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved for new extension sessions";
});
$("aiDrafts").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ aiDrafts: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("saveLearnedAnswers").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ saveLearnedAnswers: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("autopilotWindows").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ autopilotWindows: /** @type {HTMLInputElement} */ (event.target).checked });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
try { void chrome.storage.local.get("theme").then((stored) => { $("theme").value = stored.theme ?? "system"; }).catch(() => {}); } catch { /* keep the default */ }
$("theme").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ theme: /** @type {HTMLSelectElement} */ (event.target).value });
  $("prefMsg").textContent = "Saved";
  setTimeout(() => ($("prefMsg").textContent = ""), 1500);
});
$("shortcuts").addEventListener("click", (event: any) => { event.preventDefault(); void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); });
$("manageAI").addEventListener("click", async () => { try { await send("openWebsite", { path: "/settings#extension-ai" }); } catch (error: any) { setMsg(error?.message, "bad"); } });
$("openWebsite").addEventListener("click", async () => { try { await send("openWebsite"); } catch (error: any) { setMsg(error?.message, "bad"); } });
$("setupProfileBtn")?.addEventListener("click", async () => { try { await send("openWebsite", { path: "/profile?from=extension" }); } catch (error: any) { setMsg(error?.message, "bad"); } });
void load().catch((error: any) => showConn("bad", "Could not load settings", error?.message));

$("clearSavedCustomKey")?.addEventListener("click", () => {
  clearKeyFlag = true;
  if ($("customKeyHint")) $("customKeyHint").hidden = true;
  $("customKey").value = "";
  $("customKey").placeholder = "Key cleared (will be removed on Save)";
  setCustomStatus("Saved key staged for removal. Save to apply.", "wait");
});

function updatePresetVisibility(presetKey: string) {
  const isCustom = presetKey === "custom";
  if ($("customBaseUrlWrapper")) $("customBaseUrlWrapper").hidden = !isCustom;
  if ($("customBaseUrl")) $("customBaseUrl").required = isCustom;
}

$("customAIForm").addEventListener("submit", async (event: any) => {
  event.preventDefault();
  if (!$("customAIForm").reportValidity()) return;
  try {
    const presetKey = $("providerPreset").value;
    const preset = (PROVIDER_PRESETS as any)[presetKey];
    const raw = (preset?.baseUrl || $("customBaseUrl").value).trim();
    if (!raw) throw new Error("Enter an API base URL before saving.");
    const url = new URL(raw);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS URL or a local HTTP URL without credentials, query or fragment.");
    const allowed = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!allowed) throw new Error("Provider access was not granted.");
    $("deleteRetainedKey").disabled = true;
    await send("saveCustomAI", {
      baseUrl: raw,
      model: $("customModel").value.trim() || preset?.model || "",
      apiKey: $("customKey").value.trim(),
      clearKey: clearKeyFlag,
      supportsTools: $("customSupportsTools").checked,
      supportsVision: $("customSupportsVision").checked,
    });
    $("customKey").value = "";
    clearKeyFlag = false;
    setCustomStatus("Custom provider saved and active for AI chat, drafts and Agent based form assistant planning.", "good");
    await test();
  } catch (error: any) { setCustomStatus(error?.message, "bad"); }
});

$("customTest").addEventListener("click", async () => {
  try {
    const presetKey = $("providerPreset").value;
    const preset = (PROVIDER_PRESETS as any)[presetKey];
    const raw = (preset?.baseUrl || $("customBaseUrl").value).trim();
    if (!raw) throw new Error("Enter an API base URL before testing.");
    const url = new URL(raw);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTPS URL or a local HTTP URL without credentials, query or fragment.");
    }
    const origin = `${url.origin}/*`;
    const allowed = await chrome.permissions.request({ origins: [origin] });
    if (!allowed) throw new Error("Provider access was not granted.");

    const model = $("customModel").value.trim() || preset?.model || "";
    if (!model) throw new Error("Enter a model identifier before testing.");

    setCustomStatus(`Testing connection to ${model}…`, "wait");
    $("customTest").disabled = true;

    await send("testCustomAI", {
      baseUrl: raw,
      model,
      apiKey: clearKeyFlag ? "" : $("customKey").value.trim(),
      supportsTools: $("customSupportsTools").checked,
      supportsVision: $("customSupportsVision").checked,
    });
    setCustomStatus(`Connection successful! ${model} responded.`, "good");
    $("deleteRetainedKey").disabled = false;
  } catch (error: any) {
    setCustomStatus(error?.message || "Connection failed.", "bad");
  } finally {
    $("customTest").disabled = false;
  }
});

$("customDisable").addEventListener("click", async () => {
  try {
    await send("disableCustomAI");
    customPicked = false;
    clearKeyFlag = false;
    $("customKey").value = "";
    if ($("customKeyHint")) $("customKeyHint").hidden = true;
    $("customKey").placeholder = "";
    setCustomStatus("Switched to ApplyShortly credits.", "good");
    await test();
  }
  catch (error: any) { setCustomStatus(error?.message, "bad"); }
});

$("providerPreset").addEventListener("change", () => {
  const presetKey = $("providerPreset").value;
  const preset = (PROVIDER_PRESETS as any)[presetKey];
  updatePresetVisibility(presetKey);

  if (preset) {
    $("customBaseUrl").value = preset.baseUrl;
    $("customModel").value = "";
    $("customModel").placeholder = preset.model || "Enter a model identifier";
    const support = providerSupport(preset as any);
    $("customSupportsTools").checked = support.tools;
    $("customSupportsVision").checked = support.vision;
    if ($("customKeyLabelText")) $("customKeyLabelText").textContent = "API key";
  } else {
    if (Object.values(PROVIDER_PRESETS).some((p) => p.baseUrl === $("customBaseUrl").value.trim())) {
      $("customBaseUrl").value = "";
    }
    $("customModel").value = "";
    $("customModel").placeholder = "Enter a model identifier";
    $("customSupportsTools").checked = true;
    $("customSupportsVision").checked = false;
    if ($("customKeyLabelText")) $("customKeyLabelText").textContent = "API key (optional for local servers)";
  }
  $("customKey").value = "";
  clearKeyFlag = false;
  const hasSavedKeyForUrl = currentCustomAI?.hasKey && currentCustomAI?.baseUrl === $("customBaseUrl").value.trim();
  if ($("customKeyHint")) $("customKeyHint").hidden = !hasSavedKeyForUrl;
  $("customKey").placeholder = hasSavedKeyForUrl ? "Leave blank to keep saved key" : "";
});
if (!$("customBaseUrl").value) {
  $("customBaseUrl").value = PROVIDER_PRESETS.openai.baseUrl;
  const support = providerSupport(PROVIDER_PRESETS.openai as any);
  $("customSupportsTools").checked = support.tools;
  $("customSupportsVision").checked = support.vision;
}
updatePresetVisibility($("providerPreset")?.value || "openai");

$("deleteRetainedKey").addEventListener("click", async () => {
  try {
    await send("deleteAIProvider");
    $("deleteRetainedKey").disabled = true;
    setCustomStatus("Retained server key deleted. Your on-device provider remains active.", "good");
  } catch (error: any) { setCustomStatus(error?.message, "bad"); }
});
