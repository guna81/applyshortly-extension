// Background service worker: owns the API key and every request to the platform.
// Content scripts and the popup talk to it with chrome.runtime messages ({type, ...}).

import { Agent } from "./agent/loop.js";
import { TabDriver } from "./agent/cdp.js";
import { BridgeError, JobHuntBridge, autoApplyCodeFromUrl, autoApplyUrl, autofillIdFromUrl } from "./bridge.js";

/** @type {{baseUrl: string, token: string, aiDrafts: boolean, autopilotWindows: boolean, connectionType?: string}} */
// AI drafts are on unless the user turns them off: the website's agent drafts what it can't answer too.
// Autopilot windows are on too: the user turned Autopilot's auto-submit on, and the toggle here is the way out.
const DEFAULT_SETTINGS = { baseUrl: "http://localhost:3000", token: "", aiDrafts: true, autopilotWindows: true };
const PROFILE_TTL_MS = 60_000;
const CONTENT_SCRIPTS = ["src/fill.js", "src/panel-model.js", "src/panel-view.js", "src/content.js"];
// Injected by the agent into every frame's isolated world, in this order.
const AGENT_PAGE_SCRIPTS = ["src/fill.js", "src/agent/page.js"];

const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
let profileCache = null; // {at, key, profile}

let platformConfig;
async function platformOrigin() {
  platformConfig ??= (async () => {
    let response;
    try { response = await fetch(chrome.runtime.getURL("platform.json")); }
    catch { return DEFAULT_SETTINGS.baseUrl; } // Unpackaged development checkout.
    if (response.status === 404) return DEFAULT_SETTINGS.baseUrl;
    if (!response.ok) throw new Error("Could not load the extension's public configuration. Rebuild the package.");
    return validatedOrigin((await response.json()).baseUrl);
  })();
  return platformConfig;
}

async function settings() {
  await storageReady;
  const stored = await chrome.storage.local.get(["baseUrl", "token", "aiDrafts", "autopilotWindows", "connectionType"]);
  const baseUrl = await platformOrigin();
  // Credentials for another deployment must never be sent to the packaged origin.
  if (stored.baseUrl && stored.baseUrl !== baseUrl) {
    await clearConnection();
    stored.token = "";
  }
  return { ...DEFAULT_SETTINGS, ...stored, baseUrl };
}

async function bridge() {
  const s = await settings();
  if (!s.token) throw new BridgeError(401, "Sign in with ApplyShortly in the extension settings.");
  return new JobHuntBridge(s.baseUrl, s.token);
}

