# AI Chat Auto Capture

Captures complete **Question + Answer** pairs from AI chat sites in your browser
and turns each pair into **one node** in your ThoughtFlow mind map — exact text, no
summarizing, no rewriting.

```
ChatGPT / Gemini / Arena / any AI chat  →  Chrome extension  →  ThoughtFlow tab (direct)
     (visible DOM)                          (pairing + dedupe)     (bridge content script → existing addNodeInDirection)
```

**Direct mode (default, no server):** the extension delivers each Q+A pair
straight to the open ThoughtFlow tab via `content/thoughtflow-bridge.js` —
no capture server, no queue, no MongoDB. The website must be open in a tab
while chatting; if it is closed the pair is dropped and the content script
retries after its cooldown (open the website promptly and it still lands).
The legacy server path (`server/` + `POST /api/ai-capture`) is kept for
backward compat but is no longer on the capture path.

## Supported platforms

| Tier | Sites | How it works |
|---|---|---|
| Dedicated selectors | ChatGPT, Gemini | Multi-strategy DOM readers in `content/selectors-*.js` |
| Generic engine | Arena (arena.ai / lmarena.ai), Grok, Claude, DeepSeek, Perplexity, Copilot, Poe, You.com, DuckDuckGo AI, Meta AI, Mistral, Qwen, Kimi, Felo, GLM (z.ai), MiniMax | Heuristic alternating-thread reader in `content/selectors-generic.js` — poor man's fallback, ships diagnostics (`strategy=roles|turns|alternating|none`) |
| Quick add (always works) | **Any** AI site | Extension popup → "Quick add" → paste question + answer → stored as a pending pair, becomes a node exactly like auto-capture |

The generic engine reads the **alternating** structure of chat UIs
(user asks → assistant answers). If a site changes its markup, `strategy=none`
shows up in diagnostics — that site then needs either a dedicated
`content/selectors-<site>.js` (best) or the popup's Quick add.

New sites are one `matches` entry away: add the host to `manifest.json`
(`content_scripts` + `host_permissions`) and to `HOST_PLATFORMS` in
`content/selectors-generic.js` (pick any short lowercase `source` tag), then
reload the extension. The backend accepts any `^[a-z][a-z0-9-]{0,31}$` source —
no server change needed.

## Components

| Piece | Location | Purpose |
|---|---|---|
| Direct bridge | `chrome-extension/content/thoughtflow-bridge.js` | Delivers Q+A pairs from the extension background straight to the open ThoughtFlow tab (no server) |
| Capture API (legacy) | `server/` | Express + MongoDB (auto-fallback to in-memory) on port **5001** — kept for backward compat, no longer on the capture path |
| Chrome extension | `chrome-extension/` | MV3; content scripts for ChatGPT, Gemini + generic engine for ~20 AI chat sites, popup, Quick add |
| Website panel | `src/components/AiCapturePanel.jsx` | Bottom-left ON/OFF, start node, direction, status |
| App integration | `src/App.jsx` | Poller, fixed AI parent, node creation via existing tree logic |
| Helpers | `src/utils/aiCapture.js` | API calls, note HTML, title shortening |

## Why it used to work "sometimes" — root causes fixed (v1.1.0)

1. **Lost answers on transient drops.** The content script marked a pair as
   "seen" *before* the server accepted it. If the website panel was OFF
   (or the API blipped), the pair was silently dropped forever. Now a pair is
   only marked seen after accept/queue/duplicate; transient drops retry every
   30 s.
2. **Duplicate nodes from lost acks.** The website created nodes but acked
   fire-and-forget; a failed ack left the pair "pending" and the next 2.5 s
   poll re-created the node. Now applied capture ids are persisted in
   localStorage (`thoughtflow-ai-applied`), known-applied items are re-acked
   (never re-created), and failed acks retry until they land.
3. **Three switches, no feedback.** Capture only works when the extension popup
   is ON **and** the website panel is ON **and** a start node is selected —
   any miss meant silence. The popup diagnostics now also tell you to check the
   panel, and drops retry automatically instead of vanishing.
4. **Arena and every other AI chat were unsupported** (no content scripts at
   all) — the generic engine + Quick add cover them now.
5. **Backend died with the terminal.** In-memory storage lost all pending
   captures on restart; `server/.env` was committed to the (public) repo.
   `.env` is now untracked/ignored, `.env.example` documents MongoDB + token,
   and the API can be hosted (below) so it does not depend on your PC.
6. **ChatGPT selector rot** — multi-strategy readers remain; the generic
   engine adds a third independent layer for other sites.

Remaining caveats (honest list):
- Generic engine is best-effort. Arena markup could not be verified from the
  build sandbox — if auto-capture misses there, Quick add always works.
