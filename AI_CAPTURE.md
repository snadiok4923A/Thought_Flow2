## v1.2.5 test candidate — ChatGPT semantic capture + explicit hosted destination

This candidate addresses two **separate** user-observed failures.

**ChatGPT:** The earlier universal detector could select
`universal-alternating` whenever guessed markdown/code blocks produced more
apparent Q+A pairs than real role-marked ChatGPT turns. This may pair unrelated
text, import incorrect fragments, or miss the latest answer. ChatGPT now
rejects this generic strategy, preferring its native role/testid/article
extraction; if incomplete, only a semantically identified role/turn strategy
may rescue it. The native ChatGPT selector compares all supported semantic
views and chooses a view with more complete Q+A pairs or a much longer
answer for the same newest question.

**Live delivery:** The live-only policy remains intact. A temporary
`busy`, `bridge-timeout`, `app-timeout`, `bridge-unavailable`, or
`error` response is retried at most twice, in memory, only in the
active chat and within 20 seconds of first failure. A website that is
closed or Capture OFF does **not** queue old conversations. Existing
Gemini native selectors are not modified.

**Hosted routing:** The user's popup still showed `Connected (direct)`
even though main v1.2.4's popup was supposed to report `Connected
(GitHub Pages)` or `Connected (localhost)`. This strongly suggests
an unpacked extension reload/version mismatch. v1.2.5 prominently displays
its loaded version in the popup. It also adds a **Send to** dropdown:
`GitHub Pages`, `localhost`, or `Automatic`. An explicit choice pins
that board even if the user activates other tabs. If no board is chosen,
the existing last-activated board remains preferred; otherwise the hosted
site takes precedence when both are open. Only **one** board receives a
given capture. This does **not** sync mind maps across different origins.

**Hosted website:** In the live screenshots, its DOM bridge was `ready`
and the panel acknowledged `enabled: true, hasStartNode: true`. That
proves only bridge and panel readiness, **not Q+A delivery**.
The published `gh-pages` bundle has not necessarily been rebuilt from
current `main`. Browser delivery still must be verified.

### Required manual test — do not merge before it passes

1. Save/commit any local changes and test this branch:
   `git fetch origin fix/chatgpt-trusted-pairing-live-delivery-2026-11-24`
   and
   `git switch -c qa-routing-test origin/fix/chatgpt-trusted-pairing-live-delivery-2026-11-24`.
2. Reload the unpacked ThoughtFlow extension at `chrome://extensions`.
   **The popup must say v1.2.5.** If not, the browser is running a
   different extension folder; fix this before any other test.
3. Open GitHub Pages ThoughtFlow with Capture ON and a Start Node selected.
   In the extension popup choose **Send to → GitHub Pages**.
   **Connection must say Connected (GitHub Pages)**.
4. In ChatGPT, type a NEW question with a multi-paragraph answer and
   a code block. Verify one new hosted node containing the whole answer.
   Repeat with a second distinct question. Reopen old chat history; no
   old nodes should import.
5. Use `Send to → localhost`, ask another new question, and verify
   it appears only on localhost. Switch back to hosted for normal use.
6. Ask one new question in Gemini and verify exactly one complete Q+A
   on GitHub Pages, then on localhost. Its selector was not changed.

If live ChatGPT capture still fails, inspect the popup's hidden Diagnostics
for `AI detector` pair count, `history-ignored`, `live-turn`,
`answer-seen`, `send`, `live-retry`, `direct-ok`, `live-drop`.
A healthy popup/bridge alone never proves end-to-end capture.

### Automated regressions (simulated DOM, not a live browser)

```bash
node chrome-extension/test/chatgpt-semantic-pairing.mjs
node chrome-extension/test/live-transient-retry.mjs
node chrome-extension/test/two-board-routing.mjs
node chrome-extension/test/live-only-no-history.mjs
node chrome-extension/test/chatgpt-first-turn-baseline.mjs
node chrome-extension/test/notes-answer-capture.mjs
node chrome-extension/test/universal-qa-detector.mjs
node chrome-extension/test/universal-capture-pipeline.mjs
```

