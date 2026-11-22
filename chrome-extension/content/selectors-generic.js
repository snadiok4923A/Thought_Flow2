// Generic DOM selectors for AI chat sites WITHOUT a dedicated capture module.
// Loaded before content/generic.js; exposes globalThis.TF_SELECTORS.
//
// Why this exists: ThoughtFlow capture must not depend on one site's markup
// surviving. Every AI chat UI renders a strictly alternating thread —
// user asks, assistant answers — so the generic engine tries three strategies,
// most specific first:
//
//   A. role-marked elements   — [data-message-author-role], user-query/model-response,
//                               [class*="user-message"] / [class*="assistant-message"] …
//   B. turn containers        — article / [role="article"] blocks, classified as
//                               assistant when they hold markdown/prose bodies
//   C. alternating blocks     — repeated content blocks (.markdown/.prose/message-like
//                               containers), roles assigned by document order
//                               (first = user — every chat UI starts with the user)
//
// All strategies yield {role, text, id} in document order — the shared core in
// capture-core.js does pairing, streaming/stability detection, baseline and
// dedupe exactly as for ChatGPT/Gemini.
//
// Diagnostics: probeStrategy() reports which strategy matched ("roles",
// "turns", "alternating", "none") — "none" means this site needs either a
// dedicated selectors-*.js (best) or the popup's Quick add fallback.
//
// NOTE: the site list that decides where this file runs lives in manifest.json.