- Capture only happens for pairs created **after** the page had a baseline
  (old conversations never retro-capture) and after the answer is stable.
- The ThoughtFlow tab only creates nodes while a board is open; until then
  pairs wait as "pending" on the server — nothing is lost, but nothing
  appears either.

## Local testing (full walkthrough)

```bash
# 1. capture API
cd server && npm install && npm start        # http://localhost:5001

# 2. ThoughtFlow
cd .. && npm run dev                          # http://localhost:5173/Thought_Flow2/

# 3. extension
#    chrome://extensions → Developer Mode → Load unpacked → select chrome-extension/
#    popup: set API base http://localhost:5001/api, token tf-local-capture-token (defaults),
#    Capture = ON, Direction = Right
```

Then in ThoughtFlow:

1. Open/create a mind map and **select the start node** (e.g. "Computer").
2. AI Chat Capture panel → **ON**. (No node selected ⇒ *"Select a node to start AI Capture."*)
3. Ask ChatGPT "What is a PC?" and wait for the answer to finish.
4. A node **"What is a PC?"** appears to the **right** of the start node; the note
   panel shows the exact `User: / ChatGPT:` conversation.
5. Ask "What is software?" → also a child of the **same start node** (siblings,
   never chained). The start node stays selected. Then "What is hardware?".
6. **Manually click another node** (e.g. "b"): from then on every captured node is
   created under that node instead. AI-created nodes are never auto-selected and
   never become the parent.
7. Switch panel direction to **Below**, ask "What is RAM?" → node appears **below**
   the fixed parent. Previous nodes are never rearranged.

Duplicate Q+A pairs are rejected (SHA-256 content fingerprint in the API +
client-side seen-list in the extension), streaming answers are captured only once
after the text is stable for `stabilityMs` (default 2000 ms).

## Debugging a capture that never arrives

1. Reload the extension in `chrome://extensions` after ANY file change, then
   **refresh the AI chat tab** (content scripts only inject into pages loaded
   afterwards — this is the most common reason nothing happens).
2. Open the extension popup → **Diagnostics** → **Run connection test**.
   It reports the exact broken link, e.g. `API unreachable`,
   `invalid capture token`, `popup Capture is OFF`, `website panel is OFF`,
   `no start node selected`, or `PIPELINE OK`.
3. The same page shows the last 40 content/background events
   (`content-loaded`, `scan … strategy=…`, `answer-seen`, `send`, `send-ok`,
   `baseline-skip`, …) — no conversation text is ever logged. The current
   ChatGPT selector strategy (`author-role`, `testid`, `article`, `none`) is
   reported on every scan; `none` means ChatGPT changed its markup and only
   `content/selectors-chatgpt.js` needs updating.
4. The website panel's **Connected** reflects the extension's heartbeat
   (< 90 s), not merely that the website is open.
5. Local end-to-end harness (no real ChatGPT needed):
   `node chrome-extension/test/serve.js` then open
   `http://localhost:5099/test/mock-chatgpt.html` and press **Run Q+A test**.
   It streams a mock answer through the real content scripts, real API and
   real website poller, and shows a PASS/FAIL verdict (includes selector
   strategy switching: classic / testid / article).
6. **Popup shows `Connection: Offline` and an API base like
   `http://localhost:5174/api`** — that port belongs to the Vite dev frontend
   (5173 is taken → Vite auto-increments), which answers `/api/health` with
   404/HTML, never the capture API. The real backend is
   `http://localhost:5001/api`. Known Vite ports (5173–5176, 4173–4174) are
   auto-corrected when the popup opens; **reload the extension** in
   `chrome://extensions` first so the background service worker uses the
   corrected URL too. Offline is the honest status until health returns the
   ThoughtFlow `status/ok` JSON from the real backend.

## Hosting the capture API (works from anywhere, not just your PC)

`localhost:5001` only works while this PC runs the server. The website on
GitHub Pages **can point at any hosted instance** — no rebuild needed:

1. Deploy `server/` to any host that injects `PORT` — Render, Railway, Fly.io
   (all have free tiers):
   - Root directory: `server`  ·  Build: `npm install`  ·  Start: `npm start`
   - Health check path: `/api/health`
2. Set environment variables on the host:
   - `MONGO_URI` — **required** here. Use an Atlas free (M0) cluster, e.g.
     `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/thoughtflow`.
     (In-memory mode loses all pending captures on every restart.)
   - `CAPTURE_TOKEN` — generate one:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ALLOWED_ORIGINS=https://snadiok4923a.github.io` (locks CORS down)
   - `PORT` is injected by the host automatically.
