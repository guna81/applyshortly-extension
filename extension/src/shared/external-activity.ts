// Shared by the on-page panel and the control page: a readable timeline of what the connected
// assistant is doing. Entries carry only step names (never typed values or page text).

export interface ActivityEntry {
  id: string;
  at: number;
  text: string;
  state: "running" | "done" | "error" | "warn" | string;
}

const ICON: Record<string, string> = { running: "", done: "✓", error: "✕", warn: "!" };

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** @param entries oldest first */
export function activityList(entries: ActivityEntry[], limit: number = 8): HTMLElement {
  const list = document.createElement("ol");
  list.className = "steps";
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "step empty";
    empty.textContent = "No activity yet. Ask your assistant to choose applications to fill.";
    list.append(empty);
    return list;
  }
  for (const entry of entries.slice(-limit).reverse()) {
    const item = document.createElement("li");
    item.className = `step ${entry.state}`;
    const icon = document.createElement("span");
    icon.className = entry.state === "running" ? "spin" : "icon";
    icon.textContent = ICON[entry.state] ?? "";
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = entry.text;
    const time = document.createElement("time");
    time.textContent = clock(entry.at);
    item.append(icon, text, time);
    list.append(item);
  }
  return list;
}

export interface AttentionData {
  pendingNavigation?: unknown;
  pendingReview?: unknown;
  batches?: Array<{ state: string }>;
}

/** What needs the user right now, for a badge. */
export function attention(data?: AttentionData | null): boolean {
  return Boolean(
    data?.pendingNavigation ||
      data?.pendingReview ||
      data?.batches?.some((b) => b.state === "pending"),
  );
}
