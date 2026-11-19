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

  function pairFingerprint(platform, convId, p) {
    return hash(
      [platform, convId || "", p.qid || "", p.aid || "", normalize(p.question), normalize(p.answer)].join("\u0000")
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

    function send(pair, fp, convId) {
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
        const stabilityMs = state.settings.stabilityMs || DEFAULT_STABILITY_MS;
        const now = Date.now();

        // Throttled scan heartbeat — only when the observable state changes.
        const strategy = selectors.probeStrategy ? selectors.probeStrategy() : "-";
        const scanSig = `${msgCount}|${pairs.length}|${streaming}|${enabled}|${strategy}`;
        if (scanSig !== state.lastScanSig) {
          state.lastScanSig = scanSig;
          dbg("scan", `msgs=${msgCount} pairs=${pairs.length} streaming=${streaming} capture=${enabled} strategy=${strategy}`);
        }

        if (!pairs.length) return;

        const lastIdx = pairs.length - 1;

        pairs.forEach((p, idx) => {
          const fp = pairFingerprint(selectors.platform, state.convId, p);
          if (state.seen.has(fp)) {
            state.stats.delete(fp);
            return;
          }
          // A send is already in flight for this pair — wait for its response.
          if (state.inflight.has(fp)) return;
          // Last attempt dropped (transient) — wait for the cooldown to expire.
          const retryAt = state.retryAfter.get(fp);
          if (retryAt && now < retryAt) return;
          if (retryAt && now >= retryAt) state.retryAfter.delete(fp);

          // Capture OFF → remember so nothing retro-captures after re-enable.
          if (!enabled) {
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

          if (!state.baselineDone) {
            // Baseline: every finished pair already on screen is skipped so
            // old conversations NEVER retro-capture. Only the last pair of a
            // conversation that is ACTIVELY STREAMING survives (an in-flight
            // answer completes normally once it finishes).
            const inFlight = streaming && idx === lastIdx;
            if (!inFlight) {
              remember(fp);
              state.stats.delete(fp);
              dbg("baseline-skip", `q=${p.question.length}c`);
            }
            return;
          }

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