**Limits:** This candidate does not prove compatibility with the
current live ChatGPT DOM. The assistant cannot directly access the
user's Chrome session, so the live test above is mandatory. Do not
merge or deploy until verified. No historical notes are deleted.

---

## GitHub Pages vs localhost board selection — v1.2.4 (experimental)

**Observed:** ThoughtFlow works at `http://localhost:5173/Thought_Flow2/`
but no new nodes appear at
`https://snadiok4923a.github.io/Thought_Flow2/` when **both** tabs
are open. Screenshots show a successful local Q+A capture and no hosted
Q+A capture.

**Confirmed cause in extension code:** `background.js/findThoughtFlowTab()`
previously returned the **first** result of `chrome.tabs.query()`. The
direct bridge sent every capture to that one tab regardless of which
ThoughtFlow board the user meant. A green "Connected (direct)" meant
one of the boards was reachable, not necessarily the hosted board.

**Fix:** On user activation of a ThoughtFlow tab, remember only its
browser tab ID in `chrome.storage.session`. All subsequent direct
Q+A delivery and popup health/direction operations prefer that board;
after browser/extension restart with no preference, choose the
matching ThoughtFlow tab with the newest `lastAccessed` timestamp
rather than the first query result. If the target tab has closed, fall
back to another open ThoughtFlow tab. Do NOT duplicate a Q+A to all
boards. The popup now displays `Connected (GitHub Pages)` or
`Connected (localhost)` for the actual selected board.

**Important:** These are two separate website origins and do **not**
automatically synchronize their local Notes, mind maps, or storage.
To direct a new capture to GitHub Pages when both are open, simply
click/activate the GitHub Pages tab before returning to ChatGPT or
Gemini. Verify the popup says `Connected (GitHub Pages)`. To target
localhost, activate that tab instead. Keeping only the intended
ThoughtFlow tab open also prevents ambiguous routing.

The source code for the published GitHub Pages JavaScript bundle
contains the `thoughtflow-capture-direct` handler, but the assistant
could not test the user's live deployed browser session. After
updating the unpacked Extension to v1.2.4, reload the Extension,
refresh the hosted and local boards, and test a new Q+A on the
hosted board. **No website redeploy is necessary for this particular
extension-routing fix**, provided the existing deployed site's bridge
and direct capture listener work.

Regression:

```bash
node chrome-extension/test/two-board-routing.mjs
node chrome-extension/test/live-only-background.mjs
node chrome-extension/test/live-only-no-history.mjs
```

Do not merge the PR until the user has verified a new Q+A appears
on GitHub Pages while both board tabs are open. A hosted board
with no selected Start Node or with its Capture panel switched OFF
still cannot receive Q+A; address that site state separately.

---

## Live-only automatic capture — experimental v1.2.3

**User requirement:** ChatGPT and Gemini should add **only Q+A written while
ThoughtFlow capture is running now**. Opening an old conversation, reloading
the extension, returning to a tab or reconnecting a backend must **not**
create a burst of old nodes. The previous screenshot showed many historical
`another` nodes appearing when the user resumed chatting.

### Live-only contract

- Automatic capture requires **fresh user input in the AI site's composer
  while Capture is ON**, matched to the newly completed turn. The shared
  capture engine uses ephemeral normalized question keys and a snapshot of
  already-visible turns, not an import of old conversation histories.
- Initial page load, late-loading older messages, SPA history navigation,
  reload, and reopening previous chats do **not** authorize capture.
- An explicitly sent ChatGPT prompt can carry a short-lived fingerprint
  across **new-chat navigation** only. Reloading the SAME conversation path
  cannot revive an old Send marker.
