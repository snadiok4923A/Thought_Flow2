// Hosted defaults for the ThoughtFlow AI Capture extension.
//
// Empty strings = local development (http://localhost:5001/api).
// scripts/pack-extension.mjs rewrites this file when building a
// distributable zip with a hosted capture API baked in, so end users
// get zero-config: install extension → open website → done.
//
// Users can still override both values in popup → Settings
// (chrome.storage.sync wins over these defaults).

globalThis.TF_HOSTED_CONFIG = {
  apiBase: "",
  token: "",
};
