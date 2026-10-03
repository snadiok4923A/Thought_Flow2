// Shared API helper for the ThoughtFlow AI Capture extension.
// Loaded by background.js (importScripts) and popup.html (<script>).
// Classic script — exposes globalThis.TFApi.

(function () {
  const DEFAULTS = {
    captureEnabled: true, // extension-level switch (website panel is the second switch)
    direction: "right", // 'right' | 'below' — synced with the website session
    apiBase: "http://localhost:5001/api",
    token: "tf-local-capture-token",
    stabilityMs: 2000, // answer must be unchanged for this long before capture
  };

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (items) => resolve({ ...DEFAULTS, ...items }));
    });
  }

  function setSettings(patch) {
    return new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
  }

  async function request(path, { method = "GET", body } = {}) {
    const settings = await getSettings();
    const url = settings.apiBase.replace(/\/$/, "") + path;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Capture-Token": settings.token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  globalThis.TFApi = {
    DEFAULTS,
    getSettings,
    setSettings,
    health: () => request("/health"),
    postCapture: (payload) => request("/ai-capture", { method: "POST", body: payload }),
    getSession: () => request("/ai-capture/session"),
    putSession: (patch) => request("/ai-capture/session", { method: "PUT", body: patch }),
    getStats: () => request("/ai-capture/stats"),
  };
})();
