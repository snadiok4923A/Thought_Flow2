// AI Chat Capture — helpers for talking to the capture backend and for
// formatting captured conversations into the existing note (HTML) format.

const DEFAULT_API_BASE = "http://localhost:5001/api";
const DEFAULT_TOKEN = "tf-local-capture-token";
const CFG_KEY = "thoughtflow-ai-capture-cfg";

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

export function sourceLabel(source) {
  return source === "gemini" ? "Gemini" : "ChatGPT";
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