- Each newly typed Q+A is eligible only once. If its answer grows during
  generation, subsequent revisions use its same stable turn fingerprint
  and update the existing Notes when safe.
- A deliberate Notes **Ask ChatGPT** request is still eligible, but
  **only the newest matching pair**, not older identical questions.
- **No backlog retry**: a dropped automatic capture is **not** stored for
  later import when the website or extension returns. Keep the ThoughtFlow
  website and selected Start Node open while actively chatting.
- Previous legacy retry queue contents remain **untouched but inert**. The
  periodic background queue replay is disabled, and the frontend no longer
  imports stale backend `/ai-capture/sync` items. This avoids deleting any
  existing user data while ensuring old Q+A does not appear unexpectedly.
- The popup shows a session-scoped **Live captured** counter instead of the
  lifetime historical count. Older existing nodes/Notes are preserved;
  this patch does **not** automatically delete previous duplicates.
- This is a user-input-based capture contract; chat services that do not
  dispatch browser `input` events or do not expose readable message roles
  may need a small site adapter. Manual Quick add remains available.

### Local regression tests

```bash
node chrome-extension/test/live-only-no-history.mjs
node chrome-extension/test/chatgpt-first-turn-baseline.mjs
node chrome-extension/test/notes-answer-capture.mjs
node chrome-extension/test/chatgpt-tab-session-capture.mjs
node chrome-extension/test/universal-capture-pipeline.mjs
node chrome-extension/test/universal-qa-detector.mjs
```

### Test the branch before merging

Keep any local edits saved or committed before switching branches:

```powershell
git fetch origin fix/live-only-no-history-backfill-2026-11-23
git switch -c live-only-test origin/fix/live-only-no-history-backfill-2026-11-23
```

Reload the unpacked extension (confirm **v1.2.3**) and refresh ThoughtFlow,
Gemini and ChatGPT tabs. Keep the ThoughtFlow Start Node selected and both
Capture toggles ON. First, open a *past* ChatGPT conversation and a past
Gemini conversation: **zero new nodes** should be created. Next, send a
*new* Q+A in each AI chat: **one node per new turn**, with complete Notes.
Reload the AI tab and navigate old history again: **zero new nodes**. The
popup's Live captured number should reflect only new captures in that
extension session.

If live capture is missing, check Diagnostics for `live-turn` (a newly
typed question was authorized), `history-ignored` (old Q+A skipped),
`send`/`direct-ok` (delivery), or `live-drop` (failed capture, no
later replay). These log counts, never the full conversation text.

The tests above are mocked/simulated JavaScript checks, **not proof that
a real Gemini/ChatGPT browser session works**. Test manually before merge.
To undo local branch testing: `git switch main`, then reload Extension.

---

## Turn identity, complete answers and bounded delivery — v1.2.2

**Observed:** a ChatGPT node was sometimes created with a short fragment,
sometimes the answer was truncated, and `send-ok — accepted` could appear in
Diagnostics without a new node. Gemini was unaffected.

Three separate defects were found and fixed in the shared pipeline (not in a
site-specific adapter):

1. **Fingerprints changed while the answer streamed.** The dedupe key hashed
   the DOM message ids and the answer text. A re-rendered message looked like
   a new turn, and an answer that grew after an early capture created a
   *second* node instead of updating the first. `pairFingerprint()` in
   `content/capture-core.js` now hashes platform + conversation + question +
   occurrence of that question. Ids and answer text are no longer part of a
   turn's identity. The engine remembers the delivered answer per fingerprint
   and re-sends only when that answer grows; the website updates the existing
   node's note (`decideDirectCapture` in `src/utils/aiCapture.js`) and leaves
   a note alone when its text no longer matches what capture wrote (manual
   edits are never overwritten).
2. **Split assistant rows overwrote each other.** `collectPairs()` kept only
   the last assistant row of a turn, so a reply rendered as a markdown body
   plus a separate code block lost everything but the last part. Rows are now
   merged (containment-aware, otherwise joined with a blank line).
