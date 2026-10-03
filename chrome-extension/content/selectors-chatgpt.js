// ChatGPT-specific DOM selectors — isolated here so this file is the only place
// to edit when ChatGPT changes its markup.
// Loaded before content/chatgpt.js; exposes globalThis.TF_SELECTORS.

globalThis.TF_SELECTORS = (function () {
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

    // All chat messages in document order. ChatGPT marks each with
    // data-message-author-role="user" | "assistant" (+ data-message-id).
    collectMessages: function () {
      const out = [];
      const nodes = document.querySelectorAll("[data-message-author-role]");
      nodes.forEach(function (el) {
        const role = el.getAttribute("data-message-author-role");
        if (role !== "user" && role !== "assistant") return;
        const text = (el.innerText || "").trim();
        if (!text) return;
        out.push({
          role: role,
          text: text, // exact visible text — never summarized or rewritten
          id: el.getAttribute("data-message-id") || "",
        });
      });
      return out;
    },

    // True while the model is still generating.
    isStreaming: function () {
      return !!(
        document.querySelector(
          [
            'button[data-testid="stop-button"]',
            'button[aria-label="Stop generating"]',
            'button[aria-label="Stop response"]',
            ".result-streaming",
            '[data-testid="stop-button"]',
          ].join(", ")
        )
      );
    },
  };
})();
