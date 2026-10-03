// Shared capture engine for the ThoughtFlow AI Capture extension.
// Platform-specific selectors live in selectors-chatgpt.js / selectors-gemini.js;
// this file only handles pairing, streaming/stability detection, baseline
// (no retro-capture), duplicate prevention and sending.
//
// Contract: globalThis.TFCapture.start(selectors) where selectors = {
//   platform: 'chatgpt' | 'gemini',
//   label: 'ChatGPT' | 'Gemini',
//   isSupportedPage(): bool,
//   getConversationId(): string,
//   collectMessages(): [{ role: 'user'|'assistant', text, id }],
//   isStreaming(): bool,
// }

(function () {
  const SCAN_DEBOUNCE_MS = 350;
  const DEFAULT_STABILITY_MS = 2000;
  const SEEN_CAP = 600;

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

    const state = {
      settings: { captureEnabled: true, stabilityMs: DEFAULT_STABILITY_MS },
      seen: new Set(),
      stats: new Map(), // fp -> { lastSig, stableSince }
      convId: null,
      baselineDone: false,
      scanTimer: null,
    };

    // ---- seen list (client-side duplicate guard) ----
    chrome.storage.local.get(["tfSeen"], (r) => {
      (r.tfSeen || []).forEach((f) => state.seen.add(f));
    });

    function remember(fp) {
      state.seen.add(fp);
      chrome.storage.local.set({ tfSeen: Array.from(state.seen).slice(-SEEN_CAP) });
    }

    // ---- settings ----
    chrome.storage.sync.get({ captureEnabled: true, stabilityMs: DEFAULT_STABILITY_MS }, (items) => {
      const wasEnabled = state.settings.captureEnabled;
      state.settings = items;
      if (!wasEnabled && items.captureEnabled) state.baselineDone = false; // re-baseline on enable
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      const before = state.settings.captureEnabled;
      if (changes.captureEnabled) state.settings.captureEnabled = changes.captureEnabled.newValue;
      if (changes.stabilityMs) state.settings.stabilityMs = changes.stabilityMs.newValue || DEFAULT_STABILITY_MS;
      if (before === false && state.settings.captureEnabled) state.baselineDone = false;
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
      return pairs;
    }

    function send(pair, fp, convId) {
      remember(fp);
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
      try {
        chrome.runtime.sendMessage({ type: "TF_TRY_SEND", payload }, () => {
          void chrome.runtime.lastError; // receiver may be asleep; queue handles it
        });
      } catch {
        /* extension reloading */
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
          state.convId = convId;
          state.baselineDone = false;
          state.stats.clear();
        }

        const pairs = collectPairs();
        if (!pairs.length) return;

        const streaming = selectors.isStreaming();
        const enabled = state.settings.captureEnabled;
        const stabilityMs = state.settings.stabilityMs || DEFAULT_STABILITY_MS;
        const now = Date.now();
        const lastIdx = pairs.length - 1;

        pairs.forEach((p, idx) => {
          const fp = pairFingerprint(selectors.platform, state.convId, p);
          if (state.seen.has(fp)) {
            state.stats.delete(fp);
            return;
          }

          // Capture OFF → remember so nothing retro-captures after re-enable.
          if (!enabled) {
            remember(fp);
            return;
          }

          const sig = hash(normalize(p.question) + "\u0001" + normalize(p.answer));
          let st = state.stats.get(fp);
          if (!st || st.lastSig !== sig) {
            st = { lastSig: sig, stableSince: now };
            state.stats.set(fp, st);
          }
          const settled = !streaming && now - st.stableSince >= stabilityMs;

          if (!state.baselineDone) {
            // Baseline: finished pairs already on screen are skipped;
            // an unsettled final pair (answer still rendering) survives
            // and completes normally.
            if (settled || idx !== lastIdx) {
              remember(fp);
              state.stats.delete(fp);
            }
            return;
          }

          if (settled) {
            state.stats.delete(fp);
            send(p, fp, state.convId);
          }
          // else: still streaming or text still changing → wait.
        });

        state.baselineDone = true;
      } catch {
        /* DOM mid-repaint — next mutation rescans */
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
    // Cleared automatically when the page unloads.
    setInterval(tick, 3000);

    tick(); // initial baseline

    // Dev helper — logs only metadata, never conversation content.
    console.info(`[ThoughtFlow Capture] active on ${selectors.label}`);
  }

  globalThis.TFCapture = { start };
})();
