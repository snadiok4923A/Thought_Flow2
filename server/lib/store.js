// Storage layer for AI captures.
// Uses MongoDB when reachable, otherwise transparently falls back to an in-memory
// store so local testing works without a running MongoDB instance.
// Duplicate prevention is enforced either way via a content fingerprint.

const crypto = require("crypto");

const MAX_QUESTION = 8000;
const MAX_ANSWER = 120000;
const VALID_SOURCES = ["chatgpt", "gemini"];
const VALID_DIRECTIONS = ["right", "below", "bottom", "down"];

let mode = "memory"; // 'mongo' | 'memory'
let CaptureModel = null;
let SessionModel = null;

// ---- In-memory fallback state --------------------------------------------
const memItems = new Map(); // id -> record
const memFingerprints = new Map(); // fingerprint -> id
const memSession = {
  enabled: false,
  direction: "right",
  rootNodeId: null,
  currentParentNodeId: null,
  extensionHeartbeat: null,
  updatedAt: null,
};
let memSeq = 0;

// ---- Helpers --------------------------------------------------------------

// Fingerprint for duplicate detection: platform + conversation + normalized content.
// Normalization collapses whitespace only (used for dedupe, never alters stored text).
function fingerprintOf({ source, conversationId, question, answer }) {
  const normalize = (s) => String(s || "").trim().replace(/\s+/g, " ");
  const payload = [
    source || "",
    conversationId || "",
    normalize(question),
    normalize(answer),
  ].join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function normalizeDirection(dir) {
  const d = String(dir || "right").toLowerCase();
  if (d === "below" || d === "down") return "below";
  return "right";
}

function validateCapture(body) {
  const source = String(body.source || "").toLowerCase();
  if (!VALID_SOURCES.includes(source)) return { error: "Invalid or missing source." };

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!question) return { error: "Question is required." };
  if (!answer) return { error: "Answer is required." };
  if (question.length > MAX_QUESTION) return { error: "Question too long." };
  if (answer.length > MAX_ANSWER) return { error: "Answer too long." };

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId.slice(0, 256) : "";

  const parentNodeId =
    typeof body.parentNodeId === "string" && body.parentNodeId.length <= 128
      ? body.parentNodeId
      : null;

  return {
    value: {
      source,
      conversationId,
      question,
      answer,
      parentNodeId,
      direction: body.direction !== undefined && body.direction !== null && body.direction !== ""
        ? normalizeDirection(body.direction)
        : null, // null → server fills from the shared session
      fingerprint: fingerprintOf({ source, conversationId, question, answer }),
    },
  };
}

// ---- Mongo models (lazily defined) ---------------------------------------

function defineModels() {
  const mongoose = require("mongoose");

  const captureSchema = new mongoose.Schema(
    {
      fingerprint: { type: String, required: true, unique: true, index: true },
      source: { type: String, enum: VALID_SOURCES, required: true },
      conversationId: { type: String, default: "" },
      question: { type: String, required: true },
      answer: { type: String, required: true },
      parentNodeId: { type: String, default: null },
      direction: { type: String, enum: ["right", "below"], default: "right" },
      status: {
        type: String,
        enum: ["pending", "applied", "unapplied"],
        default: "pending",
      },
      nodeId: { type: String, default: null },
      appliedAt: { type: Date, default: null },
    },
    { timestamps: true }
  );

  const sessionSchema = new mongoose.Schema(
    {
      key: { type: String, unique: true, default: "default" },
      enabled: { type: Boolean, default: false },
      direction: { type: String, enum: ["right", "below"], default: "right" },
      rootNodeId: { type: String, default: null },
      currentParentNodeId: { type: String, default: null },
      // Extension heartbeat (ms epoch) — powers the website's real "Connected" status.
      extensionHeartbeat: { type: Number, default: null },
    },
    { timestamps: true }
  );

  if (!CaptureModel) CaptureModel = mongoose.model("TFCapture", captureSchema);
  if (!SessionModel) SessionModel = mongoose.model("TFSession", sessionSchema);
}

// ---- Lifecycle ------------------------------------------------------------

async function init() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    mode = "memory";
    console.log("[capture-store] No MONGO_URI set — using in-memory store.");
    return mode;
  }
  try {
    const mongoose = require("mongoose");
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
    defineModels();
    mode = "mongo";
    console.log("[capture-store] Connected to MongoDB.");
  } catch (err) {
    mode = "memory";
    console.warn(
      `[capture-store] MongoDB unreachable (${err.message}) — falling back to in-memory store.`
    );
  }
  return mode;
}

function storageMode() {
  return mode;
}

// ---- Captures -------------------------------------------------------------

