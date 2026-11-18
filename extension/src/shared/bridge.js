import { queueDiagnostic, flushDiagnostics } from "./diagnostics.js";
const AUTOFILL_FRAGMENT = "jobhunt-autofill";
const AUTO_APPLY_FRAGMENT = "jobhunt-auto";
function autofillIdFromUrl(url) {
  try {
    const match = new URL(url).hash.match(new RegExp(`${AUTOFILL_FRAGMENT}=(\\d+)`));
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
function autoApplyCodeFromUrl(url) {
  try {
    const match = new URL(url).hash.match(new RegExp(`${AUTO_APPLY_FRAGMENT}=([A-Za-z0-9_-]{16,64})`));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
function autoApplyUrl(url, id, code) {
  try {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || !Number.isInteger(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
    target.hash = `${AUTOFILL_FRAGMENT}=${id}&${AUTO_APPLY_FRAGMENT}=${code}`;
    return target.href;
  } catch {
    return null;
  }
}
function errorMessage(body, statusText) {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const items = detail.slice(0, 3).map((d) => {
      const where = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
      return [where, typeof d?.msg === "string" ? d.msg : ""].filter(Boolean).join(": ");
    }).filter(Boolean);
    if (items.length) return `${statusText || "Rejected"} (${items.join("; ")}${detail.length > 3 ? "; \u2026" : ""})`;
  }
  return statusText;
}
const REQUEST_TIMEOUT_MS = 3e4;
const AGENT_TIMEOUT_MS = 9e4;
class BridgeError extends Error {
  status;
  code;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class JobHuntBridge {
  baseUrl;
  token;
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }
  /**
   * One platform call. It never waits forever: after `timeout` ms the request is aborted and fails
   * as a 408, which the agent loop treats as transient (retry, then pause for the user).
   */
  async request(path, { timeout = REQUEST_TIMEOUT_MS, ...init } = {}) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BridgeError(408, `The platform didn't answer within ${Math.round(timeout / 1e3)} seconds.`));
      }, timeout);
    });
    expired.catch(() => {
    });
    const call = async () => {
      let res;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...init.body ? { "Content-Type": "application/json" } : {},
            ...init.headers
          }
        });
      } catch {
        if (controller.signal.aborted)
          throw new BridgeError(408, `The platform didn't answer within ${Math.round(timeout / 1e3)} seconds.`);
        throw new BridgeError(0, `Can't reach ${this.baseUrl}. Is the platform running?`);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new BridgeError(res.status, errorMessage(body, res.statusText));
      }
      return res.status === 204 ? null : res.json();
    };
    try {
      return await Promise.race([call(), expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  browserRelayUrl() {
    const url = new URL(`${this.baseUrl}/api/extension/browser/relay`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }
  registerBrowser(name) {
    return this.request("/api/extension/browser/devices", { method: "POST", body: JSON.stringify({ name }) });
  }
  account() {
    return this.request("/api/extension/account");
  }
  aiSettings() {
    return this.request("/api/extension/ai");
  }
  selectAI(body) {
    return this.request("/api/extension/ai", { method: "PUT", body: JSON.stringify(body) });
  }
  deleteAIProvider(provider) {
    return this.request(`/api/extension/ai/providers/${encodeURIComponent(provider)}`, { method: "DELETE" });
  }
  websiteTicket() {
    return this.request("/api/extension-auth/website-ticket", { method: "POST" });
  }
  disconnect() {
    return this.request("/api/extension/disconnect", { method: "POST" });
  }
  profile() {
    return this.request("/api/extension/profile");
  }
  async resume(resumeUrl = "/api/extension/resume") {
    const res = await fetch(`${this.baseUrl}${resumeUrl}`, {
      headers: { Authorization: `Bearer ${this.token}` }
    }).catch(() => null);
    if (!res?.ok) return null;
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const name = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? "resume.pdf";
    const buffer = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 32768) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 32768));
    }
    return { name: decodeURIComponent(name), type: res.headers.get("Content-Type") ?? "application/pdf", base64: btoa(binary) };
  }
  application(id) {
    return this.request(`/api/extension/applications/${id}`);
  }
  /** Register a page the user started filling so its outcome syncs to Applications. */
  trackApplication(body) {
    return this.request("/api/extension/applications/track", { method: "POST", body: JSON.stringify(body) });
  }
  /** Claims the one-time Auto apply code from the link ApplyShortly opened; true only once. */
  claimAutoApply(id, code) {
    return this.request(`/api/extension/applications/${id}/auto-apply`, { method: "POST", body: JSON.stringify({ code }) });
  }
  /**
   * The next job Autopilot couldn't finish on its own because it needs this browser's sign-ins, with
   * the one-time Auto apply code for it; null when nothing is due.
   */
  autopilotNext() {
    return this.request("/api/extension/autopilot/next", { method: "POST" });
  }
  /** Resolves to null when the page isn't a tracked application. */
  async lookup(pageUrl) {
    try {
      return await this.request(`/api/extension/applications/lookup?url=${encodeURIComponent(pageUrl)}`);
    } catch (err) {
      if (err instanceof BridgeError && err.status === 404) return null;
      throw err;
    }
  }
  suggestAnswer(body) {
    return this.request("/api/extension/answers/suggest", { method: "POST", body: JSON.stringify(body) });
  }
  assistFill(body) {
    return this.request("/api/extension/assistant/fill", { method: "POST", body: JSON.stringify(body) });
  }
  /** One round trip: vetted actions, or want_screenshot with optional annotate_screenshot. */
  agentCapabilities(custom = false, engine = "ai_led") {
    const query = new URLSearchParams({ extension_engine: engine, ...custom ? { planner: "custom" } : {} });
    return this.request(`/api/extension/agent/capabilities?${query}`);
  }
  agentModel(body) {
    return this.request("/api/extension/agent/model", { method: "POST", body: JSON.stringify(body), timeout: AGENT_TIMEOUT_MS });
  }
  diagnostic(body) {
    return this.request("/api/extension/agent/diagnostic", { method: "POST", body: JSON.stringify(body) });
  }
  async agentStep(body) {
    const version = globalThis.chrome?.runtime?.getManifest?.().version;
    body = { ...body, runtime_version: version };
    void flushDiagnostics(this);
    const send = (b) => this.request("/api/extension/agent/step", { method: "POST", body: JSON.stringify(b), timeout: AGENT_TIMEOUT_MS });
    try {
      try {
        return await send(body);
      } catch (error) {
        if (error.status !== 422 || !/runtime_version/.test(error.message)) throw error;
        const { runtime_version: _skipped, ...legacy } = body;
        body = legacy;
        return await send(body);
      }
    } catch (error) {
      const rejected = error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403;
      if (!error.status || error.status >= 500 || rejected) {
        const code = rejected ? "request_rejected" : "network_error";
        void queueDiagnostic(this, {
          session_key: `agent:${body.session_id || body.request_id || crypto.randomUUID()}`,
          application_id: body.application_id ?? null,
          runtime: "extension",
          status: rejected ? "failed" : "interrupted",
          page_url: body.observation?.url || "",
          failure_code: code,
          stage: "transport",
          version,
          events: [
            {
              id: crypto.randomUUID(),
              sequence: 0,
              kind: "error",
              data: { code, http_status: error.status || 0, message: String(error.message || "").slice(0, 500) }
            }
          ]
        });
      }
      throw error;
    }
  }
  report(event) {
    return this.request("/api/extension/events", { method: "POST", body: JSON.stringify(event) });
  }
}
export {
  AGENT_TIMEOUT_MS,
  AUTOFILL_FRAGMENT,
  AUTO_APPLY_FRAGMENT,
  BridgeError,
  JobHuntBridge,
  REQUEST_TIMEOUT_MS,
  autoApplyCodeFromUrl,
  autoApplyUrl,
  autofillIdFromUrl,
  errorMessage
};
