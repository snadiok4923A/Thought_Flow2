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
  const SUBMISSION_INTENT_TTL_MS = 120000; // for a new ChatGPT conversation URL

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

  function pairFingerprint(platform, convId, p) {
    return hash(
      [platform, convId || "", p.qid || "", p.aid || "", normalize(p.question), normalize(p.answer)].join("\u0000")
    );
  }

  // Stable across a streaming response's many partial versions. Unlike the
  // delivery fingerprint, it intentionally excludes the assistant text.
  // Distinct repeated questions in one chat have distinct turn indices.
  function turnFingerprint(platform, convId, p, index) {
    return hash([platform, convId || "", index, normalize(p.question)].join("\u0000"));
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
      submittedQuestions: [], // local intent only; never persisted or auto-imported
      scanTimer: null,
      lastScanSig: "",
      waitingLogged: new Set(),
      inflight: new Set(), // sends awaiting a server response
      retryAfter: new Map(), // fp -> epoch ms before a dropped send may be retried
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
        if (!wasEnabled && items.captureEnabled) state.baselineDone = false; // re-baseline on enable
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
        dbg("settings", "capture re-enabled → baseline");
      }
    });

    // When ChatGPT sends the FIRST message in a new conversation, it often
    // changes from / to /c/<id> after the user hits Send. The URL switch
    // resets baselineDone; if the first scan sees a completed answer, it is
    // incorrectly treated as old history and silently skipped. Remember
    // only deliberate Send/Enter actions, and permit just the LAST matching
    // Q+A to bypass that initial baseline.
    function submissionKey(value) {
      const normalized = normalize(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      if (!normalized) return "";
      let hash = 2166136261;
      for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return normalized.length + ":" + (hash >>> 0).toString(36);
    }

    function markSubmittedQuestion(question) {
      const raw = normalize(question);
      const key = submissionKey(raw);
      if (!key || selectors.platform !== "chatgpt") return;
      const now = Date.now();
      state.submittedQuestions = state.submittedQuestions
        .filter((item) => now - item.at < SUBMISSION_INTENT_TTL_MS);
      state.submittedQuestions.push({ key, at: now });
      if (state.submittedQuestions.length > 8) state.submittedQuestions.shift();
      dbg("submission-observed", `q=${raw.length}c`);
      // The page can reload while ChatGPT creates /c/<id>. Persist only the
      // key in MV3 session storage, not the question text.
      try {
        chrome.runtime.sendMessage({ type: "TF_CHATGPT_SUBMISSION", key }, () => {
          void chrome.runtime.lastError;
        });
      } catch { /* normal local marker still covers SPA navigation */ }
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
    function collectPairs() {
      const msgs = selectors.collectMessages().filter((m) => m && m.text);
      const pairs = [];
      let cur = null;
      for (const m of msgs) {
        if (m.role === "user") {
          if (cur && cur.question && cur.answer) pairs.push(cur);
          cur = { question: m.text, qid: m.id || "", answer: "", aid: "" };
        } else if (m.role === "assistant" && cur) {
          cur.answer = m.text;
          cur.aid = m.id || "";
        }
      }
      if (cur && cur.question && cur.answer) pairs.push(cur);
      return { pairs, msgCount: msgs.length };
    }

    function send(pair, fp, convId, turnKey) {
      // Never mark a pair as "seen" before the server durably accepts (or
      // queues, or definitively rejects) it — otherwise a transient drop
      // (website panel OFF, network blip) would lose the answer forever.
      state.inflight.add(fp);
      const settle = (resp) => {
        state.inflight.delete(fp);
        const err = chrome.runtime.lastError;
        if (err) {
          state.retryAfter.set(fp, Date.now() + retryCooldown());
          dbg("send-error", err.message || "runtime error");
          return;
        }
        if (!resp) {
          state.retryAfter.set(fp, Date.now() + retryCooldown());
          dbg("send-error", "no response from background");
          return;
        }
        if (resp.drop) {
          if (resp.reason === "auth" || resp.reason === "invalid") {
            // Permanent (bad token / bad payload) — never retry, but don't loop either.
            remember(fp);
            dbg("send-dropped", `${resp.reason} (permanent — not retrying)`);
          } else {
            // Transient (e.g. website panel OFF) — do NOT remember; retry after cooldown.
            state.retryAfter.set(fp, Date.now() + retryCooldown());
            dbg("send-dropped", resp.reason || "unknown");
          }
          return;
        }
        remember(fp);
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
        turnKey,
        // direction + parentNodeId are intentionally omitted: the server fills
        // them from the website session (panel/popup), which owns that state.
      };
      dbg("send", `q=${pair.question.length}c a=${pair.answer.length}c fp=${fp}`);
      try {
        chrome.runtime.sendMessage({ type: "TF_TRY_SEND", payload }, settle);
      } catch {
        state.inflight.delete(fp);
        state.retryAfter.set(fp, Date.now() + retryCooldown());
        dbg("send-error", "extension reloading (context invalidated)");
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
        }

        const { pairs, msgCount } = collectPairs();
        const streaming = selectors.isStreaming();
        const enabled = state.settings.captureEnabled;
        // ChatGPT may briefly show a tiny partial reply while its streaming
        // control disappears/reappears. A 2-second pause was enough to send a
        // 9-character fragment, then a second 973-character "answer" as a new
        // node. Keep Gemini and other platforms at their existing settings.
        const baseStabilityMs = state.settings.stabilityMs || DEFAULT_STABILITY_MS;
        const stabilityMs = selectors.platform === "chatgpt"
          ? Math.max(4500, baseStabilityMs)
          : selectors.platform === "gemini"
            ? Math.max(5500, baseStabilityMs)
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
          const fp = pairFingerprint(selectors.platform, state.convId, p);
          const turnKey = turnFingerprint(selectors.platform, state.convId, p, idx);
          // Do NOT discard questions originating in Notes. They must go
          // through the normal, proven Q+A collector. The background router
          // recognizes this explicit Notes question and routes its answer
          // BACK to the existing Notes editor instead of making a child node.
          const pendingNote = selectors.platform === "chatgpt" &&
            isPendingNotesQuestion(p.question);
          const submittedNow = isRecentlySubmitted(p.question, idx, lastIdx, now);
          if (state.seen.has(fp)) {
            state.stats.delete(turnKey);
            return;
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
          let st = state.stats.get(turnKey);
          if (!st || st.lastSig !== sig) {
            const first = !st;
            st = { lastSig: sig, stableSince: now };
            state.stats.set(turnKey, st);
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

          if (!state.baselineDone && !pendingNote && !submittedNow) {
            // Baseline: every finished pair already on screen is skipped so
            // old conversations NEVER retro-capture. Only the last pair of a
            // conversation that is ACTIVELY STREAMING survives (an in-flight
            // answer completes normally once it finishes).
            const inFlight = streaming && idx === lastIdx;
            if (!inFlight) {
              remember(fp);
              state.stats.delete(turnKey);
              dbg("baseline-skip", `q=${p.question.length}c`);
            }
            return;
          }

          if (settled) {
            state.stats.delete(turnKey);
            if (streaming && stuckStreaming) dbg("streaming-override", "indicator stuck — text static, capturing");
            send(p, fp, state.convId, turnKey);
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
        const turnKey = turnFingerprint(selectors.platform, state.convId, pair, pairs.length - 1);
        state.seen.delete(fp);
        state.stats.delete(turnKey);
        state.retryAfter.delete(fp);
      }
      schedule();
    };

    // A click from the Notes Ask helper uses the same protection as a
    // user clicking Send in ChatGPT. Do not allow a normal reload to import
    // an entire existing conversation.
    globalThis.TFCapture.markSubmittedQuestion = markSubmittedQuestion;

    // A full ChatGPT document replacement destroys local variables. Rehydrate
    // the latest explicitly submitted question from the background worker.
    // If it already got baseline-skipped while loading, unlock only its
    // last matching Q+A and rescan. Never import unrelated old messages.
    if (selectors.platform === "chatgpt") {
      try {
        chrome.runtime.sendMessage({ type: "TF_CHATGPT_SUBMISSION_GET" }, (result) => {
          if (chrome.runtime.lastError || !result?.key ||
              typeof result.at !== "number" ||
              Date.now() - result.at > SUBMISSION_INTENT_TTL_MS) return;
          state.submittedQuestions.push({ key: result.key, at: result.at });
          const { pairs } = collectPairs();
          const index = pairs.length - 1;
          const latest = pairs[index];
          if (latest && submissionKey(latest.question) === result.key) {
            const fp = pairFingerprint(selectors.platform, state.convId, latest);
            state.seen.delete(fp);
            state.stats.delete(turnFingerprint(selectors.platform, state.convId, latest, index));
            dbg("submission-unlocked", `q=${latest.question.length}c`);
          }
          schedule();
        });
      } catch { /* ignore if extension was reloaded */ }
    }

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