// Persist only outcome metadata, never form answers. Keep attempts before confirmations, and
// retry transient delivery failures after service-worker/browser restarts. Sign-out clears it.
let outcomeDelivery = Promise.resolve();
function syncOutcome(event = null) {
  const task = outcomeDelivery.then(async () => {
    const s = await settings();
    if (!s.token) return null;
    const owner = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${s.baseUrl}|${s.token}`))));
    const stored = (await chrome.storage.local.get("outcomeQueue")).outcomeQueue;
    const events = stored?.owner === owner ? stored.events : [];
    if (event) events.push({ application_id: event.application_id, event: event.event, url: event.url, note: event.note });
    const save = async () => {
      // A connection changed while a request was in flight: never restore the old account's queue.
      const current = await settings();
      if (current.token === s.token && current.baseUrl === s.baseUrl) await chrome.storage.local.set({ outcomeQueue: { owner, events } });
    };
    await save();
    let result = null;
    while (events.length) {
      const current = await settings();
      if (current.token !== s.token || current.baseUrl !== s.baseUrl) return null;
      try { result = await new JobHuntBridge(s.baseUrl, s.token).report(events[0]); }
      catch (error) {
        if (error.status === 401) { await clearConnection(); throw error; }
        if (error.status === 0 || error.status >= 500) return { pending: true };
        throw error;
      }
      events.shift();
      await save();
    }
    return result;
  });
  outcomeDelivery = task.then(() => {}, () => {});
  return task;
}

async function profile() {
  const s = await settings();
  const key = `${s.baseUrl}|${s.token}`;
  await (await bridge()).account(); // Check revocation before returning cached personal data.
  if (profileCache && profileCache.key === key && Date.now() - profileCache.at < PROFILE_TTL_MS) {
    return profileCache.profile;
  }
  let p;
  try { p = await (await bridge()).profile(); }
  catch (error) {
    if (error.status === 404) error.code = "profile_missing"; // Setup isn't finished on the website.
    throw error;
  }
  profileCache = { at: Date.now(), key, profile: p };
  return p;
}

// Which application a tab is filling, so multi-page forms and the confirmation page that
// follows a submit can be tied back to it after the #jobhunt-autofill fragment is gone.
const tabKey = (tabId) => `tab:${tabId}`;

async function getTab(tabId) {
  return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] ?? null;
}

async function setTab(tabId, value) {
  await chrome.storage.session.set({ [tabKey(tabId)]: value });
}

async function clearTab(tabId) {
  await chrome.storage.session.remove(tabKey(tabId));
}

chrome.tabs.onRemoved.addListener((tabId) => void clearTab(tabId));

async function hello(tabId, url) {
  const origin = new URL(url).origin;
  const agent = agents.get(tabId);
  // The agent drives this tab from here: the page's own autofill stays out of its way.
  if (agent && !agent.stopped && !["ready", "failed"].includes(agent.status)) return { appId: agent.appId, mode: "agent" };
  const id = autofillIdFromUrl(url);
  if (id !== null) {
    await setTab(tabId, { appId: id, origin, tracked: true });
    // Autopilot's window has nobody watching: Auto apply sends only what is certain (see content.js).
    const unattended = (await autopilotWindow())?.tabId === tabId;
    return { appId: id, mode: "fill", autoSubmit: await claimAutoApply(id, url), ...(unattended ? { unattended } : {}) };
  }
  const current = await getTab(tabId);
  if (current && current.origin === origin) return { appId: current.appId, mode: "continue", attemptPending: current.attemptPending === true };
  return { appId: null, mode: "idle" };
}

/** The user clicked Apply in ApplyShortly, which opened this page with a one-time code: claimed,
 * the page Auto applies. Reloading it, or a link made anywhere else, only fills. */
async function claimAutoApply(appId, url) {
  const code = autoApplyCodeFromUrl(url);
  if (!code) return false;
  try {
    return (await (await bridge()).claimAutoApply(appId, code)).auto_submit === true;
  } catch {
    return false;
  }
}

/** Popup → "Autofill this page" (or "Auto apply"): find the application for the page, or fill untracked. */
async function start(tabId, url, allowUntracked, autoSubmit = false) {
  const origin = new URL(url).origin;
  const current = await getTab(tabId);
  const existing = autofillIdFromUrl(url) ?? (current?.origin === origin ? current.appId : null);
  const app = existing !== null ? await (await bridge()).application(existing) : await (await bridge()).lookup(url);
  if (!app && !allowUntracked) return { found: false };
  const appId = app?.id ?? null;
  await setTab(tabId, { appId, origin, tracked: appId !== null });
  await sendToTab(tabId, { type: "run", appId, autoSubmit });
  return { found: true, appId };
}

/** Tells the tab's content script to run, injecting it first if the page predates the install. */
async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

async function context(appId, tabId, url, page) {
  const b = await bridge();
  const [p, found, s] = await Promise.all([
    profile(),
    appId !== null ? b.application(appId) : Promise.resolve(null),
    settings(),
  ]);
  const app = found ?? await b.trackApplication({ url: url.split("#")[0], title: clip(page?.title, 300), company: clip(page?.company, 200) });
  if (tabId !== undefined && appId === null) {
    await setTab(tabId, { appId: app.id, origin: new URL(url).origin, tracked: true });
  }
  // No AI drafting in Autopilot's window: nobody is there to check what it writes.
  const unattended = tabId !== undefined && (await autopilotWindow())?.tabId === tabId;
  return { profile: p, app, aiDrafts: s.aiDrafts && !unattended, baseUrl: s.baseUrl };
}

/** What the popup shows: connection, and which application (if any) the tab's page is. */
async function status(tabId, url) {
  const s = await settings();
  if (!s.token) return { configured: false, baseUrl: s.baseUrl };
  try {
    const b = await bridge();
    const account = await b.account();
    const tab = tabId !== undefined ? await getTab(tabId) : null;
    const fromUrl = url ? autofillIdFromUrl(url) : null;
    const appId = fromUrl ?? (tab && url && tab.origin === new URL(url).origin ? tab.appId : null);
    let app = appId != null ? await b.application(appId) : null;
    if (!app && url && /^https?:/.test(url)) app = await b.lookup(url);
    return { connectionType: s.connectionType ?? "manual", configured: true, connected: true, baseUrl: s.baseUrl, name: account.name ?? account.email, email: account.email, credits: account.credits, plan: account.plan, billingEnabled: account.billing_enabled, ai: account.ai, tab, app, aiDrafts: s.aiDrafts };
  } catch (err) {
    if (err.status === 401) await clearConnection();
    return { configured: true, connected: false, baseUrl: s.baseUrl, error: err.message, status: err.status };
  }
}

function validatedOrigin(raw) {
  const u = new URL(raw);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new Error("Use an HTTPS origin or loopback HTTP origin.");
  }
  return u.origin;
}

async function pairingStart(baseUrl) {
  baseUrl = validatedOrigin(baseUrl);
  const res = await fetch(`${baseUrl}/api/extension-auth/start`, { method: "POST", credentials: "omit" });
  if (res.status === 404) throw new Error("This ApplyShortly server needs an update before extension sign-in is available. Rebuild the API and apply its migrations.");
  if (!res.ok) throw new Error(`ApplyShortly returned HTTP ${res.status} while starting sign-in. Try again shortly.`);
  const pair = await res.json();
  await chrome.storage.session.set({ pairing: { ...pair, baseUrl, expiresAt: Date.now() + pair.expires_in * 1000 } });
  await chrome.tabs.create({ url: `${baseUrl}/extension-connect?code=${encodeURIComponent(pair.code)}` });
  return { code: pair.code };
}

async function pairingPoll() {
  const { pairing } = await chrome.storage.session.get("pairing");
  if (!pairing || Date.now() >= pairing.expiresAt) {
    await chrome.storage.session.remove("pairing");
    return { state: "expired" };
  }
  const res = await fetch(`${pairing.baseUrl}/api/extension-auth/exchange`, {
    method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: pairing.secret }),
  });
  if (!res.ok) throw new Error("Sign-in check failed. Try again.");
  const result = await res.json();
  if (result.state === "connected") {
    await clearConnection();
    await chrome.storage.local.set({ baseUrl: pairing.baseUrl, token: result.key, connectionType: "legacy" });
  }
  if (result.state !== "pending") await chrome.storage.session.remove("pairing");
  return { state: result.state, code: pairing.code };
}

async function clearConnection() {
  await chrome.storage.local.remove(["token", "connectionType", "outcomeQueue"]);
  await chrome.storage.session.clear();
  profileCache = null;
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

let signingIn = false;
async function browserSignIn(rawOrigin, interactive = true) {
  if (signingIn) throw new Error("Sign-in is already in progress. Close the sign-in window before trying again.");
  signingIn = true;
  try { return await performBrowserSignIn(rawOrigin, interactive); }
  finally { signingIn = false; }
}

async function performBrowserSignIn(rawOrigin, interactive) {
  if ((await settings()).token) throw new Error("Sign out of ApplyShortly before connecting another account.");
  if ((await chrome.storage.session.get("browserLogin")).browserLogin) throw new Error("Sign-in is already in progress. Cancel it before trying again.");
  const baseUrl = validatedOrigin(rawOrigin);
  const redirectUri = chrome.identity.getRedirectURL("applyshortly");
  let config;
  try {
    config = await fetch(`${baseUrl}/api/extension-auth/browser/config?${new URLSearchParams({ redirect_uri: redirectUri })}`, { credentials: "omit" });
  } catch {
    throw new Error("Cannot reach ApplyShortly. Check your internet connection and try again.");
  }
  // Older servers support approved code pairing but do not have the browser config route.
  if (config.status === 404) {
    if (!interactive) return { state: "signin_required" };
    await pairingStart(baseUrl);
    return { state: "legacy" };
  }
  if (!config.ok) throw new Error(`ApplyShortly returned HTTP ${config.status} while checking sign-in. Try again shortly.`);
  const availability = await config.json().catch(() => null);
  if (typeof availability?.enabled !== "boolean") throw new Error("The configured server did not return ApplyShortly sign-in settings.");
  if (!availability.enabled) {
    if (!interactive) return { state: "signin_required" };
    await pairingStart(baseUrl);
    return { state: "legacy" };
  }
  const verifier = randomSecret();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = randomSecret();
  await chrome.storage.session.set({ browserLogin: state });
  try {
    // A silent check (prompt=none) has the website answer at once instead of showing sign-in.
    const url = `${baseUrl}/extension-authorize?${new URLSearchParams({ redirect_uri: redirectUri, challenge, state, ...(interactive ? {} : { prompt: "none" }) })}`;
    let callback;
    try {
      callback = await chrome.identity.launchWebAuthFlow({ url, interactive, ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15000 }) });
    } catch (error) {
      if (!interactive) return { state: "signin_required" };
      throw error;
    }
    if ((await chrome.storage.session.get("browserLogin")).browserLogin !== state) throw new Error("Sign-in cancelled.");
    const returned = new URL(callback);
    if (`${returned.origin}${returned.pathname}` !== redirectUri || returned.searchParams.get("state") !== state) throw new Error("Invalid sign-in response. Start again.");
    if (!interactive && returned.searchParams.get("error")) return { state: "signin_required" };
    if (!returned.searchParams.get("code")) throw new Error("Invalid sign-in response. Start again.");
    const response = await fetch(`${baseUrl}/api/extension-auth/browser/exchange`, {
      method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: returned.searchParams.get("code"), verifier, redirect_uri: redirectUri }),
    });
    if (!response.ok) throw new Error("Sign-in expired or failed. Start again.");
    const result = await response.json();
    if ((await chrome.storage.session.get("browserLogin")).browserLogin !== state) {
      await new JobHuntBridge(baseUrl, result.key).disconnect();
      throw new Error("Sign-in cancelled.");
    }
    await clearConnection();
    await chrome.storage.local.set({ baseUrl, token: result.key, connectionType: "automatic" });
    return { state: "connected" };
  } finally {
    if ((await chrome.storage.session.get("browserLogin")).browserLogin === state) await chrome.storage.session.remove("browserLogin");
  }
}

/** The website in this browser signed in or out: drop a revoked connection, then follow it. */
async function websiteSession(signedIn) {
  if ((await settings()).token) {
    try {
      await (await bridge()).account();
      return { connected: true }; // Still valid; manual keys stay independent of the website.
    } catch (error) {
      if (error.status !== 401) throw error;
      await clearConnection();
    }
  }
  if (!signedIn || signingIn) return { connected: false };
  return { connected: (await browserSignIn(await platformOrigin(), false)).state === "connected" };
}

// Fixed destinations, plus the Applications add-job form prefilled with an http(s) job URL.
function isWebsitePath(path) {
  if (["/dashboard", "/applications", "/profile", "/settings#extension-ai"].includes(path)) return true;
  if (typeof path !== "string" || !path.startsWith("/applications?")) return false;
  const q = new URLSearchParams(path.slice("/applications?".length));
  if ([...q.keys()].some((k) => k !== "add" && k !== "url") || q.get("add") !== "1") return false;
  try { return /^https?:$/.test(new URL(q.get("url")).protocol); } catch { return false; }
}

async function openWebsite(path = "/dashboard") {
  if (!isWebsitePath(path)) throw new Error("Invalid website destination.");
  const s = await settings();
  if (s.connectionType !== "automatic" || !s.token) {
    await chrome.tabs.create({ url: `${s.baseUrl}${path}` });
    return true;
  }
  const { ticket } = await (await bridge()).websiteTicket();
  await chrome.tabs.create({ url: `${s.baseUrl}/extension-session#${new URLSearchParams({ ticket, next: path })}` });
  return true;
}

// ------------------------------------------------------------------ Autopilot sign-in jobs

// Autopilot can't finish a job that needs this browser's sign-ins (Workday, Taleo, …). The user
// turned its auto-submit on as a standing approval, so the platform hands such a job over with a
// one-time code. It opens in its own window; Auto apply runs there with its usual checks (every
// required field answered, one Submit button, a cancellable countdown) and the window closes
// shortly after the attempt. Anything else (a sign-in, a CAPTCHA, a missing answer, a form with
// several steps) leaves the window open for the user. Job boards never come this way: the platform
// doesn't offer them, and the form agent only runs in a tab the user started.
const AUTOPILOT_ALARM = "autopilot";
const AUTOPILOT_CONFIRM_WAIT_MS = 60_000; // the window stays open this long for the site's confirmation to show
const AUTOPILOT_CONFIRMED_CLOSE_MS = 3_000; // once the page confirms, just long enough to see it
const AUTOPILOT_WATCHDOG_MS = 15 * 60_000;
let autopilotPolling = false;

/** @returns {Promise<{appId: number, tabId: number, windowId: number, openedAt: number, closeAt?: number} | null>} */
async function autopilotWindow() {
  return (await chrome.storage.session.get("autopilotWindow")).autopilotWindow ?? null;
}

/** One poll: watches the window that is open, or opens one for the next job that is due. */
async function autopilotPoll() {
  if (autopilotPolling) return false;
  autopilotPolling = true;
  try {
    const s = await settings();
    if (!s.token || s.autopilotWindows === false) return false;
    const open = await autopilotWindow();
    if (open) return await autopilotWatch(open);
    const item = await (await bridge()).autopilotNext();
    const url = item ? autoApplyUrl(item.url, item.application_id, item.code) : null;
    if (!url) return false;
    const created = await chrome.windows.create({ url, focused: false });
    const tabId = created.tabs?.[0]?.id;
    if (created.id == null || tabId == null) return false;
    await chrome.storage.session.set({ autopilotWindow: { appId: item.application_id, tabId, windowId: created.id, openedAt: Date.now() } });
    return true;
  } finally {
    autopilotPolling = false;
  }
}

/** Closes the window once its close time has passed; a window nothing finished is flagged and left to the user. */
async function autopilotWatch(open) {
  if (open.closeAt) return autopilotCloseIfDue();
  if (Date.now() - open.openedAt < AUTOPILOT_WATCHDOG_MS) return false;
  await chrome.storage.session.remove("autopilotWindow");
  const agent = agents.get(open.tabId);
  // The form agent took the page over: it reports its own outcome.
  if (agent && !agent.stopped) return false;
  await (await bridge()).report({
    application_id: open.appId,
    event: "failed",
    failure_code: "blocker_not_cleared",
    note: "Autopilot opened this page in a window, but nothing was submitted within 15 minutes (a sign-in, a missing answer or a form with several steps). It was left open for you to finish.",
  }).catch((err) => console.warn("[JobHunt] autopilot report failed:", err.message));
  return false;
}

/** Auto apply clicked Submit (or the page confirmed it went through) in a tab: if Autopilot opened it, close it after the confirmation wait, or a moment after the page confirms. */
async function autopilotAttempted(tabId, { confirmed = false } = {}) {
  const open = await autopilotWindow();
  if (!open || open.tabId !== tabId) return false;
  const wait = confirmed ? AUTOPILOT_CONFIRMED_CLOSE_MS : AUTOPILOT_CONFIRM_WAIT_MS;
  const closeAt = Date.now() + wait;
  // A confirmation brings the close forward; a second attempt never pushes it back.
  if (open.closeAt && open.closeAt <= closeAt) return false;
  await chrome.storage.session.set({ autopilotWindow: { ...open, closeAt } });
  setTimeout(() => void autopilotCloseIfDue().catch(() => {}), wait);
  return true;
}

async function autopilotCloseIfDue() {
  const open = await autopilotWindow();
  if (!open?.closeAt || Date.now() < open.closeAt) return false;
  await chrome.storage.session.remove("autopilotWindow");
  // Only the tab Autopilot opened: anything the user added to that window stays.
  await chrome.tabs.remove(open.tabId).catch(() => {});
  return true;
}

async function ensureAutopilotAlarm() {
  if (!chrome.alarms || (await chrome.alarms.get(AUTOPILOT_ALARM))) return;
  chrome.alarms.create(AUTOPILOT_ALARM, { periodInMinutes: 1 });
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTOPILOT_ALARM) return;
  return syncOutcome().then(() => autopilotPoll()).catch(async (error) => {
    if (error.status === 401) await clearConnection();
    else console.warn("[JobHunt] autopilot poll failed:", error.message);
  });
});

