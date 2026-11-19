#!/usr/bin/env node
// Build the ThoughtFlow website with a hosted capture API baked in and
// deploy it to GitHub Pages (gh-pages branch).
//
// Usage:
//   node scripts/deploy-hosted.mjs --api https://<your-app>.onrender.com/api --token <CAPTURE_TOKEN>
//   HOSTED_API_BASE=https://<your-app>.onrender.com/api HOSTED_TOKEN=<token> node scripts/deploy-hosted.mjs
//
// This runs `vite build` with VITE_CAPTURE_API_BASE / VITE_CAPTURE_TOKEN
// set, then `gh-pages -d dist`. After this, end users just open the
// website — the panel talks to the hosted API with no Settings needed
// (they can still override in panel → ⚙ Settings).
//
// NOTE: the token is embedded in the built JS — anyone can extract it.
// Use a strong random token, keep the server rate limit on, and rotate
// the token if the API is ever abused. Fine for personal / small-team use.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

const apiBase = (
  arg("--api") ||
  process.env.HOSTED_API_BASE ||
  process.env.VITE_CAPTURE_API_BASE ||
  ""
).trim();
const token = (arg("--token") || process.env.HOSTED_TOKEN || process.env.VITE_CAPTURE_TOKEN || "").trim();

if (!apiBase || !token) {
  console.error(
    "Missing hosted API config. Pass --api and --token, or set HOSTED_API_BASE / HOSTED_TOKEN.\n" +
      "Example: node scripts/deploy-hosted.mjs --api https://my-app.onrender.com/api --token <token>"
  );
  process.exit(1);
}

if (!/^https:\/\//.test(apiBase)) {
  console.error(`Hosted API base must be an https:// URL (got: ${apiBase})`);
  process.exit(1);
}

const env = {
  ...process.env,
  VITE_CAPTURE_API_BASE: apiBase.replace(/\/+$/, ""),
  VITE_CAPTURE_TOKEN: token,
};

console.log(`Building website with hosted API: ${env.VITE_CAPTURE_API_BASE}`);
console.log("Running: npm run build");
let r = spawnSync("npm", ["run", "build"], { cwd: root, env, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log("Deploying dist/ to gh-pages…");
r = spawnSync("npx", ["gh-pages", "-d", "dist"], { cwd: root, env, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log("\nDone. The live website now points at the hosted API — no Settings needed.");
