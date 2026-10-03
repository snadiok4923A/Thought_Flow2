// ThoughtFlow AI Capture — popup logic.
// Two switches gate capture: this popup (extension) + the website panel (ThoughtFlow).
// Direction here writes to the shared backend session, so future nodes use it.

const $ = (id) => document.getElementById(id);

let settings = null;
let session = null;

function setStatus(text) {
  $("statusLine").textContent = text;
}

async function detectPlatform() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  let name = "Unsupported page";
  let on = false;
  if (/https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) {
    name = "ChatGPT";
    on = true;
  } else if (/https:\/\/gemini\.google\.com\//.test(url)) {
    name = "Gemini";
    on = true;
  }
  $("platformName").textContent = name;
  $("platformDot").className = "dot " + (on ? "on" : "off");
  if (!on) setStatus("Open ChatGPT or Gemini to capture.");
}

async function refreshHealth() {
  try {
    const h = await chrome.runtime.sendMessage({ type: "TF_HEALTH" });
    const connected = !!(h && h.connected);
    $("connDot").className = "dot " + (connected ? "on" : "off");
    $("connText").textContent = connected
      ? `Connected (${h.storage || "?"})`
      : "Offline";
    return connected;
  } catch {
    $("connDot").className = "dot off";
    $("connText").textContent = "Offline";
    return false;
  }
}

async function refreshStats() {
  try {
    const s = await chrome.runtime.sendMessage({ type: "TF_STATS" });
    $("capturedCount").textContent =
      s && typeof s.captured === "number" ? `${s.captured} conversations` : "–";
  } catch {
    $("capturedCount").textContent = "–";
  }
}

async function loadSession() {
  try {
    session = await chrome.runtime.sendMessage({ type: "TF_GET_SESSION" });
    if (session && session.direction) $("direction").value = session.direction;
  } catch {
    /* server offline */
  }
}

function renderToggle() {
  const on = !!settings.captureEnabled;
  const btn = $("captureToggle");
  btn.setAttribute("aria-checked", on ? "true" : "false");
  btn.querySelector(".state-text").textContent = on ? "ON" : "OFF";
}

async function init() {
  settings = await chrome.runtime.sendMessage({ type: "TF_GET_SETTINGS" });
  if (!settings) settings = { ...TFApi.DEFAULTS };
  renderToggle();

  $("apiBase").value = settings.apiBase || "";
  $("token").value = settings.token || "";
  $("stabilityMs").value = settings.stabilityMs || 2000;

  await Promise.all([detectPlatform(), refreshHealth(), refreshStats(), loadSession()]);
}

// ---- events ----------------------------------------------------------------

$("captureToggle").addEventListener("click", async () => {
  settings = await chrome.runtime.sendMessage({
    type: "TF_SET_SETTINGS",
    patch: { captureEnabled: !settings.captureEnabled },
  });
  renderToggle();
  setStatus(
    settings.captureEnabled
      ? "Extension capture ON (website panel must also be ON)."
      : "Extension capture OFF."
  );
});

$("direction").addEventListener("change", async (e) => {
  const direction = e.target.value;
  try {
    session = await chrome.runtime.sendMessage({
      type: "TF_PUT_SESSION",
      patch: { direction },
    });
    setStatus(`Direction set to ${direction}. Future nodes only.`);
  } catch {
    setStatus("Could not save direction (server offline).");
  }
});

$("saveAdvanced").addEventListener("click", async () => {
  const patch = {
    apiBase: $("apiBase").value.trim() || TFApi.DEFAULTS.apiBase,
    token: $("token").value.trim(),
    stabilityMs: Math.max(500, Math.min(15000, parseInt($("stabilityMs").value, 10) || 2000)),
  };
  settings = await chrome.runtime.sendMessage({ type: "TF_SET_SETTINGS", patch });
  setStatus("Settings saved.");
  await Promise.all([refreshHealth(), refreshStats()]);
});

init();
