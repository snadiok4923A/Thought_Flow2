// Shared capture engine for the ThoughtFlow AI Capture extension.
// Platform-specific selectors live in selectors-chatgpt.js / selectors-gemini.js;
// this file only handles pairing, streaming/stability detection, baseline
// (no retro-capture), duplicate prevention and sending.
//
// Contract: globalThis.TF_SELECTORS = {
//   platform, label, isSupportedPage(), getConversationId(),
//   collectMessages(): [{role:'user'|'assistant', text, id}],
//   isStreaming(), probeStrategy?()
// }
//
// Diagnostics: every stage logs a short content-free event via TFDebug
// (console + chrome.storage ring buffer → popup "Diagnostics").

(function () {
  const SCAN_DEBOUNCE_MS = 350;
  const DEFAULT_STABILITY_MS = 2000;
  const SEEN_CAP = 600;
  const LIVE_INTENT_TTL_MS = 180000; // user input only, never chat history
  const LIVE_TURN_TTL_MS = 600000; // allow updates to one live answer
  const SUBMISSION_INTENT_TTL_MS = 120000; // for a new ChatGPT conversation URL
  // Web sessionStorage is scoped to this ChatGPT browser tab/origin and lives
  // across full document navigation; unlike JS variables, it survives the
  // transition from / to /c/<id>. Only a question fingerprint is stored.
  const CHATGPT_SEND_SESSION_KEY = "thoughtflow:chatgpt:recent-send:v1";

  function dbg(event, detail) {
    try {
      globalThis.TFDebug.log(event, detail);
    } catch {
      console.info("[ThoughtFlow Capture]", event, detail || "");
    }
  }

  // Non-crypto fingerprint used only for client-side dedupe;
  // the backend re-hashes with SHA-256.
  function hash(str) {
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = ((h1 << 5) + h1) ^ c;
      h2 = ((h2 << 5) + h2) ^ c;
    }
    return (h1 >>> 0).toString(36) + "-" + (h2 >>> 0).toString(36);
  }

  const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Same compact question signature as background.js/chatgpt-ask.js.
  // Used only to match an explicit Notes Ask with its returned Q+A pair.
  function noteQuestionKey(question) {
    const value = normalize(question);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return value.length + ":" + (hash >>> 0).toString(36);
  }

  function isPendingNotesQuestion(question) {
    const plain = normalize(question);
    return !!(
      globalThis.__tfOutboundQuestions?.has(plain) ||
      globalThis.__tfOutboundQuestionKeys?.has(noteQuestionKey(plain))
    );
  }

  // Stable turn identity: the same question at the same position in the same
  // conversation is ONE turn for its whole lifetime. DOM message ids are
  // remounted by the chat UIs and the answer grows while streaming, so neither
  // may be part of the identity — that used to create duplicate nodes and
  // stranded partial answers.
  function pairFingerprint(platform, convId, p) {
    return hash(
      [platform, convId || "", String(p.qOccurrence || 0), normalize(p.question)].join("\u0000")
    );
  }

  function start(selectors) {
    if (!selectors || typeof selectors.collectMessages !== "function") return;
    if (!selectors.isSupportedPage()) return;

    // Cooldown before a *transiently dropped* send (e.g. website panel OFF)
    // may be retried. Tunable for tests / picky users via chrome.storage.sync.
    const SEND_RETRY_COOLDOWN_MS = 30000;
    const retryCooldown = () =>
      Math.max(1000, Number(state.settings.retryCooldownMs) || SEND_RETRY_COOLDOWN_MS);

    const state = {
      settings: { captureEnabled: true, stabilityMs: DEFAULT_STABILITY_MS },
      seen: new Set(),
      stats: new Map(), // fp -> { lastSig, stableSince }
      convId: null,
      baselineDone: false,
      submittedQuestions: [], // explicit ChatGPT send intent, for navigation only
      liveInputs: [], // current tab's typed prompts: hashes + baseline identities only
      liveTurns: new Map(), // only Q+A turns initiated while this capture was active
      oldTurnsLogged: new Set(),
      scanTimer: null,
      lastScanSig: "",
      waitingLogged: new Set(),
      inflight: new Set(), // sends awaiting a server response
      retryAfter: new Map(), // fp -> epoch ms before a dropped send may be retried
      sentAnswers: new Map(), // fp -> answer signature already delivered
      wakeTimer: null, // precise wake-up when the next settle/retry deadline is known
    };

    dbg("content-loaded", selectors.label + " @ " + location.host);

    // ---- seen list (client-side duplicate guard) ----
    chrome.storage.local.get(["tfSeen"], (r) => {
      (r.tfSeen || []).forEach((f) => state.seen.add(f));
      dbg("seen-list-loaded", state.seen.size + " fingerprints");
    });

    function remember(fp) {
      state.seen.add(fp);
      chrome.storage.local.set({ tfSeen: Array.from(state.seen).slice(-SEEN_CAP) });
    }

    // ---- settings ----
    chrome.storage.sync.get(
      { captureEnabled: true, stabilityMs: DEFAULT_STABILITY_MS, retryCooldownMs: SEND_RETRY_COOLDOWN_MS },
      (items) => {
        const wasEnabled = state.settings.captureEnabled;
        state.settings = items;
        dbg("settings", `enabled=${items.captureEnabled} stabilityMs=${items.stabilityMs}`);
        if (!wasEnabled && items.captureEnabled) {
          state.baselineDone = false;
          state.liveInputs = [];
          state.liveTurns.clear();
        } // Never import earlier conversations when capture is re-enabled
      }
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const before = state.settings.captureEnabled;
      if (changes.captureEnabled) state.settings.captureEnabled = changes.captureEnabled.newValue;
      if (changes.stabilityMs) state.settings.stabilityMs = changes.stabilityMs.newValue || DEFAULT_STABILITY_MS;
      if (changes.retryCooldownMs)
        state.settings.retryCooldownMs = changes.retryCooldownMs.newValue || SEND_RETRY_COOLDOWN_MS;
      if (before === false && state.settings.captureEnabled) {
        state.baselineDone = false;
        state.liveInputs = [];
        state.liveTurns.clear();
        state.submittedQuestions = [];
        dbg("settings", "capture re-enabled → live questions only");
      }
    });

    // When ChatGPT sends the FIRST message in a new conversation, it often
    // changes from / to /c/<id> after the user hits Send. The URL switch
    // resets baselineDone; if the first scan sees a completed answer, it is
    // incorrectly treated as old history and silently skipped. Remember
    // only deliberate Send/Enter actions, and permit just the LAST matching
    // Q+A to bypass that initial baseline.
    function submissionKey(value) {
      return normalize(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    }

    // In a new ChatGPT conversation, navigation sometimes replaces the
    // entire document. Without this marker, the new content script sees the
    // first completed Q+A as "old history" and skips it during baselining.
    // A short-lived hash persists across that navigation in this SAME tab.
    function restoreSubmittedQuestion() {
      if (selectors.platform !== "chatgpt") return;
      try {
        const json = sessionStorage.getItem(CHATGPT_SEND_SESSION_KEY);
        if (!json) return;
        const entry = JSON.parse(json);
        const now = Date.now();
        if (!entry || typeof entry.key !== "string" || !entry.key ||
            !Number.isFinite(entry.at) || now < entry.at ||
            now - entry.at >= SUBMISSION_INTENT_TTL_MS ||
            // Reloading the SAME already-open chat is not a live Send.
            // Only / -> /c/<new-id> navigation may recover an outbound Send.
            (typeof entry.fromPath === "string" &&
              entry.fromPath === (location.pathname || "/"))) {
          sessionStorage.removeItem(CHATGPT_SEND_SESSION_KEY);
          return;
        }
        state.submittedQuestions.push({ key: entry.key, at: entry.at });
        dbg("submission-restored", "recent ChatGPT Send across navigation");
      } catch (error) {
        // Browsers with blocked web storage still use the current page's
        // in-memory Send marker, without affecting Gemini or other providers.
        dbg("submission-storage-unavailable", error?.name || "storage");
      }
    }

    function consumeSubmittedQuestion(question) {
      if (selectors.platform !== "chatgpt") return;
      const key = submissionKey(question);
      state.submittedQuestions = state.submittedQuestions.filter((x) => x.key !== key);
      try {
        const raw = sessionStorage.getItem(CHATGPT_SEND_SESSION_KEY);
        const data = raw ? JSON.parse(raw) : null;
        if (data?.key === key) sessionStorage.removeItem(CHATGPT_SEND_SESSION_KEY);
      } catch { /* web storage unavailable */ }
    }

    // Only fresh user-composed questions qualify for automatic capture.
    // Merely opening a historical thread or restoring it after reload cannot
    // authorize captures, even when messages arrive in several DOM batches.
    function registerLiveInput(question) {
      const raw = normalize(question);
      const key = submissionKey(raw);
      if (!state.settings.captureEnabled || !key) return;
      const now = Date.now();
      const { pairs } = collectPairs();
      const known = new Set(pairs.map((p) => pairFingerprint(selectors.platform, state.convId, p)));
      state.liveInputs = state.liveInputs.filter((i) => now - i.at < LIVE_INTENT_TTL_MS);
      state.liveInputs.push({ key, at: now, known });
      if (state.liveInputs.length > 12) state.liveInputs.shift();
    }

    // Same input signal is used on Gemini, ChatGPT, Claude, DeepSeek, etc.
    // Only an ephemeral key is retained in memory, not prompt/answer text.
    if (document.addEventListener) {
      document.addEventListener("input", (event) => {
        const el = event.target?.closest?.(
          'textarea, input:not([type="hidden"]), [contenteditable="true"], [role="textbox"]'
        );
        if (!el) return;
        registerLiveInput(el.value || el.innerText || el.textContent || "");
      }, true);
    }

    function liveTurnEligible(p, fp, idx, lastIdx, now) {
      const acceptedAt = state.liveTurns.get(fp);
      if (acceptedAt && now - acceptedAt <= LIVE_TURN_TTL_MS) return true;
      if (idx !== lastIdx) return false;
      const key = submissionKey(p.question);
      const intent = state.liveInputs.find((i) =>
        i.key === key && now >= i.at && now - i.at < LIVE_INTENT_TTL_MS &&
        !i.known.has(fp)
      );
      if (!intent) return false;
      // One typed question can unlock only ONE new turn. Its answer may
      // continue growing, but history in a different route cannot reuse it.
      state.liveInputs = state.liveInputs.filter((i) => i !== intent);
      for (const [turn, at] of state.liveTurns) {
        if (now - at > LIVE_TURN_TTL_MS || state.liveTurns.size > 64) {
          state.liveTurns.delete(turn);
        }
      }
      state.liveTurns.set(fp, now);
      dbg("live-turn", `q=${p.question.length}c platform=${selectors.platform}`);
      return true;
    }

    function markSubmittedQuestion(question) {
      const raw = normalize(question);
      const key = submissionKey(raw);
      if (!key || selectors.platform !== "chatgpt" || !state.settings.captureEnabled) return;
      registerLiveInput(raw);
      const now = Date.now();
      state.submittedQuestions = state.submittedQuestions
        .filter((item) => now - item.at < SUBMISSION_INTENT_TTL_MS);
      state.submittedQuestions.push({ key, at: now });
      if (state.submittedQuestions.length > 8) state.submittedQuestions.shift();
      dbg("submission-observed", `q=${raw.length}c`);
      try {
        sessionStorage.setItem(CHATGPT_SEND_SESSION_KEY,
          JSON.stringify({ key, at: now, fromPath: location.pathname || "/" }));
        dbg("submission-saved", "fingerprint persisted in this ChatGPT tab");
      } catch (error) {
        dbg("submission-storage-unavailable", error?.name || "storage");
      }
    }

    function isRecentlySubmitted(question, idx, lastIdx, now) {
      if (selectors.platform !== "chatgpt" || idx !== lastIdx) return false;
      const key = submissionKey(question);
      return !!key && state.submittedQuestions.some((item) =>
        item.key === key && now - item.at >= 0 &&
        now - item.at < SUBMISSION_INTENT_TTL_MS
      );
    }

    // User sends a message manually from ChatGPT using the Send button or
    // Enter. Capture BEFORE ChatGPT clears the composer. This also handles
    // Notes-originated requests, which explicitly mark intent before click.
    function readChatGPTComposer() {
      const el = document.querySelector?.(
        '#prompt-textarea, [data-testid="composer-input"], .ProseMirror[contenteditable="true"]'
      );
      return el ? (el.value || el.innerText || el.textContent || "") : "";
    }

    if (selectors.platform === "chatgpt" && document.addEventListener) {
      document.addEventListener("click", (event) => {
        const send = event.target?.closest?.(
          'button[data-testid="send-button"], button[data-testid="composer-send-button"], ' +
          'button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]'
        );
        if (send) markSubmittedQuestion(readChatGPTComposer());
      }, true);
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing ||
            event.altKey || event.ctrlKey || event.metaKey) return;
        const inComposer = event.target?.closest?.(
          '#prompt-textarea, [data-testid="composer-input"], .ProseMirror[contenteditable="true"]'
        );
        if (inComposer) markSubmittedQuestion(readChatGPTComposer());
      }, true);
    }

    // ---- pairing: user → assistant, in document order ----
    // One assistant reply can be rendered as several rows (a markdown body plus
    // a separate code block, or a turn re-mounted in parts). Keeping only the
    // last row truncated the saved answer — merge the rows instead.
    function mergeAssistantText(previous, next) {
      const aRaw = String(previous || "");
      const bRaw = String(next || "");
      if (!aRaw.trim()) return bRaw;
      if (!bRaw.trim()) return aRaw;
      const a = aRaw.trim();
      const b = bRaw.trim();
      if (a === b) return aRaw;
      if (a.includes(b)) return aRaw; // shorter re-render of the same body
      if (b.includes(a)) return bRaw; // the same body grew in place
      return a + "\n\n" + b; // reply split across containers
    }

    function collectPairs() {
      const msgs = selectors.collectMessages().filter((m) => m && m.text);
      const pairs = [];
      // Occurrence of an identical question within the conversation keeps
      // repeated questions separate while staying stable under virtualization.
      const occurrences = new Map();
      let cur = null;
      const finish = () => {
        if (cur && cur.question && cur.answer) pairs.push(cur);
        cur = null;
      };
      for (const m of msgs) {
        if (m.role === "user") {
          finish();
          const qKey = normalize(m.text).toLowerCase();
          const occurrence = occurrences.get(qKey) || 0;
          occurrences.set(qKey, occurrence + 1);
          cur = { question: m.text, qid: m.id || "", answer: "", aid: "", qOccurrence: occurrence };
        } else if (m.role === "assistant" && cur) {
          cur.answer = mergeAssistantText(cur.answer, m.text);
          cur.aid = m.id || "";
        }
      }
      finish();
      return { pairs, msgCount: msgs.length };
    }

    function send(pair, fp, convId) {
      // Never mark a pair as "seen" before the server durably accepts (or
      // queues, or definitively rejects) it — otherwise a transient drop
      // (website panel OFF, network blip) would lose the answer forever.
      state.inflight.add(fp);
      const settle = (resp) => {
        state.inflight.delete(fp);
        const err = chrome.runtime.lastError;
        if (err) {
          remember(fp);
          dbg("live-drop", (err.message || "runtime error") + " — no backlog retry");
          return;
        }
        if (!resp) {
          remember(fp);
          dbg("live-drop", "background did not respond — no backlog retry");
          return;
        }
        if (resp.drop) {
          if (resp.reason === "auth" || resp.reason === "invalid") {
            // Permanent (bad token / bad payload) — never retry, but don't loop either.
            remember(fp);
            dbg("send-dropped", `${resp.reason} (permanent — not retrying)`);
          } else {
            // Live-only: do not replay this answer when the panel/browser
            // becomes available much later. The old content is never queued.
            remember(fp);
            dbg("live-drop", (resp.reason || "unavailable") + " — no backlog retry");
          }
          return;
        }
        remember(fp);
        state.sentAnswers.set(fp, hash(normalize(pair.answer)));
        consumeSubmittedQuestion(pair.question);
        if (resp.queued) dbg("send-ok", "queued (API offline)");
        else if (resp.duplicate) dbg("send-ok", "duplicate");
        else dbg("send-ok", "accepted");
      };
      const payload = {
        source: selectors.platform,
        conversationId: convId || "",
        question: pair.question,
        answer: pair.answer,
        messageIds: [pair.qid, pair.aid].filter(Boolean),
        fingerprint: fp,
        // direction + parentNodeId are intentionally omitted: the server fills
        // them from the website session (panel/popup), which owns that state.
      };
      dbg("send", `q=${pair.question.length}c a=${pair.answer.length}c fp=${fp}`);
      try {
        chrome.runtime.sendMessage({ type: "TF_TRY_SEND", payload }, settle);
      } catch {
        state.inflight.delete(fp);
        remember(fp);
        dbg("live-drop", "extension reloading — no backlog retry");
      }
    }

    function tick() {
      try {
        if (!selectors.isSupportedPage()) return;

        // Conversation switch (or first load) → baseline the existing thread so
        // old conversations are never retro-captured.
        const convId = selectors.getConversationId() || "";
        if (state.convId === null) {
          state.convId = convId;
          state.baselineDone = false;
        } else if (convId !== state.convId) {
          dbg("conversation-switch", (state.convId || "(new)") + " → " + (convId || "(new)"));
          state.convId = convId;
          state.baselineDone = false;
          state.stats.clear();
          state.sentAnswers.clear();
          state.liveTurns.clear();
          state.oldTurnsLogged.clear();
        }

        const { pairs, msgCount } = collectPairs();
        const streaming = selectors.isStreaming();
        const enabled = state.settings.captureEnabled;
        // ChatGPT can pause between streamed sections (including code
        // blocks), and the stop indicator may disappear briefly. Do not
        // capture a tiny early fragment while the full answer is pending.
        // Gemini and other platforms keep their existing settings.
        const baseStabilityMs = state.settings.stabilityMs || DEFAULT_STABILITY_MS;
        const stabilityMs = selectors.platform === "chatgpt"
          ? Math.max(8000, baseStabilityMs)
          : baseStabilityMs;
        const now = Date.now();

        // Throttled scan heartbeat — only when the observable state changes.
        const strategy = selectors.probeStrategy ? selectors.probeStrategy() : "-";
        const scanSig = `${msgCount}|${pairs.length}|${streaming}|${enabled}|${strategy}`;
        if (scanSig !== state.lastScanSig) {
          state.lastScanSig = scanSig;
          dbg("scan", `msgs=${msgCount} pairs=${pairs.length} streaming=${streaming} capture=${enabled} strategy=${strategy}`);
        }

        // An empty conversation has no existing Q+A pairs to baseline.
        // Without this, the first newly completed exchange is lost.
        if (!pairs.length) {
          state.baselineDone = true;
          return;
        }

        const lastIdx = pairs.length - 1;

        pairs.forEach((p, idx) => {
          // A common ChatGPT false-positive is a one-word assistant fragment
          // that merely echoes the question ("Another" → "another") while
          // a multi-part response is still rendering. Don't mark it seen,
          // and don't create a node until meaningful assistant text appears.
          if (selectors.platform === "chatgpt" &&
              normalize(p.question).toLowerCase() === normalize(p.answer).toLowerCase() &&
              p.answer.length <= 160) {
            dbg("answer-echo-wait", `q=${p.question.length}c a=${p.answer.length}c`);
            return;
          }
          const fp = pairFingerprint(selectors.platform, state.convId, p);
          // Do NOT discard questions originating in Notes. They must go
          // through the normal, proven Q+A collector. The background router
          // recognizes this explicit Notes question and routes its answer
          // BACK to the existing Notes editor instead of making a child node.
          const pendingNote = selectors.platform === "chatgpt" &&
            isPendingNotesQuestion(p.question);
          const submittedNow = isRecentlySubmitted(p.question, idx, lastIdx, now);
          const fpWasLive = state.liveTurns.has(fp);
          const live = pendingNote || submittedNow ||
            liveTurnEligible(p, fp, idx, lastIdx, now);
          if (!enabled && !pendingNote) return;
          if (!live) {
            if (idx === lastIdx && !state.oldTurnsLogged.has(fp)) {
              state.oldTurnsLogged.add(fp);
              dbg("history-ignored", `q=${p.question.length}c — no live input`);
            }
            return; // do not store or retry historical Q+A
          }
          if (!fpWasLive) state.liveTurns.set(fp, now);
          const answerSig = hash(normalize(p.answer));
          const sentSig = state.sentAnswers.get(fp);
          if (state.seen.has(fp)) {
            // An answer that grew after an earlier capture is the SAME turn,
            // not a new one: resend it (once settled) so the app updates its
            // existing node rather than creating a duplicate.
            if (!sentSig || sentSig === answerSig) {
              state.stats.delete(fp);
              return;
            }
          }
          // A send is already in flight for this pair — wait for its response.
          if (state.inflight.has(fp)) return;
          // Last attempt dropped (transient) — wait for the cooldown to expire.
          const retryAt = state.retryAfter.get(fp);
          if (retryAt && now < retryAt) return;
          if (retryAt && now >= retryAt) state.retryAfter.delete(fp);

          // Capture OFF blocks normal auto-capture, but a deliberate Ask
          // ChatGPT button press must still return its answer to that Note.
          if (!enabled && !pendingNote) {
            remember(fp);
            dbg("skipped-off", `q=${p.question.length}c`);
            return;
          }

          const sig = hash(normalize(p.question) + "\u0001" + normalize(p.answer));
          let st = state.stats.get(fp);
          if (!st || st.lastSig !== sig) {
            const first = !st;
            st = { lastSig: sig, stableSince: now };
            state.stats.set(fp, st);
            if (first && p.answer) {
              dbg("answer-seen", `q=${p.question.length}c a=${p.answer.length}c (waiting for completion)`);
            }
          }

          // Settled = text unchanged for stabilityMs AND (not streaming OR
          // text static for 3× stabilityMs — a stuck streaming indicator
          // can never block capture forever).
          const stableFor = now - st.stableSince;
          const settledByTime = stableFor >= stabilityMs;
          const stuckStreaming = streaming && stableFor >= stabilityMs * 3;
          const settled = settledByTime && (!streaming || stuckStreaming);

          // A freshly typed question is the ONLY automatic exception to the
          // conversation baseline. Streaming old history does not count as live.
          if (!state.baselineDone && !live) return;

          if (settled) {
            state.stats.delete(fp);
            if (streaming && stuckStreaming) dbg("streaming-override", "indicator stuck — text static, capturing");
            send(p, fp, state.convId);
          }
          // else: still streaming or text still changing → wait.
        });

        state.baselineDone = true;

        // Wake the scanner exactly when the least-settled pair (or the next
        // cooldown-retry) could be due — instead of waiting for the next
        // random DOM mutation or the 3 s safety interval on a quiet page.
        let wakeIn = Infinity;
        for (const st of state.stats.values()) {
          const remaining = st.stableSince + stabilityMs - now;
          if (remaining < wakeIn) wakeIn = remaining;
        }
        for (const t of state.retryAfter.values()) {
          const remaining = t - now;
          if (remaining >= 0 && remaining < wakeIn) wakeIn = remaining;
        }
        if (Number.isFinite(wakeIn)) {
          const delay = Math.max(60, Math.min(wakeIn + 40, 4000));
          if (state.wakeTimer) clearTimeout(state.wakeTimer);
          state.wakeTimer = setTimeout(() => {
            state.wakeTimer = null;
            tick();
          }, delay);
        }
      } catch (e) {
        dbg("scan-error", (e && e.message) || "DOM error");
      }
    }

    function schedule() {
      if (state.scanTimer) clearTimeout(state.scanTimer);
      state.scanTimer = setTimeout(() => {
        state.scanTimer = null;
        tick();
      }, SCAN_DEBOUNCE_MS);
    }

    // When ChatGPT navigates to a new conversation, the initial scan may
    // have treated a newly answered question as existing history. The
    // background sends the pending question signature on navigation, so
    // unlock ONLY that Q+A pair for a normal settled capture scan.
    globalThis.TFCapture.allowPendingNoteQuestion = (key) => {
      if (typeof key !== "string" || !/^[0-9]+:[a-z0-9]+$/.test(key)) return;
      const keys = globalThis.__tfOutboundQuestionKeys || new Set();
      globalThis.__tfOutboundQuestionKeys = keys;
      keys.add(key);
      const { pairs } = collectPairs();
      // Only the very latest completed exchange can be the question just
      // submitted from Notes. Older identical questions remain baselined.
      const pair = pairs[pairs.length - 1];
      if (pair && noteQuestionKey(pair.question) === key) {
        const fp = pairFingerprint(selectors.platform, state.convId, pair);
        state.seen.delete(fp);
        state.stats.delete(fp);
        state.retryAfter.delete(fp);
      }
      schedule();
    };

    // A click from the Notes Ask helper uses the same protection as a
    // user clicking Send in ChatGPT. Do not allow a normal reload to import
    // an entire existing conversation.
    globalThis.TFCapture.markSubmittedQuestion = markSubmittedQuestion;

    // Restore before the very first scan, so an already-complete first
    // exchange on the new ChatGPT document is not treated as history.
    restoreSubmittedQuestion();

    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Periodic safety scan (catches streamed text updates outside mutations).
    setInterval(tick, 3000);

    tick(); // initial baseline
  }

  globalThis.TFCapture = { start };
})();
