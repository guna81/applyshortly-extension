import { queueDiagnostic, flushDiagnostics } from "./diagnostics.js";
import type {
  ExtensionAccount,
  ExtensionApplication,
  ExtensionEvent,
  ExtensionEventResult,
  ExtensionProfile,
} from "./types.js";

// Client for the platform's extension bridge (/api/extension/*).
// A typed port of extension-bridge/client.ts; keep the two in sync.
// Only the background service worker imports this: requests to the platform origin from there
// aren't subject to the job page's CORS rules, and the API key never enters page context.

export const AUTOFILL_FRAGMENT = "jobhunt-autofill";
// Added when the user clicked Apply in ApplyShortly: a one-time code that, claimed, lets Auto apply
// submit (only once every required field is answered, after its countdown).
export const AUTO_APPLY_FRAGMENT = "jobhunt-auto";

export function autofillIdFromUrl(url: string): number | null {
  try {
    const match = new URL(url).hash.match(new RegExp(`${AUTOFILL_FRAGMENT}=(\\d+)`));
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function autoApplyCodeFromUrl(url: string): string | null {
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
 */
export function autoApplyUrl(url: string, id: number, code: string): string | null {
  try {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || !Number.isInteger(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
    target.hash = `${AUTOFILL_FRAGMENT}=${id}&${AUTO_APPLY_FRAGMENT}=${code}`;
    return target.href;
  } catch {
    return null;
  }
}

interface ErrorDetailItem {
  loc?: Array<string | number>;
  msg?: string;
  [key: string]: unknown;
}

/**
 * The message for a failed request. A validation failure (422) carries a list, not a string: name
 * the fields it rejected ("observation.elements.3.popup: extra inputs are not permitted") rather
 * than the bare status text, so a rejected page can be told apart from a broken server.
 */
export function errorMessage(body: { detail?: unknown } | null | undefined, statusText: string): string {
  const detail = body?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const items = (detail as ErrorDetailItem[])
      .slice(0, 3)
      .map((d) => {
        const where = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
        return [where, typeof d?.msg === "string" ? d.msg : ""].filter(Boolean).join(": ");
      })
      .filter(Boolean);
    if (items.length) return `${statusText || "Rejected"} (${items.join("; ")}${detail.length > 3 ? "; …" : ""})`;
  }
  return statusText;
}

/** Ordinary platform calls; the agent's model and step calls are slower and get AGENT_TIMEOUT_MS. */
export const REQUEST_TIMEOUT_MS = 30000;
export const AGENT_TIMEOUT_MS = 90000;

export class BridgeError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ResumeFile {
  name: string;
  type: string;
  base64: string;
}

export interface RequestOptions extends RequestInit {
  timeout?: number;
}

export class JobHuntBridge {
  baseUrl: string;
  token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  /**
   * One platform call. It never waits forever: after `timeout` ms the request is aborted and fails
   * as a 408, which the agent loop treats as transient (retry, then pause for the user).
   */
  async request<T = any>(path: string, { timeout = REQUEST_TIMEOUT_MS, ...init }: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    let timer: any;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BridgeError(408, `The platform didn't answer within ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
    });
    expired.catch(() => {});
    const call = async (): Promise<T> => {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        });
      } catch {
        if (controller.signal.aborted)
          throw new BridgeError(408, `The platform didn't answer within ${Math.round(timeout / 1000)} seconds.`);
        throw new BridgeError(0, `Can't reach ${this.baseUrl}. Is the platform running?`);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new BridgeError(res.status, errorMessage(body, res.statusText));
      }
      return res.status === 204 ? (null as T) : res.json();
    };
    try {
      return await Promise.race([call(), expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  browserRelayUrl(): string {
    const url = new URL(`${this.baseUrl}/api/extension/browser/relay`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  registerBrowser(name: string): Promise<any> {
    return this.request("/api/extension/browser/devices", { method: "POST", body: JSON.stringify({ name }) });
  }

  account(): Promise<ExtensionAccount> {
    return this.request("/api/extension/account");
  }

  aiSettings(): Promise<any> {
    return this.request("/api/extension/ai");
  }

  selectAI(body: any): Promise<any> {
    return this.request("/api/extension/ai", { method: "PUT", body: JSON.stringify(body) });
  }

  deleteAIProvider(provider: string): Promise<any> {
    return this.request(`/api/extension/ai/providers/${encodeURIComponent(provider)}`, { method: "DELETE" });
  }

  websiteTicket(): Promise<{ ticket: string }> {
    return this.request("/api/extension-auth/website-ticket", { method: "POST" });
  }

  disconnect(): Promise<any> {
    return this.request("/api/extension/disconnect", { method: "POST" });
  }

  profile(): Promise<ExtensionProfile> {
    return this.request("/api/extension/profile");
  }

  async resume(resumeUrl: string = "/api/extension/resume"): Promise<ResumeFile | null> {
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

  application(id: number): Promise<ExtensionApplication> {
    return this.request(`/api/extension/applications/${id}`);
  }

  /** Register a page the user started filling so its outcome syncs to Applications. */
  trackApplication(body: any): Promise<any> {
    return this.request("/api/extension/applications/track", { method: "POST", body: JSON.stringify(body) });
  }

  /** Claims the one-time Auto apply code from the link ApplyShortly opened; true only once. */
  claimAutoApply(id: number, code: string): Promise<boolean> {
    return this.request(`/api/extension/applications/${id}/auto-apply`, { method: "POST", body: JSON.stringify({ code }) });
  }

  /**
   * The next job Autopilot couldn't finish on its own because it needs this browser's sign-ins, with
   * the one-time Auto apply code for it; null when nothing is due.
   */
  autopilotNext(): Promise<{ application_id: number; url: string; code: string } | null> {
    return this.request("/api/extension/autopilot/next", { method: "POST" });
  }

  /** Resolves to null when the page isn't a tracked application. */
  async lookup(pageUrl: string): Promise<ExtensionApplication | null> {
    try {
      return await this.request(`/api/extension/applications/lookup?url=${encodeURIComponent(pageUrl)}`);
    } catch (err) {
      if (err instanceof BridgeError && err.status === 404) return null;
      throw err;
    }
  }

  suggestAnswer(body: { question: string; application_id?: number | null; allow_generate?: boolean; page?: any }): Promise<{ answer: string | null; source?: string; answer_id?: number | null; [key: string]: unknown }> {
    return this.request("/api/extension/answers/suggest", { method: "POST", body: JSON.stringify(body) });
  }

  /** Search the user's full active Answer Bank (for answers beyond the inline top-K). */
  async searchAnswers(query: string, limit: number = 5): Promise<any[]> {
    try {
      const res = await this.request("/api/extension/answers/search", {
        method: "POST",
        body: JSON.stringify({ query: String(query ?? "").slice(0, 500), limit }),
      });
      return Array.isArray(res) ? res : [];
    } catch (err) {
      if (err instanceof BridgeError && (err.status === 404 || err.status === 405)) return [];
      return [];
    }
  }

  assistFill(body: any): Promise<any> {
    return this.request("/api/extension/assistant/fill", { method: "POST", body: JSON.stringify(body) });
  }

  /** One round trip: vetted actions, or want_screenshot with optional annotate_screenshot. */
  agentCapabilities(custom: boolean = false, engine: string = "ai_led"): Promise<any> {
    const query = new URLSearchParams({ extension_engine: engine, ...(custom ? { planner: "custom" } : {}) });
    return this.request(`/api/extension/agent/capabilities?${query}`);
  }

  agentModel(body: any): Promise<any> {
    return this.request("/api/extension/agent/model", { method: "POST", body: JSON.stringify(body), timeout: AGENT_TIMEOUT_MS });
  }

  diagnostic(body: any): Promise<any> {
    return this.request("/api/extension/agent/diagnostic", { method: "POST", body: JSON.stringify(body) });
  }

  async agentStep(body: any): Promise<any> {
    const version = globalThis.chrome?.runtime?.getManifest?.().version;
    const observation = body?.observation && "diagnostics" in body.observation
      ? (({ diagnostics: _diag, ...rest }) => rest)(body.observation)
      : body?.observation;
    body = { ...body, ...(observation !== undefined ? { observation } : {}), runtime_version: version };
    void flushDiagnostics(this);
    const send = (b: any) => this.request("/api/extension/agent/step", { method: "POST", body: JSON.stringify(b), timeout: AGENT_TIMEOUT_MS });
    try {
      try {
        return await send(body);
      } catch (error: any) {
        // An older platform rejects the newer `runtime_version` field (extra="forbid"): retry once
        // without it so version skew never blocks a run.
        if (error.status !== 422 || !/runtime_version/.test(error.message)) throw error;
        const { runtime_version: _skipped, ...legacy } = body;
        body = legacy;
        return await send(body);
      }
    } catch (error: any) {
      // Record operational errors and request rejections (4xx other than auth) so the admin
      // failure list shows them. Successful turns are captured on the server.
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
              data: { code, http_status: error.status || 0, message: String(error.message || "").slice(0, 500) },
            },
          ],
        });
      }
      throw error;
    }
  }

  async report(event: ExtensionEvent): Promise<ExtensionEventResult> {
    const send = (b: any) => this.request<ExtensionEventResult>("/api/extension/events", { method: "POST", body: JSON.stringify(b) });
    try {
      return await send(event);
    } catch (error: any) {
      if (error.status !== 422 || !/save_answers/.test(error.message) || !("save_answers" in (event as any))) throw error;
      const { save_answers: _skipped, ...legacy } = event as any;
      return await send(legacy);
    }
  }
}
