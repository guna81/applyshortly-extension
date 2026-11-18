// User-facing connection and queue states. No permissions or lifecycle changes here.

export interface ExternalBrowserData {
  connected: boolean;
  wanted?: boolean;
  paused?: boolean;
  pendingReview?: boolean;
  pendingNavigation?: boolean;
  batches?: BatchInfo[];
}

export interface BatchInfo {
  state: string;
  policy?: {
    approved_at?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StateLabel {
  label: string;
  hint: string;
}

export function connectionState(data: ExternalBrowserData): StateLabel {
  if (!data.connected)
    return data.wanted
      ? {
          label: "Connection lost",
          hint: "Reconnecting automatically. Choose Reconnect to try now, or Stop access to disconnect.",
        }
      : { label: "Not connected", hint: "Connect this browser to let your assistant request applications." };
  if (data.paused)
    return { label: "Paused by you", hint: "Edit the form freely. Choose Continue when you are ready." };
  if (data.pendingReview)
    return { label: "Review answers", hint: "Review the new answers below before your assistant can submit." };
  if (data.pendingNavigation)
    return { label: "Site approval needed", hint: "Review the new application site below." };
  const queues = data.batches ?? [];
  if (queues.some((b) => b.state === "needs_verification"))
    return {
      label: "Submission needs verification",
      hint: "Check the employer’s confirmation and resolve the attempt in ApplyShortly before continuing. Do not retry submission.",
    };
  if (
    queues.some(
      (b) =>
        b.state === "expired" ||
        (["active", "paused"].includes(b.state) &&
          b.policy?.approved_at &&
          Date.now() / 1000 - b.policy.approved_at >= 7200),
    )
  )
    return {
      label: "Session expired",
      hint: "Ask your assistant to start a new application queue, then review and approve it here.",
    };
  if (queues.some((b) => b.state === "pending"))
    return { label: "Approval needed", hint: "Review the selected applications below." };
  if (queues.some((b) => b.state === "paused"))
    return {
      label: "Queue paused",
      hint: "Ask your assistant to resume the application queue. If approval has expired, ask it to start a new queue.",
    };
  if (queues.some((b) => b.state === "active"))
    return {
      label: "Connected",
      hint: "Your assistant can continue the approved applications. Pause from the application panel to edit the form yourself.",
    };
  return { label: "Connected", hint: "Waiting for your assistant. Ask it to choose applications to fill." };
}

export function queueStatus(batch: { state: string }): string {
  const map: Record<string, string> = {
    pending: "Waiting for your approval",
    active: "In progress",
    paused: "Paused — ask your assistant to resume",
    needs_verification: "Submission needs verification",
    expired: "Session expired — ask your assistant to start again",
    complete: "Application queue finished — submissions confirmed",
    cancelled: "Stopped",
  };
  return map[batch.state] ?? "Status unavailable";
}

/** Use the product host for hosted accounts, keeping development/custom origins intact. */
export function connectorUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (["applyshortly.com", "www.applyshortly.com"].includes(url.hostname)) {
    url.hostname = "app.applyshortly.com";
    url.protocol = "https:";
    url.port = "";
  }
  return `${url.origin}/api/mcp`;
}
