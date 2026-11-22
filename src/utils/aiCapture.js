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
const DIRECT_TURNS_KEY = "thoughtflow-ai-direct-turns";
const DIRECT_TURNS_CAP = 400;

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

// Keep only the actual question and answer; never add platform/speaker
// labels to the Notes editor. Separate the two messages with a blank line.
// Escape user-provided HTML, preserving line breaks within each message.
export function buildCaptureNoteHtml({ question, answer }) {
  return (
    `<p>${textToHtml(question)}</p>` +
    `<p><br></p>` +
    `<p>${textToHtml(answer)}</p>`
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

// ---- Direct capture turn ledger --------------------------------------------
// The extension identifies a turn by conversation + question (never by answer
// text or DOM ids), so a streamed answer that keeps growing arrives as the
// SAME turn. This ledger remembers what was written to which node, letting a
// longer final answer update that node instead of creating a second one.
export function loadDirectTurnLedger() {
  try {
    const raw = localStorage.getItem(DIRECT_TURNS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export function saveDirectTurnLedger(map) {
  try {
    const entries = Object.entries(map);
    const trimmed =
      entries.length > DIRECT_TURNS_CAP ? Object.fromEntries(entries.slice(-DIRECT_TURNS_CAP)) : map;
    localStorage.setItem(DIRECT_TURNS_KEY, JSON.stringify(trimmed));
  } catch {
    /* private mode / quota — in-memory ledger still guards this session */
  }
}

// create → new node; update → same node, answer grew while streaming;
// duplicate → already captured (or the user edited the note — never overwrite).
export function decideDirectCapture({ question, answer, ledgerEntry, nodeNotes }) {
  if (!ledgerEntry || !ledgerEntry.nodeId || typeof nodeNotes !== "string") {
    return { action: "create" };
  }
  if (ledgerEntry.question === question && ledgerEntry.answer === answer) {
    return { action: "duplicate" };
  }
  const expected = buildCaptureNoteHtml({
    question: ledgerEntry.question,
    answer: ledgerEntry.answer,
  });
  return nodeNotes === expected ? { action: "update" } : { action: "duplicate" };
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