3. **A lost page ack hung forever.** `content/thoughtflow-bridge.js` kept the
   `chrome.runtime` port open until the React app replied; if the app had not
   mounted its listener the reply never came, the background's `sendMessage`
   never settled, and the content script's in-flight pair was never retried.
   The bridge now fails after 8 s with `app-timeout`, and `background.js`
   bounds delivery at 12 s (`bridge-timeout`, `bridge-unavailable`). Drop
   reasons now reach the popup diagnostics instead of being flattened to
   `website-off`; the website acks `busy`, `no-start-node` and `error`
   distinctly.

Regression tests:

```bash
node chrome-extension/test/capture-turn-identity.mjs
node chrome-extension/test/direct-turn-decision.mjs
node chrome-extension/test/bridge-ack-timeout.mjs
node chrome-extension/test/chatgpt-full-answer-quality.mjs
node chrome-extension/test/gemini-clean-capture.mjs
```

Live-browser verification is still required for the DOM itself: ask ChatGPT a
question whose answer includes a code block, and confirm the node's note ends
with the true final line. Gemini's native adapter is untouched.

## ChatGPT full-answer capture quality — experimental v1.2.1

**Observed:** The user asked ChatGPT **"Another"**, which returned a long
Python coding example, but ThoughtFlow created a node with the Q+A
`another` / `Another` instead of the completed multi-section response.
Another question sometimes captured a longer answer correctly. Gemini
still captured both messages, so the existing connection/bridge worked.

Changes **only for ChatGPT**:

- ChatGPT's testid/article extractor previously selected the **first**
  `.markdown` element of an assistant turn. Now it prefers the complete
  assistant role body, otherwise reads the full assistant turn if the
  first snippet is substantially shorter. This is intended to include
  later markdown and code blocks in the same reply.
- The shared universal selector wrapper can prefer an explicitly role-marked
  generic answer when **the latest question matches** ChatGPT's native
  extraction, but the generic answer is substantially longer. Gemini's
  native extraction preference is unchanged.
- In the shared capture engine, a short ChatGPT response that simply
  echoes the user question (case-insensitively) is treated as a possible
  temporary fragment and is **not delivered**. ChatGPT's text-stability
  window is increased from 4.5 to **8 seconds**, to reduce early
  partial-answer capture. Gemini and other providers retain their existing
  windows.

These are defensive quality improvements, **not a claim of guaranteed
completion** on the live ChatGPT website. If ChatGPT changes its DOM or
generation indicators, another measured adjustment may still be needed.
This release does **not** automatically repair Notes already created
with a partial answer.

Regression tests:

```bash
node chrome-extension/test/chatgpt-full-answer-quality.mjs
node chrome-extension/test/notes-answer-capture.mjs
node chrome-extension/test/chatgpt-first-turn-baseline.mjs
node chrome-extension/test/universal-qa-detector.mjs
node chrome-extension/test/universal-capture-pipeline.mjs
```

Before merging the PR, test its branch against a *fresh* ChatGPT question
that produces a multi-paragraph response with a code block. Allow at least
8 seconds after the response has stopped changing. Confirm that the newly
created ThoughtFlow Note contains the entire visible answer. Then check
that Gemini still captures one normal Q+A as before. If capture fails,
inspect the extension's diagnostic events, especially
`answer-echo-wait`, `scan`, `answer-seen`, `send`, `direct-ok`,
and `send-dropped`. Diagnostics do not include private Q+A text.

---

## Universal AI chat capture — experimental v1.2.0

ThoughtFlow now has **one shared capture engine** and **one universal message
detector**. Rather than having unrelated feature implementations for ChatGPT,
Gemini and every other provider, the detector prefers a native DOM adapter
when it yields a complete Q+A pair and falls back to generic role-marked or
turn-container extraction when that adapter is incomplete. All providers
then use the same core for Q+A pairing, streaming/stability, deduplication,
sending and mind-map node creation.

