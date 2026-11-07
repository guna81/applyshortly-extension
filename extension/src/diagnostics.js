// Background-only bounded offline diagnostics. Never persist credentials or observation values.
const KEY = "browserDiagnosticQueue";
const DAY = 24 * 60 * 60 * 1000;
let pending = Promise.resolve();

async function identity(bridge) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${bridge.baseUrl}:${bridge.token}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clearDiagnosticQueue() {
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.remove(KEY);
}

export function queueDiagnostic(bridge, batch) {
  pending = pending.then(async () => {
    if (!globalThis.chrome?.storage?.local || !globalThis.crypto?.subtle) return;
    const owner = await identity(bridge);
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    const items = saved?.owner === owner ? saved.items.filter((r) => Date.now() - r.at < DAY) : [];
    items.push({ at: Date.now(), batch });
    while (JSON.stringify(items).length > 10_000_000 && items.length) items.shift();
    await chrome.storage.local.set({ [KEY]: { owner, items } });
  }).catch(() => {});
  return pending;
}

export function flushDiagnostics(bridge) {
  pending = pending.then(async () => {
    if (!globalThis.chrome?.storage?.local || !globalThis.crypto?.subtle) return;
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    if (!saved) return;
    if (saved.owner !== await identity(bridge)) { await clearDiagnosticQueue(); return; }
    const items = saved.items.filter((r) => Date.now() - r.at < DAY);
    while (items.length) {
      try { await bridge.diagnostic(items[0].batch); }
      catch (error) {
        if (error.status === 401 || error.status === 403) { await clearDiagnosticQueue(); return; }
        if (!error.status || error.status >= 500) break;
      }
      items.shift();
    }
    await chrome.storage.local.set({ [KEY]: { owner: saved.owner, items } });
  }).catch(() => {});
  return pending;
}
