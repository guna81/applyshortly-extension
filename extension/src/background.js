// Background service worker: owns the API key and every request to the platform.
// Content scripts and the popup talk to it with chrome.runtime messages ({type, ...}).

import { BridgeError, JobHuntBridge, autofillIdFromUrl } from "./bridge.js";

const DEFAULT_SETTINGS = { baseUrl: "http://localhost:3000", token: "", aiDrafts: false };
const PROFILE_TTL_MS = 60_000;
const CONTENT_SCRIPTS = ["src/fill.js", "src/panel-model.js", "src/content.js"];

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
  const stored = await chrome.storage.local.get(["baseUrl", "token", "aiDrafts", "connectionType"]);
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

async function profile() {
  const s = await settings();
  const key = `${s.baseUrl}|${s.token}`;
  await (await bridge()).account(); // Check revocation before returning cached personal data.
  if (profileCache && profileCache.key === key && Date.now() - profileCache.at < PROFILE_TTL_MS) {
    return profileCache.profile;
  }
  const p = await (await bridge()).profile();
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
  const id = autofillIdFromUrl(url);
  if (id !== null) {
    await setTab(tabId, { appId: id, origin, tracked: true });
    return { appId: id, mode: "fill" };
  }
  const current = await getTab(tabId);
  if (current && current.origin === origin) return { appId: current.appId, mode: "continue" };
  return { appId: null, mode: "idle" };
}

/** Popup → "Autofill this page": find the application for the page, or fill untracked. */
async function start(tabId, url, allowUntracked) {
  const origin = new URL(url).origin;
  const current = await getTab(tabId);
  const existing = autofillIdFromUrl(url) ?? (current?.origin === origin ? current.appId : null);
  const app = existing !== null ? await (await bridge()).application(existing) : await (await bridge()).lookup(url);
  if (!app && !allowUntracked) return { found: false };
  const appId = app?.id ?? null;
  await setTab(tabId, { appId, origin, tracked: appId !== null });
  await sendToTab(tabId, { type: "run", appId });
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

async function context(appId) {
  const b = await bridge();
  const [p, app, s] = await Promise.all([
    profile(),
    appId !== null ? b.application(appId) : Promise.resolve(null),
    settings(),
  ]);
  return { profile: p, app, aiDrafts: s.aiDrafts, baseUrl: s.baseUrl };
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
  await chrome.storage.local.remove(["token", "connectionType"]);
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
  if ((await settings()).token) throw new Error("Disconnect your current account before connecting another account.");
  if ((await chrome.storage.session.get("browserLogin")).browserLogin) throw new Error("Sign-in is already in progress. Cancel it before trying again.");
  const baseUrl = validatedOrigin(rawOrigin);
  const redirectUri = chrome.identity.getRedirectURL("applyshortly");
  let config;
  try {
    config = await fetch(`${baseUrl}/api/extension-auth/browser/config?${new URLSearchParams({ redirect_uri: redirectUri })}`, { credentials: "omit" });
  } catch {
    throw new Error("Cannot reach ApplyShortly. Check that your ApplyShortly server is running.");
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
    const url = `${baseUrl}/extension-authorize?${new URLSearchParams({ redirect_uri: redirectUri, challenge, state })}`;
    let callback;
    try {
      callback = await chrome.identity.launchWebAuthFlow({ url, interactive, ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15000 }) });
    } catch (error) {
      if (!interactive) return { state: "signin_required" };
      throw error;
    }
    if ((await chrome.storage.session.get("browserLogin")).browserLogin !== state) throw new Error("Sign-in cancelled.");
    const returned = new URL(callback);
    if (`${returned.origin}${returned.pathname}` !== redirectUri || returned.searchParams.get("state") !== state || !returned.searchParams.get("code")) throw new Error("Invalid sign-in response. Start again.");
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

// Fixed destinations, plus the queue's add-job dialog prefilled with an http(s) job URL.
function isWebsitePath(path) {
  if (["/dashboard", "/apply-queue", "/settings#extension-ai"].includes(path)) return true;
  if (typeof path !== "string" || !path.startsWith("/apply-queue?")) return false;
  const q = new URLSearchParams(path.slice("/apply-queue?".length));
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

// ---- side-panel assistant ----

const CHAT_TABS = ["chat", "today", "apply", "board", "profile"];
const CHAT_STATUSES = ["saved", "queued", "assessment", "interview", "offer", "rejected", "withdrawn", "ghosted"];

/** A page the assistant may see: http(s) address (no fragment) and title, nothing else. */
function sharedPage(page) {
  if (!page || typeof page.url !== "string" || page.url.length > 2000 || !/^https?:/.test(page.url)) return null;
  return { url: page.url.split("#")[0], title: String(page.title ?? "").slice(0, 200) };
}

async function pageInfo(tabId) {
  try { return sharedPage(await chrome.tabs.sendMessage(tabId, { type: "pageInfo" })); }
  catch { return null; } // No content script (browser page, or not reloaded since install).
}

async function activePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const info = tab?.id !== undefined ? await pageInfo(tab.id) : null;
  if (!info) return null;
  const app = await (await bridge()).lookup(info.url).catch((error) => {
    if (error.status === 401) throw error;
    return null;
  });
  return { ...info, app: app && { id: app.id, title: app.title, company_name: app.company_name, status: app.status } };
}

async function tabData(tab) {
  const b = await bridge();
  if (tab === "today") return b.todayMatches();
  if (tab === "apply") return (await Promise.all(["saved", "queued", "ready_for_review"].map((s) => b.applications(s)))).flat();
  if (tab === "board") return b.applications();
  if (tab === "profile") return profile();
  throw new Error("Unknown tab.");
}

/** "Autofill" from the assistant: fill the open page if it is this application, else open it. */
async function autofillApplication(appId) {
  if (!Number.isInteger(appId)) throw new Error("Unknown application.");
  const b = await bridge();
  const app = await b.application(appId);
  if ((await chrome.storage.local.get("sharePage")).sharePage) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const info = tab?.id !== undefined ? await pageInfo(tab.id) : null;
    const here = info ? await b.lookup(info.url).catch(() => null) : null;
    if (here?.id === appId) {
      await start(tab.id, info.url, false);
      return { ok: true, message: "Filling this page. Review it, then submit it yourself." };
    }
  }
  const target = app.apply_url ? new URL(app.apply_url) : null;
  if (!target || !/^https?:$/.test(target.protocol)) throw new Error("This application has no apply link.");
  target.hash = `jobhunt-autofill=${appId}`;
  await chrome.tabs.create({ url: target.toString() });
  return { ok: true, message: "Opened the application page. I'll fill it in; you review and submit." };
}