// The user closed the window (or its tab) themselves: stop watching it.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await autopilotWindow())?.tabId === tabId) await chrome.storage.session.remove("autopilotWindow");
});
void ensureAutopilotAlarm();

// ------------------------------------------------------------------ form agent

// One agent at a time: it drives a tab the user started it in, never in the background.
const agents = new Map(); // tabId → Agent
let agentSources = null;

async function pageSources() {
  agentSources ??= Promise.all(AGENT_PAGE_SCRIPTS.map(async (path) => (await fetch(chrome.runtime.getURL(path))).text()))
    .then((parts) => parts.join("\n;\n"));
  return agentSources;
}

const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fileStem = (name) => (name ?? "").trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");

/** The files an upload action asks for, fetched once per run. */
function agentFiles(p, app) {
  const cache = {};
  return async (kind) => {
    if (kind === "cover_letter") {
      if (!app?.cover_letter) return null;
      const stem = fileStem(p.full_name);
      return { name: `${stem ? `${stem}_` : ""}Cover_Letter.txt`, type: "text/plain", base64: toBase64(app.cover_letter) };
    }
    if (!p.resume_url) return null;
    cache.resume ??= (await bridge()).resume(p.resume_url).then((r) => {
      if (!r) return null;
      const stem = fileStem(p.full_name);
      const ext = /\.[a-z0-9]+$/i.exec(r.name)?.[0] ?? ".pdf";
      return stem ? { ...r, name: `${stem}_Resume${ext}` } : r;
    });
    return cache.resume;
  };
}

