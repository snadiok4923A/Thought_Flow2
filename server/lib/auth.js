const crypto = require("crypto");

// Shared-token authentication.
// The "user" is identified by possession of the capture token — no user-provided
// userId is ever trusted. Accepts `X-Capture-Token: <token>` or `Authorization: Bearer <token>`.
module.exports = function captureAuth(req, res, next) {
  const expected = process.env.CAPTURE_TOKEN || "";
  if (!expected) {
    return res.status(500).json({ message: "Capture token is not configured on the server." });
  }

  const headerToken = req.headers["x-capture-token"] || "";
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const provided = headerToken || bearer;

  if (!provided) {
    return res.status(401).json({ message: "Missing capture token." });
  }

  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: "Invalid capture token." });
  }

  // Identity comes from the token itself — never from the request body.
  req.captureTokenId = "capture-token";
  next();
};
