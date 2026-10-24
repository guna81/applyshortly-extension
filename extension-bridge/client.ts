export interface ExtensionAccount {
  email: string;
  name: string | null;
  credits: number;
  plan: "free" | "pro" | "premium";
  billing_enabled: boolean;
  ai: { mode: "platform" | "personal"; provider: "gemini" | "anthropic" | "openai" | null; configured: { provider: "gemini" | "anthropic" | "openai"; model: string }[] };
}

// Typed client for the Job Hunt extension bridge (/api/extension/*).
// Mirrors extension-bridge/openapi.json; keep the two in sync (CI checks the spec, tsc checks this).
// Call it from the extension's background service worker: with host_permissions for the
// platform origin, requests there are not subject to the job page's CORS rules.

export interface Link {
  label: string;
  url: string;
}

export interface ExtensionAnswer {
  question_pattern: string;
  answer: string;
  tags: string[];
}

export interface ExtensionPreferences {
  notice_period_days: number | null;
  current_ctc: string | null; // decimals arrive as strings
  expected_ctc: string | null;
  currency: string | null;
  available_from: string | null; // YYYY-MM-DD
  willing_to_relocate: boolean;
  requires_sponsorship: boolean | null; // null: not answered yet
  work_authorization: Record<string, string>;
}

export interface ExtensionProfile {
  full_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  links: Link[];
  summary: string | null;
  total_experience_years: number | null;
  skills: string[];
  experience: Record<string, unknown>[];
  education: Record<string, unknown>[];
  preferences: ExtensionPreferences | null;
  answers: ExtensionAnswer[];
  resume_url: string | null; // relative to the platform origin; needs the same API key
}

export interface ExtensionApplication {
  id: number;
  company_name: string | null;
  title: string | null;
  status: string;
  apply_url: string | null;
  tailored_summary: string | null;
  cover_letter: string | null;
}

export interface FieldReport {
  label: string;
  value?: string;
  reason?: string;
  [key: string]: unknown;
}

export type ExtensionEventKind = "opened" | "filled" | "submission_attempted" | "submitted" | "failed";

export interface ExtensionEvent {
  application_id: number;
  event: ExtensionEventKind;
  url?: string | null;
  filled_fields?: FieldReport[];
  unresolved_fields?: FieldReport[];
  note?: string | null;
  /** With "failed": why it stopped (the platform's FailureCode, e.g. "agent_stuck"). */
  failure_code?: string | null;
}

export interface ExtensionEventResult {
  application_id: number;
  status: string;
}

export interface AnswerSuggestRequest {
  question: string;
  application_id?: number | null;
  /** false = profile facts and answer bank only (no LLM cost). */
  allow_generate?: boolean;
  /** The job as the page shows it; used for drafts only when there is no application_id. */
  page?: PageJob | null;
}

export interface PageJob {
  title?: string;
  company?: string;
  /** Visible page text, at most 6000 characters. */
  description?: string;
}

export interface AnswerSuggestion {
  answer: string | null;
  source: "profile" | "answer_bank" | "generated" | "none";
  needs_review: boolean;
  answer_id?: number | null;
  similarity?: number | null;
  matched_question?: string | null;
}

export interface AssistMessage {
  role: "user" | "assistant";
  text: string;
}

/** A question on the page, as the panel's Assistant tab describes it. */
export interface AssistFormField {
  key: string;
  label: string;
  kind: string;
  options?: string[];
  required?: boolean;
}

export interface AssistRequest {
  messages: AssistMessage[];
  fields: AssistFormField[];
  /** Field key → the value currently on the page. */
  current?: Record<string, string>;
}

export interface AssistResponse {
  reply: string;
  /** Field key → value to write into the page; option fields use one of their options. */
  updates: Record<string, string>;
  warnings: string[];
  done: boolean;
  choices: string[];
}

/** One interactive element of the page, as the form agent observed it. */
export interface AgentElement {
  /** The driver's handle, valid only within the observation that carried it. */
  ref: string;
  role: string;
  name?: string;
  input_type?: string | null;
  value?: string | null;
  checked?: boolean | null;
  required?: boolean;
  invalid?: boolean;
  error?: string | null;
  options?: string[];
  group?: string | null;
  disabled?: boolean;
  in_viewport?: boolean;
  submit_like?: boolean;
}

export interface AgentObservation {
  url: string;
  title?: string;
  dialog?: string | null;
  blockers?: ("captcha" | "login")[];
  errors?: string[];
  text?: string;
  elements?: AgentElement[];
  more_below?: boolean;
  /** Base64 JPEG, only when the previous response asked for one. */
  screenshot?: string | null;
}