async function createCapture(data) {
  if (mode === "mongo") {
    try {
      const doc = await CaptureModel.create({ ...data, direction: data.direction || "right" });
      return { id: String(doc._id), duplicate: false };
    } catch (err) {
      if (err && err.code === 11000) {
        const existing = await CaptureModel.findOne({ fingerprint: data.fingerprint });
        return { id: existing ? String(existing._id) : null, duplicate: true };
      }
      throw err;
    }
  }

  const existingId = memFingerprints.get(data.fingerprint);
  if (existingId) return { id: existingId, duplicate: true };

  const id = `mem-${Date.now()}-${++memSeq}`;
  memItems.set(id, {
    id,
    ...data,
    direction: data.direction || "right",
    status: "pending",
    nodeId: null,
    createdAt: new Date(),
    appliedAt: null,
  });
  memFingerprints.set(data.fingerprint, id);
  return { id, duplicate: false };
}

function toPublic(item) {
  if (!item) return null;
  return {
    id: item.id || String(item._id),
    source: item.source,
    conversationId: item.conversationId || "",
    question: item.question,
    answer: item.answer,
    parentNodeId: item.parentNodeId || null,
    direction: item.direction === "below" ? "below" : "right",
    status: item.status,
    nodeId: item.nodeId || null,
    createdAt: item.createdAt,
  };
}

async function listPending(limit = 10) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  if (mode === "mongo") {
    const docs = await CaptureModel.find({ status: "pending" })
      .sort({ createdAt: 1 })
      .limit(n);
    return docs.map(toPublic);
  }
  return [...memItems.values()]
    .filter((i) => i.status === "pending")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, n)
    .map(toPublic);
}

async function ackCapture(id, { nodeId, status = "applied" }) {
  if (mode === "mongo") {
    const doc = await CaptureModel.findByIdAndUpdate(
      id,
      { status, nodeId: nodeId || null, appliedAt: new Date() },
      { new: true }
    );
    return toPublic(doc);
  }
  const item = memItems.get(id);
  if (!item) return null;
  item.status = status;
  item.nodeId = nodeId || null;
  item.appliedAt = new Date();
  return toPublic(item);
}

async function countApplied() {
  if (mode === "mongo") return CaptureModel.countDocuments({ status: "applied" });
  let n = 0;
  for (const i of memItems.values()) if (i.status === "applied") n++;
  return n;
}

// ---- Session --------------------------------------------------------------
// { enabled, direction, rootNodeId, currentParentNodeId }
// The ThoughtFlow tab owns the real node graph; this session is the shared
// handshake between the website panel and the extension.

const DEFAULT_SESSION = {
  enabled: false,
  direction: "right",
  rootNodeId: null,
  currentParentNodeId: null,
};

async function getSession() {
  if (mode === "mongo") {
    const doc = await SessionModel.findOne({ key: "default" });
    if (!doc) return { ...DEFAULT_SESSION };
    return {
      enabled: !!doc.enabled,
      direction: doc.direction === "below" ? "below" : "right",
      rootNodeId: doc.rootNodeId || null,
      currentParentNodeId: doc.currentParentNodeId || null,
      extensionHeartbeat: doc.extensionHeartbeat || null,
      updatedAt: doc.updatedAt,
    };
  }
  return { ...memSession };
}

async function saveSession(patch = {}) {
  const clean = {};
  if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
  if (patch.direction !== undefined) clean.direction = normalizeDirection(patch.direction);
  if ("rootNodeId" in patch) clean.rootNodeId = patch.rootNodeId ? String(patch.rootNodeId) : null;
  if ("currentParentNodeId" in patch)
    clean.currentParentNodeId = patch.currentParentNodeId
      ? String(patch.currentParentNodeId)
      : null;
  if (patch.extensionHeartbeat !== undefined) {
    const hb = Number(patch.extensionHeartbeat);
    clean.extensionHeartbeat = Number.isFinite(hb) && hb > 0 ? hb : null;
  }

  if (mode === "mongo") {
    const doc = await SessionModel.findOneAndUpdate(
      { key: "default" },
      { $set: clean },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return {
      enabled: !!doc.enabled,
      direction: doc.direction === "below" ? "below" : "right",
      rootNodeId: doc.rootNodeId || null,
      currentParentNodeId: doc.currentParentNodeId || null,
      extensionHeartbeat: doc.extensionHeartbeat || null,
      updatedAt: doc.updatedAt,
    };
  }
  Object.assign(memSession, clean, { updatedAt: new Date() });
  return { ...memSession };
}

module.exports = {
  init,
  storageMode,
  validateCapture,
  fingerprintOf,
  normalizeDirection,
  createCapture,
  listPending,
  ackCapture,
  countApplied,
  getSession,
  saveSession,
};
