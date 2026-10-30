// Client for the platform's extension bridge (/api/extension/*).
// A plain-JS port of extension-bridge/client.ts; keep the two in sync.
// Only the background service worker imports this: requests to the platform origin from there
// aren't subject to the job page's CORS rules, and the API key never enters page context.

export const AUTOFILL_FRAGMENT = "jobhunt-autofill";
// Added when the user clicked Apply in ApplyShortly: a one-time code that, claimed, lets Auto apply
// submit (only once every required field is answered, after its countdown).
export const AUTO_APPLY_FRAGMENT = "jobhunt-auto";

/** @param {string} url @returns {number | null} */
export function autofillIdFromUrl(url) {
  try {
    const match = new URL(url).hash.match(new RegExp(`${AUTOFILL_FRAGMENT}=(\\d+)`));
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** @param {string} url @returns {string | null} */
export function autoApplyCodeFromUrl(url) {
  try {
    const match = new URL(url).hash.match(new RegExp(`${AUTO_APPLY_FRAGMENT}=([A-Za-z0-9_-]{16,64})`));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The page Autopilot's window opens: the posting with the application id and the one-time code in
 * the fragment, like the link ApplyShortly's Apply button opens. Null unless the link is http(s).
 * @param {string} url @param {number} id @param {string} code @returns {string | null}
 */
export function autoApplyUrl(url, id, code) {
  try {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || !Number.isInteger(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
    target.hash = `${AUTOFILL_FRAGMENT}=${id}&${AUTO_APPLY_FRAGMENT}=${code}`;
    return target.href;
  } catch {
    return null;
  }
}

export class BridgeError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class JobHuntBridge {
  /** @param {string} baseUrl e.g. "http://localhost:3000" @param {string} token the API key */
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async request(path, init = {}) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new BridgeError(0, `Can't reach ${this.baseUrl}. Is the platform running?`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new BridgeError(res.status, typeof body.detail === "string" ? body.detail : res.statusText);
    }
    return res.status === 204 ? null : res.json();
  }

  account() { return this.request("/api/extension/account"); }

  aiSettings() { return this.request("/api/extension/ai"); }

  selectAI(body) { return this.request("/api/extension/ai", { method: "PUT", body: JSON.stringify(body) }); }

  saveAIProvider(provider, body) { return this.request(`/api/extension/ai/providers/${encodeURIComponent(provider)}`, { method: "PUT", body: JSON.stringify(body) }); }

  deleteAIProvider(provider) { return this.request(`/api/extension/ai/providers/${encodeURIComponent(provider)}`, { method: "DELETE" }); }

  websiteTicket() { return this.request("/api/extension-auth/website-ticket", { method: "POST" }); }

  disconnect() { return this.request("/api/extension/disconnect", { method: "POST" }); }

  profile() {
    return this.request("/api/extension/profile");
  }

  /** @returns {Promise<{name: string, type: string, base64: string} | null>} */
  async resume(resumeUrl = "/api/extension/resume") {
    const res = await fetch(`${this.baseUrl}${resumeUrl}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    }).catch(() => null);
    if (!res?.ok) return null;
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const name = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? "resume.pdf";
    const buffer = new Uint8Array(await res.arrayBuffer());
    // Message passing only carries JSON, so the file travels to the content script as base64.
    let binary = "";
    for (let i = 0; i < buffer.length; i += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
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
   * @returns {Promise<{application_id: number, url: string, code: string} | null>}
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
  agentStep(body) {
    return this.request("/api/extension/agent/step", { method: "POST", body: JSON.stringify(body) });
  }

  report(event) {
    return this.request("/api/extension/events", { method: "POST", body: JSON.stringify(event) });
  }
}