async function agentReport(appId, event, res, url) {
  if (appId == null) return;
  const body = { application_id: appId, event, url: url?.slice(0, 2000) || null };
  if (event === "filled") {
    body.filled_fields = (res.filled ?? []).map((f) => ({ label: f.label, value: f.value, source: f.source, needs_review: f.needs_review }));
    body.unresolved_fields = (res.unresolved ?? []).map((label) => ({ label, reason: "No answer yet" }));
  } else if (event === "failed") {
    body.failure_code = res.failure_code ?? "unknown";
    body.note = String(res.message ?? "").slice(0, 1000) || null;
  }
  await (await bridge()).report(body).catch((err) => console.warn("[JobHunt] agent report failed:", err.message));
}

/** Starts the agent in a tab: from the popup (finds the application by URL) or the page's panel. */
async function agentStart(tabId, url, appId, autoSubmit = false) {
  const busy = [...agents.values()].find((a) => a.tabId !== tabId && !a.stopped && !["ready", "failed"].includes(a.status));
  if (busy) throw new Error("The agent is already working in another tab. Stop it there first.");
  agents.get(tabId)?.stop("Restarted.");
  const owner = await settings();
  const b = await bridge();
  const app = appId != null ? await b.application(appId) : (await b.lookup(url) ?? await b.trackApplication({ url: url.split("#")[0], title: clip((await chrome.tabs.get(tabId)).title, 300) }));
  const id = app?.id ?? null;
  const p = await profile();
  await setTab(tabId, { appId: id, origin: new URL(url).origin, tracked: id !== null });
  const agent = new Agent({
    tabId,
    appId: id,
    driver: new TabDriver(tabId, await pageSources()),
    step: (body) => b.agentStep(body),
    files: agentFiles(p, app),
    notify: async (message) => {
      // Keep approval in this background run across page navigation, and deliver it
      // once. Status lookups and reloads must never replay a submission choice.
      const current = await settings();
      if (current.token !== owner.token || current.baseUrl !== owner.baseUrl) autoSubmit = false;
      const submit = autoSubmit && message.status === "ready";
      if (["ready", "failed", "stopped"].includes(message.status)) autoSubmit = false;
      return chrome.tabs.sendMessage(tabId, { ...message, autoSubmit: submit }, { frameId: 0 }).catch(() => {});
    },
    report: (event, res, pageUrl) => agentReport(id, event, res, pageUrl),
  });
  agents.set(tabId, agent);
  if (id !== null) await b.report({ application_id: id, event: "opened", url: url.slice(0, 2000) }).catch(() => {});
  void agent.run();
  return { started: true, appId: id };
}

