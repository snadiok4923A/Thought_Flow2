require("dotenv").config();

const express = require("express");
const cors = require("cors");
const captureAuth = require("./lib/auth");
const store = require("./lib/store");

const app = express();
// CAPTURE_PORT wins over PORT (some shells export PORT=0 for ephemeral binds)
const PORT = parseInt(process.env.CAPTURE_PORT || process.env.PORT, 10) || 5001;

// The extension (chrome-extension:// origin) and the local Vite app both call this API.
app.use(
  cors({
    origin: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Capture-Token"],
    methods: ["GET", "POST", "PUT", "OPTIONS"],
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    ok: true,
    service: "ThoughtFlow AI Capture",
    storage: store.storageMode(),
  });
});

// Every capture route requires the shared capture token.
const router = express.Router();
router.use(captureAuth);

// POST /api/ai-capture — one complete Question + Answer pair → one pending node.
// Idempotent: identical pairs return the original id with duplicate: true.
router.post("/", async (req, res) => {
  try {
    const check = store.validateCapture(req.body || {});
    if (check.error) return res.status(400).json({ message: check.error });

    const session = await store.getSession();
    const record = {
      ...check.value,
      parentNodeId: check.value.parentNodeId || session.currentParentNodeId || session.rootNodeId,
      direction: check.value.direction || session.direction || "right",
    };

    const { id, duplicate } = await store.createCapture(record);

    // Logging only identifiers — never conversation content.
    console.log(
      `[capture] ${duplicate ? "duplicate" : "new"} src=${record.source} id=${id} fp=${record.fingerprint.slice(0, 12)}`
    );

    res.status(duplicate ? 200 : 201).json({
      id,
      duplicate,
      parentNodeId: record.parentNodeId,
      direction: record.direction,
    });
  } catch (err) {
    console.error("[capture] store error:", err.message);
    res.status(500).json({ message: "Could not store capture." });
  }
});

// GET /api/ai-capture/pending — the ThoughtFlow tab polls this for un-applied pairs.
router.get("/pending", async (req, res) => {
  try {
    const items = await store.listPending(req.query.limit);
    res.json({ items });
  } catch (err) {
    console.error("[capture] pending error:", err.message);
    res.status(500).json({ message: "Could not list pending captures." });
  }
});

// POST /api/ai-capture/:id/ack — the frontend confirms it created the node.
router.post("/:id/ack", async (req, res) => {
  try {
    const status = req.body && req.body.status === "unapplied" ? "unapplied" : "applied";
    const item = await store.ackCapture(req.params.id, {
      nodeId: req.body && req.body.nodeId,
      status,
    });
    if (!item) return res.status(404).json({ message: "Capture not found." });
    res.json({ ok: true, id: item.id, status: item.status });
  } catch (err) {
    console.error("[capture] ack error:", err.message);
    res.status(500).json({ message: "Could not acknowledge capture." });
  }
});

// GET/PUT /api/ai-capture/session — shared handshake: enabled, direction, start node,
// fixed AI parent (manual selection only; AI nodes never become the parent).
// Written by the website panel, read by the extension.
router.get("/session", async (req, res) => {
  try {
    res.json(await store.getSession());
  } catch {
    res.status(500).json({ message: "Could not read session." });
  }
});

router.put("/session", async (req, res) => {
  try {
    res.json(await store.saveSession(req.body || {}));
  } catch {
    res.status(500).json({ message: "Could not save session." });
  }
});

// GET /api/ai-capture/stats — captured conversation count for the panel/popup.
router.get("/stats", async (req, res) => {
  try {
    res.json({ captured: await store.countApplied() });
  } catch {
    res.status(500).json({ message: "Could not read stats." });
  }
});

// GET /api/ai-capture/sync — one round-trip: session + pending + captured count.
router.get("/sync", async (req, res) => {
  try {
    // TEMP debug: which frontend origin is polling (referee for pending items).
    console.log(`[sync] poll ${new Date().toISOString()} from ${req.get("referer") || req.get("origin") || "unknown-origin"}`);
    const [session, items, captured] = await Promise.all([
      store.getSession(),
      store.listPending(req.query.limit),
      store.countApplied(),
    ]);
    res.json({
      session,
      items,
      captured,
      // ms epoch of the extension's last heartbeat — drives the website's
      // "Connected" indicator (extension actually talking to this API).
      extensionLastSeen: session.extensionHeartbeat || null,
    });
  } catch (err) {
    console.error("[capture] sync error:", err.message);
    res.status(500).json({ message: "Could not sync captures." });
  }
});

app.use("/api/ai-capture", router);

app.use((req, res) => res.status(404).json({ message: "Route not found." }));

store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`ThoughtFlow AI Capture API running on http://localhost:${PORT}`);
    console.log(`Storage: ${store.storageMode()}`);
  });
});
