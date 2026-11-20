// ThoughtFlow AI Capture — popup logic.
// Two switches gate capture: this popup (extension) + the website panel (ThoughtFlow).
// Direction here writes to the shared backend session, so future nodes use it.

const $ = (id) => document.getElementById(id);

let settings = null;
let session = null;

// Developer-only UI: preserve Diagnostics and Settings without showing them
// in the everyday popup. Shift-click the header logo or press Alt+Shift+D
// while the extension popup has focus; both also toggle the tools back off.
function setDeveloperToolsVisible(visible) {
  const tools = $("developerTools");
  tools.hidden = !visible;
  if (!visible) {
    $("diagnostics").open = false;
    $("advanced").open = false;
  }
}

$("developerLogo").addEventListener("click", (event) => {
  if (event.shiftKey) {
    setDeveloperToolsVisible($("developerTools").hidden);
  }
});

$("closeDeveloperTools").addEventListener("click", () => {
  setDeveloperToolsVisible(false);
});

document.addEventListener("keydown", (event) => {
  if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    setDeveloperToolsVisible($("developerTools").hidden);
  }
});

function setStatus(text) {
  $("statusLine").textContent = text;
}

// Known AI chat hosts → display name. Hosts here run the generic capture
// engine (content/selectors-generic.js); ChatGPT and Gemini have dedicated ones.
const KNOWN_PLATFORMS = [
  [/https:\/\/(chatgpt\.com|chat\.openai\.com)\//, "ChatGPT"],
  [/https:\/\/gemini\.google\.com\//, "Gemini"],
  [/https:\/\/(www\.|lmarena\.|chat\.lmsys\.org)?arena\.ai\//, "Arena"],
  [/https:\/\/grok\.com\//, "Grok"],
  [/https:\/\/grok\.x\.ai\//, "Grok"],
  [/https:\/\/x\.ai\//, "Grok"],
  [/https:\/\/claude\.ai\//, "Claude"],
  [/https:\/\/(chat\.)?deepseek\.com\//, "DeepSeek"],
  [/https:\/\/(www\.)?perplexity\.ai\//, "Perplexity"],
  [/https:\/\/copilot\.microsoft\.com\//, "Copilot"],
  [/https:\/\/(www\.)?poe\.com\//, "Poe"],
  [/https:\/\/(chat\.)?you\.com\//, "You.com"],
  [/https:\/\/duck\.ai\//, "DuckDuckGo"],
  [/https:\/\/(www\.)?meta\.ai\//, "Meta AI"],
  [/https:\/\/chat\.mistral\.ai\//, "Mistral"],
  [/https:\/\/chat\.qwen\.ai\//, "Qwen"],
  [/https:\/\/(www\.)?kimi\.com\//, "Kimi"],
  [/https:\/\/felo\.ai\//, "Felo"],
  [/https:\/\/chat\.z\.ai\//, "GLM (Z.ai)"],
  [/https:\/\/chat\.minimax\.io\//, "MiniMax"],
];

async function detectPlatform() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  let name = "Unsupported page";
  let on = false;
  for (const [re, label] of KNOWN_PLATFORMS) {
    if (re.test(url)) {
      name = label;
      on = true;
      break;
    }
  }
  $("platformName").textContent = name;
  $("platformDot").className = "dot " + (on ? "on" : "off");
  if (!on) setStatus("Open an AI chat (ChatGPT, Gemini, Arena…) to capture, or use Quick add.");
}

async function refreshHealth() {
  try {
    const h = await chrome.runtime.sendMessage({ type: "TF_HEALTH" });
    const connected = !!(h && h.connected);
    $("connDot").className = "dot " + (connected ? "on" : "off");
    $("connText").textContent = connected
      ? `Connected (${h.storage || "?"})`
      : h && h.reason ? `Bridge blocked: ${h.reason}` : "Offline";
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
  // Read settings through THIS popup's freshly loaded api.js (not the service
  // worker) so a wrong stored API base is repaired to the real backend before
  // the first health check runs — even if background.js is still stale.
  try {
    settings = await TFApi.getSettings();
  } catch {
    settings = { ...TFApi.DEFAULTS };
  }
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
  // Direct mode first: set it on the open ThoughtFlow tab.
  try {
    const r = await chrome.runtime.sendMessage({
      type: "TF_SET_DIRECTION_DIRECT",
      direction,
    });
    if (r && r.ok) {
      setStatus(`Direction set to ${direction}. Future nodes only.`);
      return;
    }
  } catch {
    /* fall through to legacy server session */
  }
  try {
    session = await chrome.runtime.sendMessage({
      type: "TF_PUT_SESSION",
      patch: { direction },
    });
    setStatus(`Direction set to ${direction}. Future nodes only.`);
  } catch {
    setStatus("Could not save direction (open ThoughtFlow or start the server).");
  }
});

$("saveAdvanced").addEventListener("click", async () => {
  // Never persist a base that can't reach the API (e.g. the Vite frontend URL).
  const rawBase = $("apiBase").value.trim() || TFApi.DEFAULTS.apiBase;
  const apiBase = TFApi.normalizeApiBase(rawBase);
  const patch = {
    apiBase,
    token: $("token").value.trim(),
    stabilityMs: Math.max(500, Math.min(15000, parseInt($("stabilityMs").value, 10) || 2000)),
  };
  settings = await chrome.runtime.sendMessage({ type: "TF_SET_SETTINGS", patch });
  $("apiBase").value = apiBase;
  setStatus(apiBase !== rawBase ? `API base corrected to ${apiBase}.` : "Settings saved.");
  await Promise.all([refreshHealth(), refreshStats()]);
});

function renderEvents(events) {
  const box = $("diagLog");
  if (!events || !events.length) {
    box.textContent = "No events yet. Interact with an AI chat, then re-run.";
    return;
  }
  box.innerHTML = events
    .slice(0, 15)
    .map((e) => {
      const t = new Date(e.t).toLocaleTimeString();
      const line = `${t}  ${e.e}${e.d ? " — " + e.d : ""}`;
      return `<div>${line.replace(/</g, "&lt;")}</div>`;
    })
    .join("");
}

async function runDiagnostics() {
  const pipe = $("diagPipeline");
  pipe.textContent = "Testing pipeline…";
  pipe.className = "diag-pipeline pending";
  try {
    const d = await chrome.runtime.sendMessage({ type: "TF_DIAGNOSE" });
    if (!d) throw new Error("no response");
    const parts = [];
    // Direct mode: ThoughtFlow tab open? (server API is legacy fallback)
    if (d.bridge && !d.bridge.ok && d.bridge.reason !== "no ThoughtFlow tab") {
      parts.push(`Bridge ✗ (${d.bridge.reason})`);
    }
    if (d.panel) {
      parts.push("Tab ✓ (direct)");
    } else if (d.api && d.api.ok) {
      parts.push(`API ✓ (${d.api.storage || "ok"})`);
    } else {
      parts.push("Tab ✗ (open ThoughtFlow)");
    }
    parts.push(d.settings.captureEnabled ? "Popup ✓" : "Popup OFF");
    const panelOn = d.panel ? d.panel.enabled : d.session && d.session.enabled;
    parts.push(panelOn ? "Panel ✓" : "Panel OFF");
    const hasStart = d.panel
      ? d.panel.hasStartNode
      : d.session && (d.session.rootNodeId || d.session.currentParentNodeId);
    parts.push(hasStart ? "Start node ✓" : "Start node ✗");
    if (d.queue > 0) parts.push(`queued: ${d.queue}`);
    pipe.textContent = (d.gate === "OK" ? "PIPELINE OK — " : `BLOCKED: ${d.gate} — `) + parts.join(" · ");
    pipe.className = "diag-pipeline " + (d.gate === "OK" ? "ok" : "bad");
    renderEvents(d.events);
  } catch (err) {
    pipe.textContent = "Diagnostics failed: " + (err && err.message);
    pipe.className = "diag-pipeline bad";
  }
}

$("runDiag").addEventListener("click", runDiagnostics);

// ---- Quick add: works on any AI site (even ones the content script can't read) ----
$("quickAddBtn").addEventListener("click", async () => {
  const question = $("qaQuestion").value.trim();
  const answer = $("qaAnswer").value.trim();
  const status = $("quickAddStatus");
  if (!question || !answer) {
    status.textContent = "Both the question and the answer are required.";
    return;
  }
  status.textContent = "Sending directly to ThoughtFlow…";
  try {
    const res = await chrome.runtime.sendMessage({
      type: "TF_TRY_SEND",
      payload: { source: "manual", conversationId: "", question, answer },
    });
    if (!res || res.drop || (!res.accepted && !res.duplicate)) {
      const reason = res && res.reason ? res.reason : "no response";
      status.textContent = "Could not add (" + reason + "). Open ThoughtFlow, select a node and turn capture ON.";
      return;
    }
    status.textContent = res.duplicate ? "Already captured (duplicate)." : "Node added to ThoughtFlow.";
    if (!res.duplicate) {
      $("qaQuestion").value = "";
      $("qaAnswer").value = "";
    }
    await refreshStats();
  } catch (err) {
    status.textContent = "Direct capture failed: " + ((err && err.message) || "extension unavailable");
  }
});

// Show the latest persisted events as soon as the popup opens.
chrome.storage.local.get({ tfDebugLog: [] }, (r) => renderEvents(r.tfDebugLog.slice(-15).reverse()));

init();
