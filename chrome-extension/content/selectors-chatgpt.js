// ChatGPT-specific DOM selectors — isolated here so this file is the only place
// to edit when ChatGPT changes its markup.
// Loaded before content/chatgpt.js; exposes globalThis.TF_SELECTORS.
//
// Detection uses MULTI-STRATEGY collection so a markup change in one layer
// does not break capture:
//   A. [data-message-author-role]                (classic, still present in 2026)
//   B. [data-testid="user-message"] /
//      [data-testid="conversation-turn-*"]       (current testid layer)
//   C. article .markdown structure                (last-resort structural)
// Streaming detection likewise tries several indicators and has a
// "stable-too-long" override in capture-core so a stuck indicator cannot
// block capture forever.

globalThis.TF_SELECTORS = (function () {
  function posSort(a, b) {
    if (a === b) return 0;
    const rel = a.el.compareDocumentPosition(b.el);
    return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function textOf(el) {
    return (el && el.innerText ? el.innerText : "").trim();
  }

  // Strategy A — data-message-author-role (single container per message)
  function collectByAuthorRole() {
    const nodes = document.querySelectorAll("[data-message-author-role]");
    if (!nodes.length) return [];
    const out = [];
    nodes.forEach(function (el) {
      const role = el.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") return;
      const text = textOf(el);
      if (!text) return;
      out.push({
        el: el,
        role: role,
        text: text,
        id: el.getAttribute("data-message-id") || "",
      });
    });
    return out;
  }

  // Strategy B — data-testid layer (user-message / conversation-turn-*)
  function collectByTestIds() {
    const bucket = [];
    document.querySelectorAll('[data-testid="user-message"]').forEach(function (el) {
      bucket.push({ el: el, role: "user" });
    });
    document
      .querySelectorAll(
        '[data-testid="conversation-turn-assistant"], [data-testid="conversation-turn-model"]'
      )
      .forEach(function (turn) {
        // Prefer the markdown body so toolbar button labels are excluded.
        const body = turn.querySelector(".markdown, [data-message-author-role]") || turn;
        bucket.push({ el: body, role: "assistant" });
      });

    // Dedupe overlaps (e.g. an assistant turn that also carries author-role).
    const clean = [];
    bucket.forEach(function (item) {
      for (let i = 0; i < clean.length; i++) {
        const other = clean[i].el;
        if (other === item.el || other.contains(item.el) || item.el.contains(other)) return;
      }
      clean.push(item);
    });
    clean.sort(posSort);
    return clean.map(function (item) {
      return {
        el: item.el,
        role: item.role,
        text: textOf(item.el),
        id: item.el.getAttribute("data-message-id") || "",
      };
    });
  }

  // Strategy C — structural fallback: chat articles. Assistant turns contain
  // a .markdown body; user turns are plain whitespace-pre-wrap text blocks.
  function collectByArticles() {
    const bucket = [];
    document.querySelectorAll("main article, article").forEach(function (art) {
      if (art.querySelector("textarea, [contenteditable='true']")) return; // composer
      const md = art.querySelector(".markdown");
      if (md) {
        bucket.push({ el: md, role: "assistant" });
        return;
      }
      const q = art.querySelector(".whitespace-pre-wrap");
      if (q) bucket.push({ el: q, role: "user" });
    });
    bucket.sort(posSort);
    return bucket.map(function (item) {
      return {
        el: item.el,
        role: item.role,
        text: textOf(item.el),
        id: item.el.getAttribute("data-message-id") || item.el.id || "",
      };
    });
  }

  return {
    platform: "chatgpt",
    label: "ChatGPT",

    isSupportedPage: function () {
      const h = location.hostname;
      return h === "chatgpt.com" || h.endsWith(".chatgpt.com") || h === "chat.openai.com";
    },

    // Conversation id from the URL: chatgpt.com/c/<id> (fallback: ?conversation_id=)
    getConversationId: function () {
      try {
        const m = location.pathname.match(/\/c\/([^/?#]+)/);
        if (m) return m[1];
        return new URLSearchParams(location.search).get("conversation_id") || "";
      } catch {
        return "";
      }
    },

    // All chat messages in document order; first strategy that yields
    // results wins, so only one representation is ever used per scan.
    collectMessages: function () {
      let out = collectByAuthorRole();
      if (!out.length) out = collectByTestIds();
      if (!out.length) out = collectByArticles();
      return out
        .filter(function (m) {
          return m && m.text;
        })
        .map(function (m) {
          return { role: m.role, text: m.text, id: m.id };
        });
    },

    // Which strategy matched — surfaced in diagnostics.
    probeStrategy: function () {
      if (collectByAuthorRole().length) return "author-role";
      if (collectByTestIds().length) return "testid";
      if (collectByArticles().length) return "article";
      return "none";
    },

    // True while the model is still generating (multi-indicator).
    isStreaming: function () {
      return !!(
        document.querySelector(
          [
            'button[data-testid="stop-button"]',
            '[data-testid="stop-button"]',
            'button[aria-label="Stop generating"]',
            'button[aria-label="Stop streaming"]',
            'button[aria-label="Stop response"]',
            ".result-streaming",
          ].join(", ")
        )
      );
    },
  };
})();
