// Gemini-specific DOM selectors — isolated here so this file is the only place
// to edit when Gemini changes its markup.
// Loaded before content/gemini.js; exposes globalThis.TF_SELECTORS.

globalThis.TF_SELECTORS = (function () {
  // Candidate selectors per role, in priority order. Elements nested inside an
  // already-collected element are skipped so nothing is captured twice.
  var USER_SELECTORS = [
    "user-query",
    '[data-message-source-role="user"]',
    ".user-query",
  ];
  var ASSISTANT_SELECTORS = [
    "model-response",
    '[data-message-source-role="model"]',
    ".model-response",
    ".response-container",
  ];

  function collectRole(selectorsList, role, bucket) {
    selectorsList.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        // Skip if nested inside / containing an already-collected element.
        for (var i = 0; i < bucket.length; i++) {
          var other = bucket[i].el;
          if (other === el || other.contains(el) || el.contains(other)) return;
        }
        bucket.push({ el: el, role: role });
      });
    });
  }

  return {
    platform: "gemini",
    label: "Gemini",

    isSupportedPage: function () {
      return location.hostname === "gemini.google.com";
    },

    // Conversation id from the URL: gemini.google.com/app/<id>
    getConversationId: function () {
      var parts = location.pathname.split("/").filter(Boolean);
      var i = parts.indexOf("app");
      if (i >= 0 && parts[i + 1]) return parts[i + 1];
      if (parts.indexOf("new") >= 0) return "new";
      return "";
    },

    // All messages in document order (user query + model response).
    collectMessages: function () {
      var bucket = [];
      collectRole(USER_SELECTORS, "user", bucket);
      collectRole(ASSISTANT_SELECTORS, "assistant", bucket);

      // Keep document order so question/answer pairing works.
      bucket.sort(function (a, b) {
        if (a.el === b.el) return 0;
        const rel = a.el.compareDocumentPosition(b.el);
        return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      var out = [];
      bucket.forEach(function (item) {
        var text = (item.el.innerText || "").trim();
        if (!text) return;
        out.push({
          role: item.role,
          text: text, // exact visible text — never summarized or rewritten
          id: item.el.getAttribute("data-message-id") || item.el.id || "",
        });
      });
      return out;
    },

    // True while Gemini is still generating a response.
    isStreaming: function () {
      return !!(
        document.querySelector(
          [
            'button[aria-label="Stop response"]',
            'button[aria-label="Stop generating"]',
            'button[aria-label*="Stop" i]',
            "model-response .loading",
            ".response-loading",
          ].join(", ")
        )
      );
    },
  };
})();
