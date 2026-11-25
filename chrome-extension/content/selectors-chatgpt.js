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
//   D. 2026 Chat/Work role-marked search units: data-content-search-unit-key
//      / data-conversation-role / data-turn-key (account-specific new UI)
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

  // One assistant turn can have several markdown/code blocks. Selecting
  // only its FIRST .markdown misses the rest of the visible answer.
  // Prefer the complete role-marked body; if only a partial markdown block
  // is available, use the entire assistant turn when it is substantially
  // longer (for example, a multi-part Python coding response).
  function assistantTurnContent(turn) {
    const roleBody = turn.querySelector('[data-message-author-role="assistant"]');
    if (roleBody && textOf(roleBody)) {
      return { el: roleBody, text: textOf(roleBody) };
    }
    const markdown = turn.querySelector(".markdown, .prose");
    const snippet = markdown ? textOf(markdown) : "";
    const entire = textOf(turn);
    if (entire.length > snippet.length + 80 && entire.length > snippet.length * 1.5) {
      return { el: turn, text: entire };
    }
    return { el: markdown || turn, text: snippet || entire };
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
    // Newer ChatGPT layouts may expose user turns without user-message.
    document.querySelectorAll('[data-testid="conversation-turn-user"]').forEach(function (turn) {
      const body = turn.querySelector(
        '[data-testid="user-message"], [data-message-author-role="user"], .whitespace-pre-wrap'
      ) || turn;
      bucket.push({ el: body, role: "user" });
    });
    document
      .querySelectorAll(
        '[data-testid="conversation-turn-assistant"], [data-testid="conversation-turn-model"]'
      )
      .forEach(function (turn) {
        const body = assistantTurnContent(turn);
        bucket.push({ el: body.el, role: "assistant", text: body.text });
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
        text: item.text || textOf(item.el),
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
      const md = art.querySelector(".markdown, .prose");
      if (md) {
        const body = assistantTurnContent(art);
        bucket.push({ el: body.el, role: "assistant", text: body.text });
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
        text: item.text || textOf(item.el),
        id: item.el.getAttribute("data-message-id") || item.el.id || "",
      };
    });
  }

  // Strategy D — new ChatGPT Chat/Work markup (September 2026 onward).
  // Some logged-in accounts no longer render [data-message-author-role],
  // conversation-turn-N or article at all. The actual user/assistant role
  // lives on a content-search unit or a data-conversation-role wrapper.
  // These are explicit semantic role markers, NOT guessed markdown blocks.
  function collectBySearchUnits() {
    let roots = Array.from(document.querySelectorAll(
      '[data-content-search-unit-key], [data-chatgpt-search-unit-key]'
    ));
    if (!roots.length) roots = Array.from(document.querySelectorAll('[data-conversation-role]'));
    if (!roots.length) roots = Array.from(document.querySelectorAll(
      '[data-turn-key][data-conversation-role]'
    ));
    const out = [];
    const used = new Set();
    for (const root of roots) {
      const unitKey = root.getAttribute("data-content-search-unit-key") ||
        root.getAttribute("data-chatgpt-search-unit-key") || "";
      const namedRole = root.getAttribute("data-conversation-role") ||
        root.querySelector?.('[data-conversation-role]')?.getAttribute("data-conversation-role") || "";
      let role = (unitKey.match(/:(user|assistant)$/i) || [])[1]?.toLowerCase();
      if (!role) role = /^(user|assistant)$/i.test(namedRole) ? namedRole.toLowerCase() : "";
      if (!role) continue;
      if (root.closest?.('form[data-chatgpt-composer]')) continue;
      const body = role === "user"
        ? root.querySelector?.('[data-user-message-bubble="true"], [data-conversation-role="user"]') || root
        : root.querySelector?.('[data-conversation-role="assistant"]') || root;
      // Keep the entire assistant container (including code blocks), rather
      // than just its first .markdown paragraph.
      const text = textOf(body);
      if (!text) continue;
      const id = unitKey || root.getAttribute("data-turn-key") ||
        root.getAttribute("data-message-id") || "";
      // A turn can expose both a wrapper and a nested role element.
      // Never interpret the nested element as another Q+A turn.
      const identity = id || root;
      if (used.has(identity)) continue;
      used.add(identity);
      out.push({ el: root, role, text, id });
    }
    out.sort(posSort);
    return out;
  }

  let chosenMode = "none";

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

    // Evaluate all SEMANTIC ChatGPT extractors, not "first pair wins".
    // An earlier Q+A in the author-role view must not hide a NEW reply that
    // is only visible through a conversation-turn or article view.
    collectMessages: function () {
      const strategies = [
        collectBySearchUnits(), collectByAuthorRole(),
        collectByTestIds(), collectByArticles(),
      ];
      const count = (rows) => {
        let n = 0, pending = false;
        for (const row of rows) {
          if (row.role === "user") pending = true;
          else if (pending && row.role === "assistant") { n++; pending = false; }
        }
        return n;
      };
      const latest = (rows) => {
        let q = "", a = "";
        for (const row of rows) {
          if (row.role === "user") { q = row.text || ""; a = ""; }
          else if (q && row.role === "assistant") a = row.text || "";
        }
        return { q: q.trim(), a: a.trim() };
      };
      let out = [];
      const modes = ["search-unit", "author-role", "testid", "article"];
      for (let i = 0; i < strategies.length; i++) {
        const candidate = strategies[i];
        const cp = count(candidate);
        const op = count(out);
        if (cp > op) { out = candidate; chosenMode = modes[i]; continue; }
        if (cp < op) continue;
        const a = latest(out), b = latest(candidate);
        // For the SAME newest user turn, prefer the complete answer instead
        // of a tiny fragment or a stale view of the assistant body.
        if (b.q && b.q === a.q && b.a.length > a.a.length * 1.35 + 30) {
          out = candidate;
          chosenMode = modes[i];
        } else if (!out.length && candidate.length) {
          out = candidate;
          chosenMode = modes[i];
        }
      }
      return out.filter((m) => m && m.text)
        .map((m) => ({ role: m.role, text: m.text, id: m.id }));
    },

    // Which strategy matched — surfaced in diagnostics.
    probeStrategy: function () {
      return chosenMode;
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
