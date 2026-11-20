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

  // Gemini puts accessible speaker labels INSIDE its message wrappers.
  // Read the actual text elements first so "You said"/"Gemini said" never
  // become part of the question, answer, or resulting mind-map node title.
  function textOf(el) {
    return (el && el.innerText ? el.innerText : "").trim();
  }

  function removeSpeakerPrefix(raw, role) {
    // Fallback only. The preferred body selectors below do not include labels.
    var t = String(raw || "").trim();
    var label = role === "user" ? "You said" : "Gemini said";
    if (t === label) return "";
    var lines = t.split(/\r?\n/);
    if (lines[0].trim() === label || lines[0].trim() === label + ":") {
      return lines.slice(1).join("\n").trim();
    }
    // Some Gemini builds expose a combined heading "You said <query>"
    // followed by the same actual query on the next line.
    if (role === "user" && lines.length > 1 &&
        lines[0].startsWith(label + " ") &&
        lines[0].slice(label.length).trim() === lines.slice(1).join("\n").trim()) {
      return lines.slice(1).join("\n").trim();
    }
    return t;
  }

  function messageText(el, role) {
    if (role === "user") {
      // Prefer question paragraphs, excluding Gemini's hidden "You said".
      var lines = el.querySelectorAll("p.query-text-line, .query-text-line");
      if (lines.length) {
        var body = Array.from(lines).map(textOf).filter(Boolean).join("\n").trim();
        if (body) return body;
      }
      var query = el.querySelector(".query-text");
      if (query) return removeSpeakerPrefix(textOf(query), role);
    } else {
      // The model speaker announcer is a sibling, NOT part of response text.
      var response = el.querySelector(
        "structured-content-container.model-response-text, .model-response-text, message-content"
      );
      if (response) {
        var bodyText = textOf(response);
        if (bodyText) return bodyText;
      }
    }
    return removeSpeakerPrefix(textOf(el), role);
  }

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
        var text = messageText(item.el, item.role);
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