export interface AgentActionResult {
  index: number;
  ok: boolean;
  detail?: string | null;
}

export interface AgentStepRequest {
  session_id?: string | null;
  application_id?: number | null;
  observation: AgentObservation;
  results?: AgentActionResult[];
  user_reply?: string | null;
  skip_question?: boolean;
  resumed?: boolean;
  in_user_tab?: boolean;
}

/** A vetted step. There is no submit action: the user always sends the form. */
export interface AgentAction {
  type: "click" | "type" | "select" | "check" | "upload" | "press" | "scroll" | "wait";
  ref?: string | null;
  text?: string | null;
  checked?: boolean | null;
  file?: "resume" | "cover_letter" | null;
  key?: "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp" | "Space" | null;
  direction?: "up" | "down" | null;
  ms?: number | null;
  label?: string;
}

export interface AgentStepResponse {
  session_id: string;
  status: "continue" | "ask_user" | "ready_for_review" | "failed";
  actions: AgentAction[];
  message: string;
  question: { kind: "blocker" | "question" | "click"; text: string; ref?: string | null } | null;
  want_screenshot: boolean;
  filled: { label: string; value: string; source: string; needs_review: boolean }[];
  unresolved: string[];
  failure_code: string | null;
  step: number;
}

/** Fragment the platform's "Open & Autofill" button appends to the posting URL. */
export const AUTOFILL_FRAGMENT = "jobhunt-autofill";

export function autofillIdFromUrl(url: string): number | null {
  const match = new URL(url).hash.match(new RegExp(`${AUTOFILL_FRAGMENT}=(\\d+)`));
  return match?.[1] ? Number(match[1]) : null;
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class JobHuntBridge {
  constructor(
    private readonly baseUrl: string, // e.g. "http://localhost:3000"
    private readonly token: string, // the user's API key (Settings → API keys), "jh_…"
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
      throw new BridgeError(res.status, typeof body.detail === "string" ? body.detail : res.statusText);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  account(): Promise<ExtensionAccount> { return this.request("/api/extension/account"); }

  aiSettings(): Promise<ExtensionAccount["ai"]> { return this.request("/api/extension/ai"); }

  selectAI(body: { mode: "platform" | "personal"; provider?: "openai" | "anthropic" | "gemini" }): Promise<ExtensionAccount["ai"]> {
    return this.request("/api/extension/ai", { method: "PUT", body: JSON.stringify(body) });
  }

  saveAIProvider(provider: "openai" | "anthropic" | "gemini", body: { api_key: string; model: string }): Promise<ExtensionAccount["ai"]> {
    return this.request(`/api/extension/ai/providers/${encodeURIComponent(provider)}`, { method: "PUT", body: JSON.stringify(body) });
  }

  deleteAIProvider(provider: "openai" | "anthropic" | "gemini"): Promise<ExtensionAccount["ai"]> {
    return this.request(`/api/extension/ai/providers/${encodeURIComponent(provider)}`, { method: "DELETE" });
  }

  websiteTicket(): Promise<{ ticket: string }> { return this.request("/api/extension-auth/website-ticket", { method: "POST" }); }

  disconnect(): Promise<void> { return this.request("/api/extension/disconnect", { method: "POST" }); }

  profile(): Promise<ExtensionProfile> {
    return this.request("/api/extension/profile");
  }

  async resume(): Promise<Blob> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/extension/resume`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new BridgeError(res.status, "No resume uploaded");
    return res.blob();
  }

  application(id: number): Promise<ExtensionApplication> {
    return this.request(`/api/extension/applications/${id}`);
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

  suggestAnswer(body: AnswerSuggestRequest): Promise<AnswerSuggestion> {
    return this.request("/api/extension/answers/suggest", { method: "POST", body: JSON.stringify(body) });
  }

  assistFill(body: AssistRequest): Promise<AssistResponse> {
    return this.request("/api/extension/assistant/fill", { method: "POST", body: JSON.stringify(body) });
  }

  /** One round trip of the form agent: the page as observed → the next vetted actions. */
  agentStep(body: AgentStepRequest): Promise<AgentStepResponse> {
    return this.request("/api/extension/agent/step", { method: "POST", body: JSON.stringify(body) });
  }

  report(event: ExtensionEvent): Promise<ExtensionEventResult> {
    return this.request("/api/extension/events", { method: "POST", body: JSON.stringify(event) });
  }
}
