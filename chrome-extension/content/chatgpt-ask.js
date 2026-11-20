// Send a question from a ThoughtFlow node's existing Notes editor to the
// user's already-open, logged-in ChatGPT tab. This does not use an API key.
// The DOM automation is best-effort and must report failures, not fake answers.
(function () {
  if (globalThis.__tfChatGPTAskInstalled) return;
  globalThis.__tfChatGPTAskInstalled = true;

  let busy = false;
  const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A privacy-preserving fingerprint to link the reply with the exact
  // question, including after ChatGPT changes from / to /c/<conversation>.
  // No raw question needs to be persisted in extension storage.
  function questionKey(text) {
    const value = normalize(text);
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return value.length + ":" + (hash >>> 0).toString(36);
  }

  function readMessages() {
    try {
      if (globalThis.TF_SELECTORS?.collectMessages) {
        return globalThis.TF_SELECTORS.collectMessages();
      }
    } catch { /* use the structural fallback */ }
    return Array.from(document.querySelectorAll('[data-message-author-role]')).map((node) => ({
      role: node.getAttribute("data-message-author-role"),
      text: (node.querySelector(".markdown") || node).innerText?.trim() || "",
    }));
  }

  function streaming() {
    try {
      if (globalThis.TF_SELECTORS?.isStreaming) return globalThis.TF_SELECTORS.isStreaming();
    } catch { /* use fallback */ }
    return !!document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"]');
  }

  function composer() {
    return document.querySelector(
      '#prompt-textarea[contenteditable="true"], ' +
      '[data-testid="composer-input"][contenteditable="true"], ' +
      '[contenteditable="true"]#prompt-textarea, ' +
      'textarea#prompt-textarea, .ProseMirror[contenteditable="true"]'
    );
  }

  function findSendButton() {
    return document.querySelector(
      'button[data-testid="send-button"], ' +
      'button[data-testid="composer-send-button"], ' +
      'button[aria-label="Send prompt"], ' +
      'button[aria-label="Send message"], ' +
      'button[aria-label="Send"]'
    );
  }

  function fillComposer(el, text) {
    // Never overwrite an unfinished ChatGPT draft.
    const current = ("value" in el ? el.value : el.innerText) || "";
    if (current.trim()) throw new Error("ChatGPT has an unfinished draft. Clear or send it first.");

    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) throw new Error("ChatGPT composer could not be edited.");
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // On ChatGPT's ProseMirror editor, insertText generates the editing events
    // that React listens for. Never use innerHTML for untrusted note content.
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      // A fallback for DOM editor changes, with native input notification.
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: text,
      }));
    }
  }

  // Look for the *specific* user question, then read the assistant text
  // following that turn. Counting all assistant messages fails when ChatGPT
  // navigates from a new-chat page to a conversation URL after submission.
  async function waitForAnswer(key, minMatches, startingPath) {
    const deadline = Date.now() + 110000;
    let last = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      await delay(450);
      const messages = readMessages();
      const userMatches = [];
      messages.forEach((message, index) => {
        if (message.role === "user" && questionKey(message.text) === key) {
          userMatches.push(index);
        }
      });

      // An SPA route change to /c/... restarts the visible transcript.
      const required = location.pathname !== startingPath ? 1 : minMatches;
      if (userMatches.length < required) continue;
      const questionIndex = userMatches[userMatches.length - 1];
      let answer = "";
      for (let i = questionIndex + 1; i < messages.length; i++) {
        if (messages[i].role === "user") break;
        if (messages[i].role === "assistant" && messages[i].text?.trim()) {
          answer = messages[i].text.trim();
        }
      }
      if (!answer) continue;
      if (answer !== last) {
        last = answer;
        stableSince = Date.now();
        continue;
      }
      if (!streaming() && Date.now() - stableSince >= 2500) {
        return { ok: true, answer };
      }
    }
    throw new Error("ChatGPT answer was not detected. Check the ChatGPT tab before retrying.");
  }

  async function ask(question) {
    if (!question || question.length > 12000) {
      throw new Error("Write a question of at most 12,000 characters in Notes.");
    }
    if (streaming()) throw new Error("ChatGPT is generating another response. Try again after it finishes.");

    const key = questionKey(question);
    const before = readMessages().filter((msg) =>
      msg.role === "user" && questionKey(msg.text) === key
    ).length;
    const startingPath = location.pathname;
    let editor = composer();
    for (let i = 0; !editor && i < 30; i++) {
      await delay(200);
      editor = composer();
    }
    if (!editor) throw new Error("ChatGPT composer was not found. Open ChatGPT and sign in.");

    const suppressed = globalThis.__tfOutboundQuestions || new Set();
    globalThis.__tfOutboundQuestions = suppressed;
    fillComposer(editor, question);
    suppressed.add(normalize(question));

    let send = findSendButton();
    for (let i = 0; (!send || send.disabled) && i < 30; i++) {
      await delay(150);
      send = findSendButton();
    }
    if (!send || send.disabled) {
      throw new Error("ChatGPT Send button was not available. Check the ChatGPT tab.");
    }
    send.click();

    return waitForAnswer(key, before + 1, startingPath);
  }

  // A Chrome/Brave MV3 message port is NOT a reliable place to wait while
  // ChatGPT generates a full response (potentially ~110 seconds). Acknowledge
  // immediately, then send the completed answer in a fresh message.
  async function reportResult(requestId, result) {
    try {
      await chrome.runtime.sendMessage({
        type: "TF_CHATGPT_ASK_RESULT",
        requestId,
        result,
      });
    } catch (err) {
      // Do not log the private answer. The originating Notes page has its
      // own timeout/error state if this tab was closed or extension reloaded.
      console.warn("[ThoughtFlow] Could not deliver ChatGPT reply:", err?.message || "extension unavailable");
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "TF_CHATGPT_ASK_START") return;
    if (typeof msg.requestId !== "string" || !/^tf-notes-[A-Za-z0-9_-]{1,100}$/.test(msg.requestId)) {
      sendResponse({ ok: false, error: "Invalid Notes request ID." });
      return;
    }
    if (busy) {
      sendResponse({ ok: false, error: "Another ThoughtFlow question is still being answered." });
      return;
    }

    busy = true;
    const question = String(msg.question || "").trim();
    // Immediate reply: never hold the MV3 port open while a model responds.
    sendResponse({ ok: true, started: true });
    ask(question)
      .then((result) => reportResult(msg.requestId, result))
      .catch((error) => reportResult(msg.requestId, {
        ok: false,
        error: error?.message || "ChatGPT request failed.",
      }))
      .finally(() => { busy = false; });
  });

  // ChatGPT may replace its entire document after creating a new chat. In
  // that case the original script disappears mid-request. The background
  // reinjects this helper on the navigated tab and asks it to watch for the
  // question that was already sent (NEVER send the question a second time).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "TF_CHATGPT_ASK_RESUME") return;
    if (typeof msg.requestId !== "string" ||
        !/^tf-notes-[A-Za-z0-9_-]{1,100}$/.test(msg.requestId) ||
        typeof msg.questionKey !== "string" ||
        !/^[0-9]+:[a-z0-9]+$/.test(msg.questionKey)) {
      sendResponse({ ok: false, error: "Invalid recovery request." });
      return;
    }
    if (busy) {
      sendResponse({ ok: true, alreadyWatching: true });
      return;
    }
    busy = true;
    sendResponse({ ok: true, watching: true });
    // The navigated page contains the submitted user question. Match it
    // before accepting any assistant reply, preventing stale-answer leaks.
    waitForAnswer(msg.questionKey, 1, location.pathname)
      .then((result) => reportResult(msg.requestId, result))
      .catch((error) => reportResult(msg.requestId, {
        ok: false,
        error: error?.message || "Could not recover ChatGPT's answer.",
      }))
      .finally(() => { busy = false; });
  });
})();