function agentControl(tabId, action, text) {
  const agent = agents.get(tabId);
  if (!agent) throw new Error("The agent isn't running in this tab.");
  if (action === "reply") {
    if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("Type an answer first.");
    agent.reply(text.trim());
  } else if (["skip", "resume", "pause", "stop"].includes(action)) {
    agent[action]();
  } else {
    throw new Error("Unknown agent action.");
  }
  return true;
}

function agentStatus(tabId) {
  const agent = agents.get(tabId);
  if (!agent) return null;
  return { type: "agentUpdate", status: agent.status, log: agent.log.slice(-40), appId: agent.appId, ...agent.last };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  agents.get(tabId)?.stop("The tab was closed.");
  agents.delete(tabId);
});

/** A content script on a web page, as opposed to an extension page (which can also be a tab). */
const fromPage = (sender) => Boolean(sender.tab) && /^https?:/.test(sender.url ?? "");

const handlers = {
  browserSignIn: async (msg) => browserSignIn(await platformOrigin(), msg.interactive !== false),
  aiSettings: async () => (await bridge()).aiSettings(),
  selectAI: async (msg) => (await bridge()).selectAI({ mode: msg.mode, provider: msg.provider }),
  saveAIProvider: async (msg) => {
    if (!["openai", "anthropic", "gemini"].includes(msg.provider)) throw new Error("Select a supported provider.");
    return (await bridge()).saveAIProvider(msg.provider, { api_key: msg.apiKey, model: msg.model });
  },
  deleteAIProvider: async (msg) => {
    if (!["openai", "anthropic", "gemini"].includes(msg.provider)) throw new Error("Select a supported provider.");
    return (await bridge()).deleteAIProvider(msg.provider);
  },
  openWebsite: (msg) => openWebsite(msg.path),
  connectionSettings: async () => {
    const s = await settings();
    return { baseUrl: s.baseUrl, configured: Boolean(s.token), aiDrafts: s.aiDrafts, autopilotWindows: s.autopilotWindows !== false, connectionType: s.connectionType ?? "manual" };
  },
  saveManualConnection: async (msg) => {
    const baseUrl = await platformOrigin();
    if ((await settings()).token) throw new Error("Revoke the current API key in ApplyShortly before replacing it.");
    if (typeof msg.token !== "string" || !msg.token.trim()) throw new Error("Enter your API key.");
    await clearConnection();
    await chrome.storage.local.set({ baseUrl, token: msg.token.trim(), connectionType: "manual" });
    return true;
  },
  pairingStart: async () => pairingStart(await platformOrigin()),
  pairingPoll: () => pairingPoll(),
  pairingCancel: () => chrome.storage.session.remove(["pairing", "browserLogin"]),
  disconnect: async () => {
    try { await (await bridge()).disconnect(); }
    catch (error) { if (error.status !== 401) throw error; }
    await clearConnection();
    return true;
  },
  panelPreference: async (msg) => {
    if (typeof msg.minimized === "boolean") await chrome.storage.local.set({ panelMinimized: msg.minimized });
    return Boolean((await chrome.storage.local.get("panelMinimized")).panelMinimized);
  },
  hello: (msg, sender) => hello(sender.tab.id, msg.url),
  webSession: async (msg, sender) => {
    if (new URL(sender.url).origin !== await platformOrigin()) throw new Error("Message not permitted.");
    return websiteSession(msg.signedIn === true);
  },
  start: (msg) => start(msg.tabId, msg.url, Boolean(msg.allowUntracked), msg.autoSubmit === true),
  context: (msg, sender) => context(msg.appId ?? null, sender.tab?.id, sender.url, msg.page),
  suggest: async (msg) =>
    (await bridge()).suggestAnswer({
      question: msg.question,
      application_id: msg.appId ?? null,
      allow_generate: Boolean(msg.allowGenerate),
      page: msg.appId == null && msg.allowGenerate ? pageJob(msg.page) : null,
    }),
  // The panel's Assistant tab: fields and values come from the page, nothing is stored.
  assist: async (msg) =>
    (await bridge()).assistFill({
      messages: msg.messages,
      fields: msg.fields,
      current: msg.current ?? {},
    }),
  resume: async () => {
    const p = await profile();
    return p.resume_url ? (await bridge()).resume(p.resume_url) : null;
  },
  report: async (msg, sender) => {
    if (msg.event.application_id == null) return null;
    if (msg.event.event === "submission_attempted" && sender.tab) {
      const tab = await getTab(sender.tab.id);
      if (tab) await setTab(sender.tab.id, { ...tab, attemptPending: true });
    }
    const result = ["submission_attempted", "submitted"].includes(msg.event.event)
      ? await syncOutcome(msg.event) : await (await bridge()).report(msg.event);
    if (msg.event.event === "submitted" && sender.tab) {
      await clearTab(sender.tab.id);
      await autopilotAttempted(sender.tab.id, { confirmed: true });
    }
    return result;
  },
  // Auto apply clicked the form's Submit button in this tab.
  autoApplied: (msg, sender) => autopilotAttempted(sender.tab.id),
  status: (msg) => status(msg.tabId, msg.url),
  // From the page's panel: its own tab. From the popup or options page: the tab they name.
  agentStart: (msg, sender) => (fromPage(sender)
    ? agentStart(sender.tab.id, sender.url, msg.appId ?? null, msg.autoSubmit === true)
    : agentStart(msg.tabId, msg.url, msg.appId ?? null, msg.autoSubmit === true)),
  agentControl: (msg, sender) => agentControl(fromPage(sender) ? sender.tab.id : msg.tabId, msg.action, msg.text),
  agentStatus: (msg, sender) => agentStatus(fromPage(sender) ? sender.tab.id : msg.tabId),
  openOptions: () => chrome.runtime.openOptionsPage(),
  openProfile: () => openWebsite("/profile"),
  test: async () => {
    profileCache = null;
    return status(undefined);
  },
};