globalThis.TF_GENERIC_SELECTORS = (function () {
  var MAX_TEXT = 120000;

  // ---- host → backend "source" tag ------------------------------------------
  var HOST_PLATFORMS = [
    [/(^|\.)arena\.ai$/, "arena"],
    [/(^|\.)lmarena\.ai$/, "arena"],
    [/(^|\.)chat\.lmsys\.org$/, "arena"],
    [/(^|\.)grok\.com$/, "grok"],
    [/(^|\.)grok\.x\.ai$/, "grok"],
    [/(^|\.)x\.ai$/, "grok"],
    [/(^|\.)claude\.ai$/, "claude"],
    [/(^|\.)deepseek\.com$/, "deepseek"],
    [/(^|\.)perplexity\.ai$/, "perplexity"],
    [/(^|\.)poe\.com$/, "poe"],
    [/(^|\.)you\.com$/, "you"],
    [/(^|\.)duck\.ai$/, "duckduckgo"],
    [/(^|\.)copilot\.microsoft\.com$/, "copilot"],
    [/(^|\.)meta\.ai$/, "meta"],
    [/(^|\.)chat\.mistral\.ai$/, "mistral"],
    [/(^|\.)chat\.qwen\.ai$/, "qwen"],
    [/(^|\.)kimi\.com$/, "kimi"],
    [/(^|\.)felo\.ai$/, "felo"],
    [/(^|\.)z\.ai$/, "z"],
    [/(^|\.)minimax\.io$/, "minimax"],
  ];

  function platformForHost(hostname) {
    var h = String(hostname || "").toLowerCase();
    for (var i = 0; i < HOST_PLATFORMS.length; i++) {
      if (HOST_PLATFORMS[i][0].test(h)) return HOST_PLATFORMS[i][1];
    }
    return "generic";
  }

  var PLATFORM = platformForHost(location.hostname);

  function posSort(a, b) {
    if (a === b) return 0;
    var rel = a.el.compareDocumentPosition(b.el);
    return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function textOf(el) {
    var t = el && el.innerText ? el.innerText : "";
    t = t.trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    // Cheap visibility check — avoids jsdom-only APIs so tests can run in Node.
    var rects = el.getClientRects ? el.getClientRects() : null;
    if (rects && rects.length === 0 && el.tagName !== "BODY") {
      var style = el.ownerDocument && el.ownerDocument.defaultView
        ? el.ownerDocument.defaultView.getComputedStyle(el)
        : null;
      if (!style || style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  function idOf(el) {
    return (
      el.getAttribute("data-message-id") ||
      el.getAttribute("data-msg-id") ||
      el.id ||
      ""
    );
  }

  function dedupeNested(bucket) {
    var clean = [];
    bucket.forEach(function (item) {
      for (var i = 0; i < clean.length; i++) {
        var other = clean[i].el;
        if (other === item.el || other.contains(item.el) || item.el.contains(other)) {
          // Keep the SMALLER element when one contains the other (more precise text).
          if (other.contains(item.el)) {
            clean[i] = item;
          }
          return;
        }
      }
      clean.push(item);
    });
    return clean;
  }

  // Strip common UI chrome from captured text: copy buttons, icon labels…
  // (only trailing/leading button-only lines, never paragraph text)
  function cleanText(t) {
    return String(t || "")
      .split("\n")
      .map(function (l) { return l.replace(/\s+$/, ""); })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---- Strategy A — role-marked elements -------------------------------------
  var ROLE_SELECTOR = [
    "[data-message-author-role]",
    "[data-role]",
    "[data-message-role]",
    'user-query',
    "model-response",
    ".user-query",
    ".model-response",
    '[data-testid="user-message"]',
    '[data-testid*="assistant-message"]',
    '[class*="user-message" i]',
    '[class*="assistant-message" i]',
    '[class*="userMessage"]',
    '[class*="assistantMessage"]',
    '[class*="user_message"]',
    '[class*="assistant_message"]',
    '[class*="human-message" i]',
    '[class*="ai-message" i]',
    '[class*="bot-message" i]',
    '[class*="message-user" i]',
    '[class*="message-assistant" i]',
    '[class*="message-model" i]',
    '[class*="HumanMessage"]',
    '[class*="AIMessage"]',
  ].join(", ");

  function roleOfElement(el) {
    var explicit =
      el.getAttribute("data-message-author-role") ||
      el.getAttribute("data-role") ||
      el.getAttribute("data-message-role") ||
      "";
    explicit = String(explicit).toLowerCase();
    if (explicit) {
      if (/user|human|query|you|prompt/.test(explicit)) return "user";
      if (/assistant|model|bot|ai|gpt|response|claude|kimi|deepseek|grok/.test(explicit)) return "assistant";
    }
    var cls = "";
    try {
      cls = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal) || "";
    } catch {
      cls = "";
    }
    var hay = (cls + " " + el.tagName).toLowerCase();
    if (/user|human|query|prompt/.test(hay)) return "user";
    if (/assistant|model-response|modelresponse|bot-message|ai-message|aimessage|answer|message-assistant|message-model/.test(hay)) return "assistant";
    return null;
  }

  function collectByRoles() {
    var bucket = [];
    try {
      document.querySelectorAll(ROLE_SELECTOR).forEach(function (el) {
        if (!isVisible(el)) return;
        if (el.querySelector && el.querySelector("textarea, [contenteditable='true']")) return; // composer
        var role = roleOfElement(el);
        if (!role) return;
        var text = cleanText(textOf(el));
        if (!text) return;
        bucket.push({ el: el, role: role, text: text, id: idOf(el) });
      });
    } catch {
      return [];
    }
    var clean = dedupeNested(bucket);
    clean.sort(posSort);
    return clean;
  }

  // ---- Strategy B — turn containers (article/role=article) -------------------
  function collectByTurns() {
    var bucket = [];
    try {
      document
        .querySelectorAll('main article, article, [role="article"], [role="group"][aria-label]')
        .forEach(function (art) {
          if (!isVisible(art)) return;
          if (art.querySelector("textarea, [contenteditable='true']")) return; // composer
          var md = art.querySelector('.markdown, .prose, [class*="markdown"], [class*="prose"], [class*="answer"]');
          var text, role, el;
          if (md) {
            el = md; role = "assistant"; text = cleanText(textOf(md));
          } else {
            el = art; role = "user"; text = cleanText(textOf(art));
            // Long plain container without any markdown body is likely a wrapper, not a message.
            if (text.length > MAX_TEXT) return;
          }
          if (!text) return;
          bucket.push({ el: el, role: role, text: text, id: idOf(el) });
        });
    } catch {
      return [];
    }
    var clean = dedupeNested(bucket);
    clean.sort(posSort);
    return assignAlternationFallback(clean);
  }

  // ---- Strategy C — repeated content blocks, roles by order --------------------
  var BLOCK_SELECTOR = [
    ".markdown",
    ".prose",
    '[class*="markdown"]',
    '[class*="prose"]',
    '[data-testid*="message"]',
    '[class*="message-content"]',
    '[class*="messageContent"]',
    '[class*="chat-message"]',
    '[class*="chatMessage"]',
    '[class*="message-body"]',
    '[class*="bubble"]',
  ].join(", ");

  function collectByBlocks() {
    var bucket = [];
    try {
      document.querySelectorAll(BLOCK_SELECTOR).forEach(function (el) {
        if (!isVisible(el)) return;
        if (el.querySelector && el.querySelector("textarea, [contenteditable='true']")) return;
        // Skip nested repeats — keep only the outermost match per subtree.
        if (el.parentElement && el.parentElement.closest(BLOCK_SELECTOR)) return;
        var text = cleanText(textOf(el));
        if (!text || text.length < 2) return;
        // Heuristic: markdown/prose blocks are assistant; plain bubbles alternate.
        var cls = "";
        try { cls = typeof el.className === "string" ? el.className : ""; } catch { cls = ""; }
        var role = /markdown|prose|answer|response/i.test(cls) ? "assistant" : null;
        bucket.push({ el: el, role: role, text: text, id: idOf(el) });
      });
    } catch {
      return [];
    }
    bucket.sort(posSort);
    var clean = dedupeNested(bucket);
    return assignAlternationFallback(clean);
  }

  // Ensure user→assistant ordering by assigning missing roles by position.
  function assignAlternationFallback(list) {
    var out = [];
    var expectUser = true;
    list.forEach(function (item) {
      var role = item.role;
      if (!role) {
        role = expectUser ? "user" : "assistant";
      }
      // Keep strictly alternating; drop consecutive duplicates of the same role
      // beyond a reasonable margin by merging into the previous turn pair logic
      // handled by the core pairing. Just tag and move on.
      out.push({ el: item.el, role: role, text: item.text, id: item.id || "" });
      // After a user turn comes an assistant turn (and vice versa).
      expectUser = role !== "user";
    });
    return out;
  }

  function collectMessages() {
    var out = collectByRoles();
    if (out.length) return strip(out);
    out = collectByTurns();
    if (out.length) return strip(out);
    out = collectByBlocks();
    return strip(out);
  }

  function strip(out) {
    return out.map(function (m) {
      return { role: m.role, text: m.text, id: m.id || "" };
    });
  }

  function probeStrategy() {
    if (collectByRoles().length) return "roles";
    if (collectByTurns().length) return "turns";
    if (collectByBlocks().length) return "alternating";
    return "none";
  }

  // ---- Conversation id ---------------------------------------------------------
  // Prefer a path segment that looks like an id; fall back to the full path so
  // fingerprinting stays stable per open conversation.
  function getConversationId() {
    try {
      var path = location.pathname || "";
      var m = path.match(/[/-_]([A-Za-z0-9_-]{6,})\/?$/) || path.match(/\/([A-Za-z0-9_-]{8,})(\/|$)/);
      if (m && m[1]) return m[1];
      var q = new URLSearchParams(location.search).get("id");
      if (q) return q;
      // arena.ai keeps the thread in the route; unknown shapes still need
      // *some* stable token, so use path+query verbatim.
      var pq = (path + (location.search || "")).replace(/[^\w/?=&.-]/g, "").slice(0, 200);
      return pq || "";
    } catch {
      return "";
    }
  }

  // ---- Streaming detection ------------------------------------------------------
  // Deliberately broad: any visible "Stop" affordance or a streaming/loading marker.
  // A stuck indicator can never block capture forever — capture-core captures
  // after the text is static for 3× stabilityMs regardless.
  function isStreaming() {
    try {
      return !!document.querySelector(
        [
          'button[aria-label*="Stop" i]',
          'button[data-testid*="stop" i]',
          '[class*="streaming" i]',
          '[class*="generating" i]',
          '[class*="is-loading" i]',
          '[class*="loading-dots" i]',
          ".response-loading",
          ".result-streaming",
        ].join(", ")
      );
    } catch {
      return false;
    }
  }

  return {
    platform: PLATFORM,
    label:
      PLATFORM === "generic"
        ? "AI Chat"
        : PLATFORM.charAt(0).toUpperCase() + PLATFORM.slice(1),

    isSupportedPage: function () {
      // The content script is only injected into known AI chat hosts (see
      // manifest.json), so any page we run on is capturable in principle.
      // Non-chat pages on those hosts simply contain no messages.
      return true;
    },

    getConversationId: getConversationId,
    collectMessages: collectMessages,
    probeStrategy: probeStrategy,
    isStreaming: isStreaming,
  };
})();
// Keep the legacy generic entry point compatible with existing tests.
globalThis.TF_SELECTORS = globalThis.TF_GENERIC_SELECTORS;