- **Bundled AI hosts** (including ChatGPT, Gemini, DeepSeek, Copilot,
  Claude, Arena, Grok, Perplexity and others in manifest.json) are enabled
  on the supported hosts by the usual explicit extension installation
  permissions.
- **Another HTTPS AI chat website:** open that site, click the ThoughtFlow
  extension popup, then click **Enable capture on this site**. The browser
  requests permission **only for that specific website** and registers
  the same universal scripts for current and future conversations. You
  can revoke it later from the browser's extension Site access settings.
- **Unknown chat UIs:** automatic capture is only attempted when reliable
  user/assistant role markers are found. Arbitrary prose blocks are not
  guessed to be a Q+A conversation. Unsupported shadow DOM, canvas chats,
  iframe content, unusual layouts, or changed markup may require an
  adapter or Quick add. Automatic support for literally every chatbot
  cannot be guaranteed.
- **Notes Ask ChatGPT:** this existing *outbound* feature is still
  ChatGPT-specific. Universal **inbound Q+A capture** is separate; no
  hidden API request or automatic submission to other AI accounts is added.

### Why both Gemini and ChatGPT sometimes stopped after Extension reload

An existing tab can outlive a browser extension update. In that situation
the popup can say Capture ON while the AI tab has **no active content script**.
v1.2.0 repairs the same universal capture scripts on already-open supported
AI tabs after extension installation/update and on tab navigation. Its
hidden Diagnostics view (Shift-click the popup header logo) now includes
**AI detector** status, number of extracted messages, number of complete
Q+A pairs and extraction strategy. This distinguishes "ThoughtFlow bridge
connected" from "AI chat actually being read."

### Test the experimental branch before merging

To avoid breaking a currently working Gemini version again, first test the
branch locally **without merging the pull request**. Save or commit any
uncommitted project edits before switching branches.

```bash
git fetch origin feature/unified-ai-capture-optin-2026-11-22
git switch -c universal-test origin/feature/unified-ai-capture-optin-2026-11-22
```

Reload the unpacked extension in Chrome/Brave, verify version **1.2.0**,
and refresh the ThoughtFlow, Gemini and ChatGPT tabs. Ask one **new**
question on Gemini and then on ChatGPT. Check that at least one Q+A is
captured from each (Notes Ask is a separate test). On DeepSeek or
Copilot, use another new conversation to verify the generic detector.
For an unknown AI site, use the popup's opt-in permission control.

When both tests pass, the PR is ready for review and merge. To return to
the existing main version if needed, run `git switch main`, then reload
the extension. Branch switching may be blocked by uncommitted changes;
do **not** use `git reset --hard`.

### Local regression checks

```bash
node chrome-extension/test/universal-qa-detector.mjs
node chrome-extension/test/universal-capture-pipeline.mjs
node chrome-extension/test/optin-site-registration.mjs
node chrome-extension/test/reload-repairs-ai-tabs.mjs
node chrome-extension/test/notes-port-routing.mjs
node chrome-extension/test/chatgpt-first-turn-baseline.mjs
node chrome-extension/test/notes-answer-capture.mjs
node chrome-extension/test/gemini-clean-capture.mjs
```

If capture fails, send Diagnostics for the **AI chatbot tab**:
`AI detector missing` means scripts are not installed; `msgs=0` or
`pairs=0` suggests DOM extraction failed; `baseline-skip` means the
detected Q+A was treated as old; `send-error`, `direct-dropped` or
`reject` indicate delivery/panel issues. `Connected: Yes` alone is
not evidence of actual message extraction. These events log counts, not
raw private conversation text.

**Scope:** v1.2.0 is a universal detector/connection reliability
foundation. It does not guarantee perfect streaming-duplicate handling
on every website, nor does it make Notes Ask send prompts to all AI services.

