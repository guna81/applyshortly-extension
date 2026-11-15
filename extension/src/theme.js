// Applies Settings > Appearance (match browser, light or dark) to the extension's own pages.
// Without a choice, no attribute is set and the browser's colour scheme applies (see ui.css).
(() => {
  const apply = (value) => {
    if (value === "light" || value === "dark") document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  };
  try {
    void chrome.storage.local.get("theme").then((stored) => apply(stored.theme)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.theme) apply(changes.theme.newValue); });
  } catch { /* no storage: the browser's colour scheme applies */ }
})();