// Keyboard shortcut (Alt+Shift+F by default): like the popup's button, but fills untracked
// pages without asking, since there's no popup to ask in.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== "autofill" || !tab?.id || !/^https?:/.test(tab.url ?? "")) return;
  start(tab.id, tab.url, true).catch((err) => console.warn("[JobHunt] shortcut failed:", err.message));
});

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The page's job for drafting on an untracked page, trimmed to the API's limits; none without a title. */
function pageJob(page) {
  if (!page || typeof page !== "object") return null;
  const job = { title: clip(page.title, 300), company: clip(page.company, 200), description: clip(page.description, 6000) };
  return job.title ? job : null;
}

const CONTENT_MESSAGES = new Set(["hello", "context", "suggest", "assist", "resume", "report", "openOptions", "openProfile", "panelPreference", "webSession", "agentStart", "agentControl", "agentStatus", "autoApplied"]);

async function dispatch(msg, sender) {
  await storageReady;
  if (!msg || typeof msg !== "object" || sender.id !== chrome.runtime.id) throw new Error("Invalid extension message.");
  const handler = handlers[msg.type];
  if (!handler) throw new Error("Unknown extension message.");
  const extensionPage = ["src/options.html", "src/popup.html"].some((path) => sender.url === chrome.runtime.getURL(path));
  if (!extensionPage) {
    if (!sender.tab || !/^https?:/.test(sender.url ?? "") || !CONTENT_MESSAGES.has(msg.type)) throw new Error("Message not permitted.");
    if (["context", "suggest", "assist", "report", "agentStart"].includes(msg.type)) {
      const current = await getTab(sender.tab.id);
      const appId = msg.type === "report" ? msg.event?.application_id : (msg.appId ?? null);
      if (appId !== (current?.appId ?? null) || (current && current.origin !== new URL(sender.url).origin)) throw new Error("Application context changed. Start autofill again.");
    }
  }
  if (msg.type === "assist" && (!Array.isArray(msg.messages) || !msg.messages.length || !Array.isArray(msg.fields) || !msg.fields.length)) throw new Error("Nothing to send.");
  if (msg.type === "suggest" && (typeof msg.question !== "string" || msg.question.length < 3 || msg.question.length > 1000)) throw new Error("Invalid question.");
  try { return await handler(msg, sender); }
  catch (error) { if (error.status === 401) await clearConnection(); throw error; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  dispatch(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err), status: err?.status, code: err?.code }));
  return true;
});

// A public origin-only config is safe to distribute. Never seed credentials from files.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await storageReady;
  await platformOrigin();
  await ensureAutopilotAlarm();
  if (reason === "install" && !(await settings()).token) await chrome.runtime.openOptionsPage();
});