3. Point the **website** at it — either:
   - (easiest, no rebuild) open the panel → ⚙ Settings → set
     `API base URL = https://<your-app>.onrender.com/api` and the token, or
   - (build-time) build the site with `VITE_CAPTURE_API_BASE` /
     `VITE_CAPTURE_TOKEN` set (Vite exposes only `VITE_*` vars).
4. Point the **extension** at it — popup → Settings → same URL and token →
   save → reload the extension in `chrome://extensions`.
5. CORS: the hosted API reflects only `ALLOWED_ORIGINS`; the extension's
   `chrome-extension://` origin needs no listing (extension messaging is not
   subject to page CORS — the API just must answer with CORS headers, which
   it always does).

## Zero-config for end users (one-time host setup, then just works)

`localhost:5001` only ever works on the PC running the server — any other
user opening the GitHub Pages site gets Offline, because their `localhost`
has no server. To make it "open website + install extension → done" for
everyone, do the hosting **once** (steps 1–2 above), then bake the hosted
URL + token into both clients:

```bash
# 1) Website: build with the hosted API baked in, deploy to GitHub Pages
node scripts/deploy-hosted.mjs --api https://<your-app>.onrender.com/api --token <CAPTURE_TOKEN>

# 2) Extension: pack a distributable zip with the same API baked in
node scripts/pack-extension.mjs --api https://<your-app>.onrender.com/api --token <CAPTURE_TOKEN>
# → dist-extension/thoughtflow-capture.zip  (share via Drive / GitHub Release / Web Store)
```

End users then do only:
1. Open the website → panel ON → select a start node.
2. Unzip the extension → `chrome://extensions` → Developer mode → Load unpacked → select the folder.
3. Chat on Arena / ChatGPT / Gemini → node appears. No terminal, no Settings.

Users can still override API/token in panel ⚙ Settings / popup Settings
(`chrome.storage` wins over the baked defaults). Users who previously set
`localhost` in Settings must update it once to the hosted URL.

> **Security note:** the token is embedded in the website JS and the
> extension zip — anyone who extracts them can see it. Use a strong random
> token, keep the server rate limit on (default 30/min/IP), lock CORS with
> `ALLOWED_ORIGINS`, and rotate the token if the API is ever abused. Fine
> for personal / small-team use.

## Chrome extension popup

- **Capture** — extension-level switch (website panel is the second switch; both must be ON)
- **Platform** — ChatGPT / Gemini detected from the active tab
- **Direction** — writes to the shared session; applies to future nodes
- **Connection** — API health + storage mode
- **Captured** — number of applied conversations
- **Settings** — API base URL, capture token, streaming stability ms

## Publishing the extension later

1. Keep `manifest.json` at the package root (it is — don't move files).
2. Bump `version` in `manifest.json`.
3. Replace localhost defaults for production:
   - `server/.env` → real `CAPTURE_TOKEN`, `MONGO_URI`, HTTPS reverse proxy
   - popup Settings → `https://your-api.example.com/api`
   - `src/utils/aiCapture.js` (`DEFAULT_API_BASE` / `DEFAULT_TOKEN`) or expose
     them as Vite env vars
4. Zip the extension folder contents (manifest.json at zip root):
   ```bash
   cd chrome-extension && zip -r thoughtflow-ai-capture.zip . -x '*.md'
   ```
5. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   pay the one-time fee, upload the zip, fill in the store listing
   (declare host permissions: the AI chat hosts you want capture on — see manifest.json — plus your API origin),
   submit for review.
6. Alternative: distribute the zip privately inside your org — users load it
   unpacked or via enterprise policy.

## API reference

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | liveness + storage mode |
| POST | `/api/ai-capture` | token | store one Q+A pair (idempotent, `duplicate: true` on repeat; 429 after 30 writes/min/IP) |
| GET | `/api/ai-capture/pending` | token | un-applied pairs for the frontend |
| POST | `/api/ai-capture/:id/ack` | token | frontend confirms node creation |
| GET/PUT | `/api/ai-capture/session` | token | `{enabled, direction, rootNodeId, currentParentNodeId}` |
| GET | `/api/ai-capture/stats` | token | `{captured}` count |
| GET | `/api/ai-capture/sync` | token | session + pending + stats in one round trip |

Auth: `X-Capture-Token: <token>` or `Authorization: Bearer <token>`.

## Privacy

- Content scripts run **only** on the AI chat hosts listed in `manifest.json` (chatgpt.com, gemini.google.com, arena.ai and ~20 others).
- Only message text is read — never passwords, cookies, history or other tabs.
- Server logs contain IDs and fingerprints only, never conversation content.
