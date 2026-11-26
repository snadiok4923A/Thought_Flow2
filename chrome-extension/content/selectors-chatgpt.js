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

  // ChatGPT renders a visually hidden speaker heading ("ChatGPT said:" /
  // "You said:") inside its message containers. It is interface chrome, not
  // content. When it was treated as answer text, a turn that had not rendered
  // its body yet was saved as a node whose Notes were only the question plus
  // "ChatGPT said:" — and because that label never grows, the real answer was
  // never delivered as an update.
  const SPEAKER_LABELS = [
    "chatgpt said:", "chatgpt said",
    "you said:", "you said",
    "assistant said:", "assistant said",
    "user said:", "user said",
    "gemini said:", "gemini said",
    "claude said:", "claude said",
    "model said:", "model said",
  ];

  function stripSpeakerLabels(raw) {
    const text = String(raw || "");
    if (!text.trim()) return "";
    const kept = text.split(/\r?\n/).filter(function (line) {
      const key = line.trim().toLowerCase().replace(/\s+/g, " ");
      return SPEAKER_LABELS.indexOf(key) === -1;
    });
    // Drop blank runs left behind by a removed heading; keep real spacing.
    return kept.join("\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  }

  function textOf(el) {
    return stripSpeakerLabels(el && el.innerText ? el.innerText : "");
  }

  // Every complete answer body inside one turn. ChatGPT nests .markdown inside
  // .prose inside the role wrapper, so nested duplicates are dropped while
  // separate markdown / code-block containers are all kept.
  function assistantBodies(turn) {
    const found = Array.prototype.slice.call(
      (turn.querySelectorAll
        ? turn.querySelectorAll(
            '[data-message-author-role="assistant"], [data-message-content], ' +
              '.markdown, .prose, [class*="markdown"], [class*="prose"]'
          )
        : []) || []
    );
    return found.filter(function (el) {
      return !found.some(function (other) {
        return other !== el && other.contains && other.contains(el);
      });
    });
  }

  // One assistant turn can have several markdown/code blocks. Selecting only
  // its FIRST .markdown misses the rest of the visible answer, and selecting
  // the first non-empty wrapper can select the speaker label alone.
  // Merge every outer body in document order instead.
  function assistantTurnContent(turn) {
    const bodies = assistantBodies(turn);
    const parts = [];
    let el = turn;
    for (const body of bodies) {
      const text = textOf(body);
      if (!text) continue;
      parts.push(text);
      if (el === turn) el = body;
    }
    if (parts.length) {
      // The outermost body already contains every nested block; joining the
      // remaining outer bodies keeps split code/markdown containers complete.
      return { el, text: parts.join("\n\n") };
    }
    return { el: turn, text: textOf(turn) };
  }

  // Strategy A — data-message-author-role (single container per message)
  function collectByAuthorRole() {
    const nodes = document.querySelectorAll("[data-message-author-role]");
    if (!nodes.length) return [];
    const out = [];
    nodes.forEach(function (el) {
      const role = el.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") return;
      const body = role === "assistant"
        ? assistantTurnContent(el)
        : { el: el, text: textOf(el) };
      if (!body.text) return;
      out.push({
        el: body.el,
        role: role,
        text: body.text,
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
      const md = art.querySelector(".markdown, .prose, [class*='markdown']");
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
      // Keep the entire assistant body (every markdown/code block), never a
      // label-only wrapper that happens to render first.
      const body = role === "user"
        ? root.querySelector?.('[data-user-message-bubble="true"], [data-conversation-role="user"]') || root
        : null;
      const text = role === "user" ? textOf(body) : assistantTurnContent(root).text;
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
