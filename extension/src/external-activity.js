// Shared by the popup and the control page: a readable timeline of what the connected
// assistant is doing. Entries carry only step names (never typed values or page text).
const ICON = { running: "", done: "✓", error: "✕", warn: "!" };

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** @param {{id: string, at: number, text: string, state: string}[]} entries oldest first */
export function activityList(entries, limit = 8) {
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

/** What needs the user right now, for a badge. */
export function attention(data) {
  return Boolean(data?.pendingNavigation || data?.pendingReview || data?.batches?.some((b) => b.state === "pending"));
}
