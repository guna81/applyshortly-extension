(() => {
  const apply = (value) => {
    if (value === "light" || value === "dark") document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  };
  try {
    void chrome.storage.local.get("theme").then((stored) => apply(stored.theme)).catch(() => {
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.theme) apply(changes.theme.newValue);
    });
  } catch {
  }
})();
