// Send a question from a ThoughtFlow node's existing Notes editor to the
// user's already-open, logged-in ChatGPT tab. This does not use an API key.
// The DOM automation is best-effort and must report failures, not fake answers.
(function () {
  if (globalThis.__tfChatGPTAskInstalled) return;
  globalThis.__tfChatGPTAskInstalled = true;

  let busy = false;
  const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async function ask(question) {
    if (!question || question.length > 12000) {
      throw new Error("Write a question of at most 12,000 characters in Notes.");
    }
    if (streaming()) throw new Error("ChatGPT is generating another response. Try again after it finishes.");

    const originalMessages = readMessages();
    const initialAssistants = originalMessages.filter((m) => m.role === "assistant").length;
    let editor = composer();
    for (let i = 0; !editor && i < 30; i++) {
      await delay(200);
      editor = composer();
    }
    if (!editor) throw new Error("ChatGPT composer was not found. Open ChatGPT and sign in.");

    // Suppress normal AI auto-capture of this one question: the answer must be
    // appended to its ORIGINAL node, not duplicated as a new child node.
    const suppressed = globalThis.__tfOutboundQuestions || new Set();
    globalThis.__tfOutboundQuestions = suppressed;
    suppressed.add(normalize(question));

    fillComposer(editor, question);

    let send = findSendButton();
    for (let i = 0; (!send || send.disabled) && i < 30; i++) {
      await delay(150);
      send = findSendButton();
    }
    if (!send || send.disabled) {
      throw new Error("ChatGPT Send button was not available. The question may be in the composer; check the ChatGPT tab.");
    }
    send.click();

    // Wait for a NEW assistant message, then until its visible text settles.
    // Never return an earlier answer already present in the chat.
    const deadline = Date.now() + 110000;
    let last = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      await delay(450);
      const messages = readMessages();
      const answers = messages.filter((m) => m.role === "assistant" && String(m.text || "").trim());
      const newAnswer = answers.length > initialAssistants ? answers[answers.length - 1]?.text?.trim() : "";
      if (!newAnswer) continue;
      if (newAnswer !== last) {
        last = newAnswer;
        stableSince = Date.now();
        continue;
      }
      if (!streaming() && Date.now() - stableSince >= 2500) {
        return { ok: true, answer: newAnswer };
      }
    }
    throw new Error("ChatGPT response did not finish. Check the ChatGPT tab and retry only if it did not answer.");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "TF_CHATGPT_ASK") return;
    if (busy) {
      sendResponse({ ok: false, error: "Another ThoughtFlow question is still being answered." });
      return;
    }
    busy = true;
    ask(String(msg.question || "").trim())
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || "ChatGPT request failed." }))
      .finally(() => { busy = false; });
    return true;
  });
})();
