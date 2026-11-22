// One message-detection interface for every supported/opted-in AI chat.
// Site-specific selectors are optional *hints*, not separate capture engines.
// The shared capture-core.js still owns pairing, streaming, baselining,
// retries, deduplication and delivery to the ThoughtFlow website.
(function () {
  const primary = globalThis.TF_SELECTORS || null;
  const fallback = globalThis.TF_GENERIC_SELECTORS || null;
  if (!primary && !fallback) return;

  const host = String(location.hostname || "").toLowerCase();
  const KNOWN_HOSTS = [
    /(^|\.)chatgpt\.com$/, /^chat\.openai\.com$/,
    /^gemini\.google\.com$/,
    /(^|\.)arena\.ai$/, /(^|\.)lmarena\.ai$/, /^chat\.lmsys\.org$/,
    /(^|\.)grok\.com$/, /(^|\.)x\.ai$/, /^claude\.ai$/,
    /(^|\.)deepseek\.com$/, /(^|\.)perplexity\.ai$/,
    /(^|\.)poe\.com$/, /(^|\.)you\.com$/,
    /^duck\.ai$/, /(^|\.)meta\.ai$/, /^chat\.mistral\.ai$/,
    /^chat\.qwen\.ai$/, /(^|\.)kimi\.com$/, /(^|\.)felo\.ai$/,
    /^chat\.z\.ai$/, /^chat\.minimax\.io$/,
    /^copilot\.microsoft\.com$/,
  ];
  const isKnownHost = KNOWN_HOSTS.some((re) => re.test(host));
  const platform = primary && primary.platform && primary.platform !== "generic"
    ? primary.platform : (fallback && fallback.platform) || "generic";

  function safeRead(adapter) {
    if (!adapter || typeof adapter.collectMessages !== "function") return [];
    try {
      const rows = adapter.collectMessages();
      if (!Array.isArray(rows)) return [];
      return rows.filter((r) =>
        r && (r.role === "user" || r.role === "assistant") &&
        typeof r.text === "string" && r.text.trim().length > 0
      ).map((r) => ({
        role: r.role,
        text: r.text.trim().slice(0, 120000),
        id: typeof r.id === "string" ? r.id : "",
      }));
    } catch (error) {
      try {
        globalThis.TFDebug?.log?.("selector-error", error?.message || "read failed");
      } catch { /* diagnostics optional */ }
      return [];
    }
  }

  function pairCount(rows) {
    let count = 0;
    let question = false;
    for (const m of rows) {
      if (m.role === "user") question = true;
      else if (question && m.role === "assistant") {
        count += 1;
        question = false;
      }
    }
    return count;
  }

  // Choose the highest-confidence usable view of the transcript, rather than
  // accepting the first nonempty selector strategy (which could return only
  // a user message). Preserve Gemini/ChatGPT's precise native text when valid.
  function select() {
    const nativeRows = primary === fallback ? [] : safeRead(primary);
    const genericRows = safeRead(fallback);
    const nativePairs = pairCount(nativeRows);
    const genericPairs = pairCount(genericRows);

    // On an opt-in unknown website, only accept explicit role markers.
    // Blindly assuming arbitrary content blocks alternate user/assistant is
    // unsafe: it can collect unrelated private page text.
    let genericValid = genericPairs > 0;
    if (!isKnownHost && genericValid) {
      try { genericValid = fallback?.probeStrategy?.() === "roles"; }
      catch { genericValid = false; }
    }
    if (nativePairs > 0 && (!genericValid || genericPairs <= nativePairs)) {
      return { rows: nativeRows, mode: "native", pairs: nativePairs };
    }
    if (genericValid) {
      const mode = fallback?.probeStrategy?.() || "fallback";
      return { rows: genericRows, mode: "universal-" + mode, pairs: genericPairs };
    }
    // Preserve an incomplete transcript: the shared engine's MutationObserver
    // will detect the assistant when it appears.
    if (nativeRows.length > 0) return { rows: nativeRows, mode: "native-partial", pairs: 0 };
    return { rows: [], mode: "no-complete-pair", pairs: 0 };
  }

  let last = null;
  function current() {
    // Cached only within the synchronous caller; normal mutation scans
    // rerun selector extraction so streamed answers are never stale.
    last = select();
    return last;
  }

  globalThis.TF_SELECTORS = {
    platform,
    label: primary?.label || fallback?.label || "AI Chat",
    isSupportedPage() {
      const canRead = primary?.isSupportedPage?.() ?? fallback?.isSupportedPage?.();
      return !!canRead;
    },
    getConversationId() {
      const first = primary?.getConversationId?.() || "";
      return first || fallback?.getConversationId?.() || "";
    },
    collectMessages() { return current().rows; },
    probeStrategy() { return last?.mode || current().mode; },
    isStreaming() {
      // Native selectors are most reliable for supported sites. Generic
      // status markers are a fallback for unknown/opted-in chat websites.
      try {
        return !!(primary?.isStreaming?.() || fallback?.isStreaming?.());
      } catch { return false; }
    },
  };
})();