---

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
2. Open the extension popup, **Shift-click the purple hexagon logo** (or press
   **Alt+Shift+D** while the popup is focused) to reveal the developer-only
   tools → **Diagnostics** → **Run connection test**.
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

### ChatGPT first message across full page navigation (v1.1.9)

**Symptom:** ChatGPT successfully answers, but ThoughtFlow has no child node
and often logs `scan — msgs=2 pairs=1 streaming=false` followed by
`baseline-skip`. The existing v1.1.7 Send marker was held only in the
ChatGPT content script's JavaScript memory. A full document navigation
from `chatgpt.com/` to `chatgpt.com/c/<id>` destroys that memory.

**Targeted fix:** On a manual ChatGPT Send-button click, Enter, or a
ThoughtFlow Notes **Ask ChatGPT** send, the ChatGPT capture script now
records only a short-lived normalized question fingerprint and timestamp in
the ChatGPT **tab's web sessionStorage**. When the new document loads, it
restores that marker *before* the first baseline scan. Thus only a recent,
matching first Q+A bypasses the old-conversation baseline. On successful
delivery, the marker is removed. The marker expires after two minutes,
is not shared between tabs, and never contains the raw question/answer.

This patch deliberately does **not** modify Gemini selectors, Gemini
capture logic, ThoughtFlow's Notes editor, node tree, or existing background
messaging. The former 1.1.8 release was rolled back; the new release is
numbered 1.1.9 to distinguish it.

Regression check:

```bash
node chrome-extension/test/chatgpt-tab-session-capture.mjs
node chrome-extension/test/chatgpt-first-turn-baseline.mjs
node chrome-extension/test/notes-answer-capture.mjs
```

To verify in Chrome/Brave, merge and pull, reload the unpacked extension,
confirm **v1.1.9**, then refresh ChatGPT and ThoughtFlow (save any unsaved
Notes first). Open a brand new ChatGPT chat, type and submit a new question,
and check that exactly one corresponding node appears after the answer
settles. After that, test Notes **Ask ChatGPT** separately. If the new
ChatGPT tab still fails, inspect Diagnostics for `submission-observed`,
`submission-saved`, `submission-restored`, `baseline-skip`,
`answer-seen`, `send` and `note-answer-captured` before trying
another change. These log lines exclude private Q+A text.

### First ChatGPT question after a new conversation URL change (v1.1.7)

**Bug reproduction:** a user sends the first question from `chatgpt.com/`,
ChatGPT navigates to `/c/<id>`, and the capture engine's first scan of
the new URL already sees `msgs=2 pairs=1 streaming=false`.
The old `baselineDone = false` reset treated the pair as historical,
logged `baseline-skip`, and silently created no node. The same path
could prevent a question sent with the existing Notes **Ask ChatGPT** button
from returning its answer.

**Fix:** the ChatGPT capture engine observes actual Send-button clicks and
Enter submissions before the composer clears. The existing Notes Ask helper
also explicitly marks its submitted question. Only the **last Q+A matching
that recently submitted question** can bypass the first URL baseline scan;
older conversations and unrelated Q+A remain excluded. The intent expires
after two minutes and is never saved to extension storage. Gemini and other
AI providers are unchanged. The content-free `submission-observed q=Nc`
diagnostic indicates that capture saw the Send action.

Run the regression test from the project root:

```bash
node chrome-extension/test/chatgpt-first-turn-baseline.mjs
```

**Browser verification:** merge and pull, reload the unpacked extension and
confirm version **1.1.7**, refresh ChatGPT and ThoughtFlow, open a new ChatGPT
chat, and send a new question with Send or Enter. The first completed Q+A
should create a node after it settles. For Notes Ask, the same Q+A should
instead update the original Note. If the question reaches ChatGPT but the
answer still does not return, collect Diagnostics events from the test
(`submission-observed`, `conversation-switch`, `baseline-skip`,
`answer-seen`, `send`, `note-answer-captured`) rather than retrying
the question repeatedly.

