# AI Chat Auto Capture

Captures complete **Question + Answer** pairs from ChatGPT / Gemini in your browser
and turns each pair into **one node** in your ThoughtFlow mind map — exact text, no
summarizing, no rewriting, no AI APIs.

```
ChatGPT / Gemini  →  Chrome extension  →  POST /api/ai-capture  →  ThoughtFlow tab
   (visible DOM)        (pairing + dedupe)     (queue + token auth)    (existing addNodeInDirection)
```

## Components

| Piece | Location | Purpose |
|---|---|---|
| Capture API | `server/` | Express + MongoDB (auto-fallback to in-memory) on port **5001** |
| Chrome extension | `chrome-extension/` | MV3; content scripts for ChatGPT & Gemini, popup, retry queue |
| Website panel | `src/components/AiCapturePanel.jsx` | Bottom-left ON/OFF, start node, direction, status |
| App integration | `src/App.jsx` | Poller, parent chaining, node creation via existing tree logic |
| Helpers | `src/utils/aiCapture.js` | API calls, note HTML, title shortening |

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
5. Ask "What is software?" → chained to the right of node 1. Then "What is hardware?".
6. Switch panel direction to **Below**, ask "What is RAM?" → node appears **below**
   the latest node. Previous nodes are never rearranged.

Duplicate Q+A pairs are rejected (SHA-256 content fingerprint in the API +
client-side seen-list in the extension), streaming answers are captured only once
after the text is stable for `stabilityMs` (default 2000 ms).

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
   (declare host permissions: chatgpt.com, gemini.google.com, your API origin),
   submit for review.
6. Alternative: distribute the zip privately inside your org — users load it
   unpacked or via enterprise policy.

## API reference

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | liveness + storage mode |
| POST | `/api/ai-capture` | token | store one Q+A pair (idempotent, `duplicate: true` on repeat) |
| GET | `/api/ai-capture/pending` | token | un-applied pairs for the frontend |
| POST | `/api/ai-capture/:id/ack` | token | frontend confirms node creation |
| GET/PUT | `/api/ai-capture/session` | token | `{enabled, direction, rootNodeId, currentParentNodeId}` |
| GET | `/api/ai-capture/stats` | token | `{captured}` count |
| GET | `/api/ai-capture/sync` | token | session + pending + stats in one round trip |

Auth: `X-Capture-Token: <token>` or `Authorization: Bearer <token>`.

## Privacy

- Content scripts run **only** on `chatgpt.com`, `chat.openai.com`, `gemini.google.com`.
- Only message text is read — never passwords, cookies, history or other tabs.
- Server logs contain IDs and fingerprints only, never conversation content.