async function chatAction(action) {
  if (!action || typeof action !== "object") throw new Error("Invalid action.");
  if (action.type === "autofill") return autofillApplication(action.application_id);
  if (!["queue_job", "dismiss_job", "set_status"].includes(action.type)) throw new Error("Unknown action.");
  if (action.type === "set_status" && !CHAT_STATUSES.includes(action.status)) throw new Error("Invalid status.");
  return (await bridge()).runAction({
    type: action.type,
    job_id: action.job_id ?? null,
    application_id: action.application_id ?? null,
    status: action.status ?? null,
  });
}

const handlers = {
  chat: async (msg) => {
    if (!Array.isArray(msg.messages) || !msg.messages.length) throw new Error("Nothing to send.");
    return (await bridge()).assistantChat({
      messages: msg.messages,
      tab: CHAT_TABS.includes(msg.tab) ? msg.tab : "chat",
      page: sharedPage(msg.page),
    });
  },
  chatAction: (msg) => chatAction(msg.action),
  tabData: (msg) => tabData(msg.tab),
  activePage: () => activePage(),
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
    return { baseUrl: s.baseUrl, configured: Boolean(s.token), aiDrafts: s.aiDrafts, connectionType: s.connectionType ?? "manual" };
  },
  saveManualConnection: async (msg) => {
    const baseUrl = await platformOrigin();
    if ((await settings()).token) throw new Error("Disconnect your current account before replacing its API key.");
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
  start: (msg) => start(msg.tabId, msg.url, Boolean(msg.allowUntracked)),
  context: (msg) => context(msg.appId ?? null),
  suggest: async (msg) =>
    (await bridge()).suggestAnswer({
      question: msg.question,
      application_id: msg.appId ?? null,
      allow_generate: Boolean(msg.allowGenerate),
    }),
  resume: async () => {
    const p = await profile();
    return p.resume_url ? (await bridge()).resume(p.resume_url) : null;
  },
  report: async (msg, sender) => {
    if (msg.event.application_id == null) return null;
    const result = await (await bridge()).report(msg.event);
    if (msg.event.event === "submitted" && sender.tab) await clearTab(sender.tab.id);
    return result;
  },
  status: (msg) => status(msg.tabId, msg.url),
  openOptions: () => chrome.runtime.openOptionsPage(),
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

const CONTENT_MESSAGES = new Set(["hello", "context", "suggest", "resume", "report", "openOptions", "panelPreference"]);

async function dispatch(msg, sender) {
  await storageReady;
  if (!msg || typeof msg !== "object" || sender.id !== chrome.runtime.id) throw new Error("Invalid extension message.");
  const handler = handlers[msg.type];
  if (!handler) throw new Error("Unknown extension message.");
  const extensionPage = ["src/options.html", "src/popup.html", "src/sidepanel.html"].some((path) => sender.url === chrome.runtime.getURL(path));
  if (!extensionPage) {
    if (!sender.tab || !/^https?:/.test(sender.url ?? "") || !CONTENT_MESSAGES.has(msg.type)) throw new Error("Message not permitted.");
    if (["context", "suggest", "report"].includes(msg.type)) {
      const current = await getTab(sender.tab.id);
      const appId = msg.type === "report" ? msg.event?.application_id : (msg.appId ?? null);
      if (appId !== (current?.appId ?? null) || (current && current.origin !== new URL(sender.url).origin)) throw new Error("Application context changed. Start autofill again.");
    }
  }
  if (msg.type === "suggest" && (typeof msg.question !== "string" || msg.question.length < 3 || msg.question.length > 1000)) throw new Error("Invalid question.");
  try { return await handler(msg, sender); }
  catch (error) { if (error.status === 401) await clearConnection(); throw error; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  dispatch(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err), status: err?.status }));
  return true;
});

// A public origin-only config is safe to distribute. Never seed credentials from files.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await storageReady;
  await platformOrigin();
  if (reason === "install" && !(await settings()).token) await chrome.runtime.openOptionsPage();
});