### Diagnostic clues for a partial answer or unmatched Notes request (v1.1.6)

If Diagnostics says `answer-seen q=... a=9c`, then two seconds later
`send`/`direct-ok node created`, then later another much larger answer
for the same question, ChatGPT's streaming state was briefly undetected
and the first answer fragment was accepted too early. ChatGPT now uses a
**minimum 4.5-second unchanged-text window** (other AI services keep
their previous stability setting). This mitigates early fragments; it
is not a guarantee when ChatGPT pauses longer than the window.

For Notes **Ask ChatGPT**, the extension logs these content-free stages:

- `note-job-started`: a Notes request was accepted and associated with
  a ChatGPT tab (the log contains only lengths and a tab ID).
- `note-answer-captured`: a completed Q+A was matched to that request
  and delivered to the original Notes panel.
- `note-qa-loose-match`: the Q+A matched the active Notes request after
  ignoring punctuation/case differences.
- `note-qa-unmatched`: a Q+A came from a ChatGPT tab with an active Notes
  request but did not match its question; the normal capture path still
  applies, and no answer is silently substituted.
- `chatgpt-qa-normal`: a Q+A came through the ordinary capture path
  with no active Notes request in that tab.

These events do **not** log the question/answer text. When troubleshooting,
click Ask **once**, inspect the ChatGPT tab, then inspect the most recent
events in popup **Shift-click purple logo → Diagnostics**. The log now
distinguishes "question was not associated with a Notes job" from "a
matching answer was delivered", so further changes can use evidence.

### Repairing an already-open ChatGPT tab after an extension reload

The Notes Ask feature must have **both** its send script and the ordinary
ChatGPT Q+A capture engine available. Previously the background injected
only `content/chatgpt-ask.js` into older open tabs, leaving
`TF_SELECTORS`/`TFCapture` missing. The question could be sent but the
answer would remain stuck at **Waiting for ChatGPT answer...**.

Version **1.1.5** probes the ISOLATED content-script world and restores
`utils/debug.js`, `content/capture-core.js`,
`content/selectors-chatgpt.js`, and `content/chatgpt.js` when needed,
then starts the Notes Ask script. The capture entry point is guarded to
avoid duplicate capture observers. Selector fallback now checks the
conversation-turn user/assistant markup if the author-role markup is
incomplete.

This also runs before navigation recovery. To confirm that Chrome
actually loaded the fix, check v1.1.5 in the extension manager and
refresh the ThoughtFlow and ChatGPT tabs. If the problem continues,
collect the extension Diagnostics log (Shift-click the purple logo in
the popup) and the ChatGPT DOM selector counts; this identifies whether
the capture engine ran, found Q+A, or failed to deliver it.

### Notes answer delivery through the existing Q+A capture path

The primary way to receive a ChatGPT reply for a Notes **Ask ChatGPT**
request is now the extension's **existing Q+A capture engine**. The same
collector that recognizes ordinary ChatGPT questions and answers now
sends a Notes-originated, completed Q+A to the extension background.
The background matches its pending request using the originating ChatGPT
tab and a fingerprint of the question, then returns only the answer to
the original ThoughtFlow node.

**Do not skip Notes questions inside capture-core.js.** The background
must route them to their existing node instead of making another child.
The separate ChatGPT answer watcher is retained only as a fallback; a
completed request is acknowledged once, even if both routes report it.
A temporary Notes delivery failure is retriable and does not create a
child node.

After merging, reload the unpacked Chrome/Brave extension. Check that
the extension is version **1.1.4** and refresh both the ThoughtFlow and
ChatGPT tabs. Use a *new* test question, since a previous identical
Q+A may already be in the capture deduplication ledger.

From the repository root, run:

```bash
node chrome-extension/test/notes-answer-capture.mjs
```

This regression test checks normal history baselining, Notes question
capture after ChatGPT navigation, same-node answer routing, duplicate
protection, and retry after a temporary Notes-tab failure.

