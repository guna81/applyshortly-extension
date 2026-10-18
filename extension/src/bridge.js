// Client for the platform's extension bridge (/api/extension/*).
// A plain-JS port of extension-bridge/client.ts; keep the two in sync.
// Only the background service worker imports this: requests to the platform origin from there
// aren't subject to the job page's CORS rules, and the API key never enters page context.

export const AUTOFILL_FRAGMENT = "jobhunt-autofill";

/** @param {string} url @returns {number | null} */
export function autofillIdFromUrl(url) {
  try {
    const match = new URL(url).hash.match(new RegExp(`${AUTOFILL_FRAGMENT}=(\\d+)`));
    return match?.[1] ? Number(match[1]) : null;
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

  report(event) {
    return this.request("/api/extension/events", { method: "POST", body: JSON.stringify(event) });
  }
}
