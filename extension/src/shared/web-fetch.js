import { AGENT_RULES } from "./agent-rules.js";
// The custom-provider planner's web_fetch: read a public page the user pointed it at.
// Only an https link the user typed in this chat is opened, never one found on the form being
// filled, so a page cannot steer the extension to a URL of its own choosing. Requests carry no
// cookies, and what comes back is untrusted text handed to the model as data.

export const MAX_LINKS = AGENT_RULES.typed_links.max_links;
export const MAX_CHARS = 6000;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8000;
const LINK = new RegExp(AGENT_RULES.typed_links.pattern, "gi");
const GITHUB_REPO = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const GITHUB_RESERVED = new Set(["orgs", "sponsors", "settings", "marketplace", "topics", "features", "about"]);

/** A link as typed, minus sentence punctuation; scheme and host lower-cased, no fragment. */
export function normalizeLink(raw) {
  try {
    const url = new URL(String(raw).trim().replace(new RegExp(`[${AGENT_RULES.typed_links.trailing_punctuation}]+$`), ""));
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href.replace(/\/$/, "");
  } catch { return ""; }
}

/** `known` plus the https links in what the user typed (newest kept, capped). */
export function addTypedLinks(known, text) {
  const found = (String(text ?? "").match(LINK) ?? []).map(normalizeLink).filter((url) => url.startsWith(AGENT_RULES.typed_links.allowed_scheme) && !known.includes(url));
  return [...known, ...new Set(found)].slice(-MAX_LINKS);
}

export const isTypedLink = (known, url) => { const key = normalizeLink(url); return Boolean(key) && known.includes(key); };

/** A host that is internal by its name alone: loopback, a dotless name, an internal suffix or a private IP literal. */
export function internalHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || (!host.includes(".") && !host.includes(":"))) return true;
  if (/\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  if (host.includes(":")) return true; // IPv6 literals: never a public website a person types
  const octets = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!octets) return /^\d+$/.test(host) || /^0x/i.test(host); // 2130706433 and 0x7f000001 are IPv4 too
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** A GitHub repository page is mostly navigation; its README is what describes the project. */
export function readableUrl(link) {
  const url = new URL(link);
  if (["github.com", "www.github.com"].includes(url.hostname) && !url.search) {
    const match = GITHUB_REPO.exec(url.pathname);
    if (match && !GITHUB_RESERVED.has(match[1].toLowerCase())) return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/HEAD/README.md`;
  }
  return url.href;
}

const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[name]);

/** Page text without markup, scripts or styles, collapsed to readable lines. */
export function toText(body) {
  const text = body.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|section|article|pre|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decode(text).split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/**
 * The page text for the model, or a sentence saying why it could not be read. Never throws.
 * @param {string} link a link the user typed
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function fetchPage(link, { fetchImpl = fetch } = {}) {
  const key = normalizeLink(link);
  let target;
  try { target = new URL(key); } catch { return "Not read: that is not a web address."; }
  if (target.protocol !== "https:" || target.username || target.password || internalHost(target.hostname)) return "Not read: only public https websites can be opened.";
  try {
    const res = await fetchImpl(readableUrl(key), { credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer", headers: { Accept: "text/html,text/plain,text/markdown,*/*;q=0.5" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    // A redirect may have led somewhere internal: the request is made, but nothing from it is used.
    const final = new URL(res.url || key);
    if (final.protocol !== "https:" || internalHost(final.hostname)) return "Not read: the link led to a private address.";
    if (!res.ok) return `Not read: ${final.hostname} answered HTTP ${res.status}.`;
    const type = String(res.headers?.get?.("content-type") ?? "");
    if (type && !/^(?:text\/|application\/(?:xhtml|json))/i.test(type)) return "Not read: the link is not a text page.";
    const body = (await res.text()).slice(0, MAX_BYTES);
    const text = /<\/?[a-z][^>]*>/i.test(body.slice(0, 2000)) ? toText(body) : body.trim();
    if (!text) return `${final.href} has no readable text.`;
    return `WEB PAGE ${final.href}${text.length > MAX_CHARS ? " (cut short)" : ""}\n${text.slice(0, MAX_CHARS)}`;
  } catch {
    return "Not read: the site could not be reached, or it does not allow the extension to read it.";
  }
}