### Navigating to a new ChatGPT conversation

ChatGPT may change its URL (for example from `chatgpt.com/` to
`chatgpt.com/c/<conversation-id>`) just after the extension submits a Notes
question. The old page script can then disappear before its answer monitor
finishes. The extension now retains only a **fingerprint of the question**
and the associated tab/request IDs, and reinstalls its read-only answer watcher
after the tab changes. This resumed watcher **does not resend the question**.

A periodic recovery check also helps if the browser misses the navigation
event. ThoughtFlow reports **"Question sent. Waiting for ChatGPT answer..."**
after the first acknowledgement. An existing unsent ChatGPT draft is never
overwritten. The regular AI capture path suppresses the same Notes question
so it does not generate an extra child node.

If the answer is visible on ChatGPT but never returns to ThoughtFlow, check
that both tabs are open and the extension loaded correctly, then inspect
`brave://extensions` for the expected **v1.1.3** extension. Always inspect
the ChatGPT tab before retrying: a previous question may already be answered.

### ChatGPT replies and Chrome/Brave message ports

The extension acknowledges the Notes **Ask ChatGPT** request immediately,
then sends the completed response in a separate short-lived message.
No extension message port remains open for the entire AI generation time.
The background stores only the request ID and destination tab IDs in
`chrome.storage.session` until delivery or expiry; it does **not** save
questions or answers to storage.

If a request fails or takes too long, check the open ChatGPT tab **before
clicking Ask again**. In particular, a submitted question might already have
an answer there even when the ThoughtFlow tab could not receive it.

Run the regression checks from the repository root:

```bash
node chrome-extension/test/ask-chatgpt-note.mjs
node chrome-extension/test/notes-port-routing.mjs
```

## Ask ChatGPT directly from an existing node's Notes (no API)

This feature uses the SAME Chrome/Brave extension and an already-open,
logged-in ChatGPT tab. It does not create a separate AI page or backend.
It does not send the question to the current ChatGPT conversation unless
that particular conversation is the tab the extension is using.

1. Open ChatGPT in a browser tab and sign in.
2. Open ThoughtFlow, select the node you want to work with, and type a
   question in its existing Notes editor.
3. Press **Ask ChatGPT** on that Notes editor's toolbar.
4. The extension sends the question to the open ChatGPT tab, waits for the
   NEW reply to finish, and appends only the answer below the existing
   question in the **same node's Notes**. No new child node is created.
5. The normal auto-capture for conversations you start in ChatGPT yourself
   still works, but questions sent from Notes are excluded from auto-capture.

Notes:
- The question is shared with the existing logged-in ChatGPT website only
  when the button is clicked. **No OpenAI API key** or separate server is used.
- The ChatGPT composer must be empty (unsent drafts are never overwritten).
- The ChatGPT tab must stay open. A changing ChatGPT UI may break automation;
  the Notes toolbar shows a readable error in that case.
- If a response timed out, **check the ChatGPT tab before clicking again**:
  ChatGPT may have answered even if the extension could not return it.
- The latest response is plain text, escaped for HTML safety and appended
  after a blank line. Existing notes and their formatting are preserved.
- Only the specific selected Note is updated; switching nodes while waiting
  does not redirect the answer to a different node.

## Chrome extension popup

- **Capture** — extension-level switch (website panel is the second switch; both must be ON)
- **Platform** — ChatGPT / Gemini detected from the active tab
- **Direction** — writes to the shared session; applies to future nodes
- **Connection** — API health + storage mode
- **Captured** — number of applied conversations
- **Quick add** — manually add a Q+A pair directly when automatic capture is unavailable
- **Diagnostics / Settings** — hidden in normal use. For troubleshooting, **Shift-click
  the purple hexagon logo** or press **Alt+Shift+D** inside the popup to toggle
  developer tools; use **Close** to hide them again. Their code and controls
  remain available without cluttering the everyday UI.

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
