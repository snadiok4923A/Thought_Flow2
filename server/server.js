require("dotenv").config();

const express = require("express");
const cors = require("cors");
const captureAuth = require("./lib/auth");
const store = require("./lib/store");

const app = express();
// CAPTURE_PORT wins over PORT (some shells export PORT=0 for ephemeral binds;
// hosts like Render/Railway inject PORT — that one is honoured automatically)
const PORT = parseInt(process.env.CAPTURE_PORT || process.env.PORT, 10) || 5001;

// The extension (chrome-extension:// origin) and the website both call this API.
// ALLOWED_ORIGINS=comma,separated,origins locks this down for a hosted deployment;
// unset reflects any origin (fine for local development).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length
      ? (origin, cb) => {
          // Allow same-origin/curl (no Origin header) and explicitly listed origins.
          if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
          return cb(new Error("Not allowed by CORS"));
        }
      : true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Capture-Token"],
    methods: ["GET", "POST", "PUT", "OPTIONS"],
  })
);
app.use(express.json({ limit: "1mb" }));

// Tiny fixed-window rate limiter for capture writes — no extra dependencies.
// Guards a publicly hosted API from token-guessing / flooding. 30 writes/min/IP.
const CAPTURE_RATE_LIMIT = parseInt(process.env.CAPTURE_RATE_LIMIT, 10) || 30;
const rateHits = new Map(); // ip -> { windowStart, count }
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, rec] of rateHits) if (rec.windowStart < cutoff) rateHits.delete(ip);
}, 60_000).unref();

function captureRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const nowTs = Date.now();
  let rec = rateHits.get(ip);
  if (!rec || nowTs - rec.windowStart >= 60_000) {
    rec = { windowStart: nowTs, count: 0 };
    rateHits.set(ip, rec);
  }
  rec.count += 1;
  if (rec.count > CAPTURE_RATE_LIMIT) {
    return res.status(429).json({ message: "Too many captures — slow down." });
  }
  next();
}

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
router.post("/", captureRateLimit, async (req, res) => {
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
