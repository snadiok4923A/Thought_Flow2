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

  // The server mounts every route under /api. A stored base that points at the
  // Vite dev frontend (port 5173) or lacks the /api prefix can never work —
  // repair it once and persist so the popup shows the real backend URL.
  function normalizeApiBase(raw) {
    const cleaned = String(raw || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(cleaned)) return DEFAULTS.apiBase;
    let url;
    try {
      url = new URL(cleaned);
    } catch {
      return DEFAULTS.apiBase;
    }
    // 5173 is the Vite dev server — the API lives elsewhere, use the default.
    if (url.port === "5173") return DEFAULTS.apiBase;
    // Keep host:port (user may run the backend on another port), fix the path.
    if (!url.pathname.replace(/\/+$/, "").endsWith("/api")) {
      return `${url.origin}/api`;
    }
    return cleaned;
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, async (items) => {
        const settings = { ...DEFAULTS, ...items };
        const fixed = normalizeApiBase(settings.apiBase);
        if (fixed !== settings.apiBase) {
          settings.apiBase = fixed;
          await setSettings({ apiBase: fixed });
          if (globalThis.TFDebug && globalThis.TFDebug.log) {
            globalThis.TFDebug.log("settings", "api base URL corrected to " + fixed);
          }
        }
        resolve(settings);
      });
    });
  }

  function setSettings(patch) {
    return new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
  }

  async function request(path, { method = "GET", body } = {}) {
    const settings = await getSettings();
    const url = settings.apiBase.replace(/\/$/, "") + path;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Capture-Token": settings.token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Connection refused / DNS — attach the URL so diagnostics can show it.
      const err = new Error(`unreachable ${url}`);
      err.status = undefined;
      err.url = url;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    // A 200 from the wrong server (e.g. Vite's HTML fallback) must fail loudly
    // with the URL attached, not as a bare SyntaxError with no context.
    let data;
    try {
      data = await res.json();
    } catch {
      const err = new Error(`response from ${url} is not JSON`);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    if (!data || typeof data !== "object") {
      const err = new Error(`unexpected response from ${url}`);
      err.status = res.status;
      err.url = url;
      throw err;
    }
    return data;
  }

  globalThis.TFApi = {
    DEFAULTS,
    getSettings,
    setSettings,
    normalizeApiBase,
    health: () => request("/health"),
    postCapture: (payload) => request("/ai-capture", { method: "POST", body: payload }),
    getSession: () => request("/ai-capture/session"),
    putSession: (patch) => request("/ai-capture/session", { method: "PUT", body: patch }),
    getStats: () => request("/ai-capture/stats"),
  };
})();
