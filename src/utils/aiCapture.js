// AI Chat Capture — helpers for talking to the capture backend and for
// formatting captured conversations into the existing note (HTML) format.

// Hosted deployments can bake the API location in at build time (Vite exposes
// only VITE_* vars), or change it at runtime via the panel's ⚙ Settings —
// whichever is convenient, no code edit required.
const ENV_API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_CAPTURE_API_BASE) || "";
const ENV_TOKEN =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_CAPTURE_TOKEN) || "";
const DEFAULT_API_BASE = ENV_API_BASE || "http://localhost:5001/api";
const DEFAULT_TOKEN = ENV_TOKEN || "tf-local-capture-token";
const CFG_KEY = "thoughtflow-ai-capture-cfg";
const APPLIED_KEY = "thoughtflow-ai-applied";
const APPLIED_CAP = 400;

export function getCaptureConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { apiBase: DEFAULT_API_BASE, token: DEFAULT_TOKEN, ...JSON.parse(raw) };
  } catch {
    /* corrupted config → defaults */
  }
  return { apiBase: DEFAULT_API_BASE, token: DEFAULT_TOKEN };
}

export function saveCaptureConfig(patch) {
  const next = { ...getCaptureConfig(), ...patch };
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

async function api(path, { method = "GET", body, cfg } = {}) {
  const config = cfg || getCaptureConfig();
  const res = await fetch(config.apiBase.replace(/\/$/, "") + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Capture-Token": config.token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`capture api ${method} ${path} → HTTP ${res.status}`);
  return res.json();
}

export const fetchCaptureSync = (cfg) => api("/ai-capture/sync", { cfg });
export const putCaptureSession = (patch, cfg) =>
  api("/ai-capture/session", { method: "PUT", body: patch, cfg });
export const ackCaptureItem = (id, nodeId, cfg) =>
  api(`/ai-capture/${encodeURIComponent(id)}/ack`, { method: "POST", body: { nodeId }, cfg });

// ---- Formatting ------------------------------------------------------------

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textToHtml(s) {
  return escapeHtml(s).replace(/\r\n?|\n/g, "<br>");
}

const SOURCE_LABELS = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  arena: "Arena",
  lmsys: "Arena",
  grok: "Grok",
  claude: "Claude",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  copilot: "Copilot",
  qwen: "Qwen",
  kimi: "Kimi",
  poe: "Poe",
  you: "You.com",
  duckduckgo: "DuckDuckGo",
  meta: "Meta AI",
  mistral: "Mistral",
  felo: "Felo",
  z: "GLM (Z.ai)",
  minimax: "MiniMax",
  manual: "Manual",
  generic: "AI Chat",
};

// Human label for any backend source tag — known sites get their brand name,
// unknown future sites get a prettified fallback (no frontend release needed).
export function sourceLabel(source) {
  const s = String(source || "").toLowerCase().trim();
  if (SOURCE_LABELS[s]) return SOURCE_LABELS[s];
  if (!s) return "AI Chat";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Exact conversation text, preserved verbatim (no summarizing/rewriting):
//
//   User:
//   <question>
//
//   ChatGPT:
//   <answer>
export function buildCaptureNoteHtml({ source, question, answer }) {
  const label = sourceLabel(source);
  return (
    `<p><strong>User:</strong></p><p>${textToHtml(question)}</p>` +
    `<p><strong>${label}:</strong></p><p>${textToHtml(answer)}</p>`
  );
}

const TITLE_MAX = 80;

// Node title = the user's question. Very long questions are shortened for the
// node chip; the full exact question always stays inside the note.
export function shortenQuestionTitle(question) {
  const q = String(question || "").replace(/\s+/g, " ").trim();
  if (q.length <= TITLE_MAX) return q;
  return q.slice(0, TITLE_MAX - 1).trimEnd() + "…";
}

// Session/direction vocabulary: website + extension use 'right' | 'below',
// the tree layer uses 'right' | 'down'.
export function normalizeCaptureDirection(dir) {
  return dir === "below" || dir === "down" ? "below" : "right";
}

export function toTreeDirection(dir) {
  return normalizeCaptureDirection(dir) === "right" ? "right" : "down";
}

// ---- Direct-capture dedupe keys --------------------------------------------

// 64-bit-ish non-crypto hash (two independent 32-bit lanes) of the exact
// question + answer text. No truncation, so two different long conversations
// that share a prefix can never collide into one ledger entry.
export function captureContentHash(question, answer) {
  const input =
    String(question ?? "").replace(/\s+/g, " ").trim() +
    "\u0000" +
    String(answer ?? "").replace(/\s+/g, " ").trim();
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ c;
  }
  return (h1 >>> 0).toString(36) + "-" + (h2 >>> 0).toString(36);
}

// Stable ledger key for a direct capture delivery.
//
// The extension sends a `fingerprint` that already covers platform,
// conversation id, message ids and the full Q+A text, so a RETRY of the same
// delivery maps to the same key while the same words asked in a different
// conversation (or answered differently) map to a different one.
export function captureDedupeKey(payload) {
  const p = payload || {};
  const source = String(p.source || "manual").toLowerCase();
  const conv = String(p.conversationId || "");
  const fp = String(p.fingerprint || "") || captureContentHash(p.question, p.answer);
  return `direct:${source}:${conv}:${fp}`;
}

// ---- Applied-item ledger ---------------------------------------------------
// Maps server capture id → created node id, persisted in localStorage so a
// lost ack (or a page reload before the ack landed) can never duplicate a node.
export function loadAppliedCaptureMap() {
  try {
    const raw = localStorage.getItem(APPLIED_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export function saveAppliedCaptureMap(map) {
  try {
    const entries = Object.entries(map);
    const trimmed =
      entries.length > APPLIED_CAP ? Object.fromEntries(entries.slice(-APPLIED_CAP)) : map;
    localStorage.setItem(APPLIED_KEY, JSON.stringify(trimmed));
  } catch {
    /* private mode / quota — in-memory map still guards this session */
  }
}
