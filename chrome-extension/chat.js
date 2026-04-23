// chat.js — Z2U /Chat page: monitor incoming messages → Telegram; reply from Telegram → Z2U
// Completely independent of content.js (order fulfillment logic).
(async () => {
  const LOG  = (...a) => console.log("[Z2U-CHAT]",  ...a);
  const WARN = (...a) => console.warn("[Z2U-CHAT]", ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Telegram helpers ────────────────────────────────────────────────────────

  function escHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function getTgConfig() {
    return new Promise(r =>
      chrome.storage.local.get(["tgToken", "tgChatId", "tgOffset", "tgMsgMap"], r)
    );
  }

  // Send a message to Telegram; returns the sent message_id or null on error
  async function tgSend(token, chatId, html, replyToId = null) {
    const body = { chat_id: chatId, text: html, parse_mode: "HTML" };
    if (replyToId) body.reply_to_message_id = replyToId;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) { WARN("tgSend failed:", d.description); return null; }
      return d.result.message_id;
    } catch (e) {
      WARN("tgSend error:", e.message);
      return null;
    }
  }

  // Forward a new Z2U chat message to Telegram.
  // Stores the returned message_id → username mapping so replies can be routed back.
  async function forwardToTelegram(username, message) {
    const cfg = await getTgConfig();
    if (!cfg.tgToken || !cfg.tgChatId) {
      WARN("Telegram not configured — open the extension popup to set Bot Token + Chat ID");
      return;
    }
    const text =
      `💬 <b>Z2U Chat</b>\n` +
      `👤 <b>${escHtml(username)}</b>:\n` +
      `${escHtml(message)}\n\n` +
      `<i>↩ Reply to this message to send a response via Z2U chat</i>`;
    const msgId = await tgSend(cfg.tgToken, cfg.tgChatId, text);
    if (msgId) {
      const map = cfg.tgMsgMap || {};
      map[String(msgId)] = username;
      // Keep map bounded to last 500 entries
      const keys = Object.keys(map);
      if (keys.length > 500) {
        const oldest = keys.slice(0, keys.length - 500);
        oldest.forEach(k => delete map[k]);
      }
      await chrome.storage.local.set({ tgMsgMap: map });
      LOG(`→ Telegram (id=${msgId}) | ${username}: ${message.slice(0, 60)}`);
    }
  }

  // ── Telegram polling (check for replies every 5 s) ──────────────────────────

  async function pollTelegram() {
    const cfg = await getTgConfig();
    if (!cfg.tgToken || !cfg.tgChatId) return;
    const offset = cfg.tgOffset || 0;
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${cfg.tgToken}/getUpdates?offset=${offset}&timeout=0`
      );
      const d = await r.json();
      if (!d.ok || !d.result.length) return;

      const map = cfg.tgMsgMap || {};
      let lastOffset = offset;

      for (const update of d.result) {
        lastOffset = Math.max(lastOffset, update.update_id + 1);
        const msg = update.message;
        if (!msg?.text) continue;

        // Only act on replies to our forwarded messages
        const replyToId = msg.reply_to_message?.message_id;
        if (!replyToId) continue;

        const username = map[String(replyToId)];
        if (!username) continue;

        LOG(`← Telegram reply for "${username}": "${msg.text}"`);
        await sendReplyToUser(username, msg.text);
      }

      await chrome.storage.local.set({ tgOffset: lastOffset });
    } catch (e) {
      WARN("pollTelegram error:", e.message);
    }
  }

  // ── Z2U chat DOM helpers ────────────────────────────────────────────────────

  // Find all conversation list items in the left sidebar
  function getConvItems() {
    // Try progressively broader selectors until we find items
    const candidates = [
      '[class*="chatListItem"]',
      '[class*="chat-list-item"]',
      '[class*="chatItem"]',
      '[class*="contactItem"]',
      '[class*="conversationItem"]',
      '[class*="userListItem"]',
    ];
    for (const sel of candidates) {
      const items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) return items;
    }
    // Structural fallback: left-panel list items that contain an avatar + name
    return Array.from(document.querySelectorAll(
      '.chatList li, [class*="chatList"] li, [class*="sideBar"] li, aside li'
    ));
  }

  // Extract username, last-message preview, and unread state from a sidebar item
  function extractConvInfo(item) {
    // Walk leaf text nodes to find username (first bold/heading child) and preview
    const leaves = Array.from(item.querySelectorAll("*"))
      .filter(el => el.childElementCount === 0 && (el.textContent?.trim()));

    const username = leaves[0]?.textContent?.trim() || "";
    const preview  = leaves[1]?.textContent?.trim() || "";

    // Unread badge: red circle with a number > 0
    const badge = item.querySelector(
      '[class*="unread"], [class*="badge"], [class*="unreadCount"], [class*="msgCount"], [class*="dot"]'
    );
    const badgeText = badge?.textContent?.trim() || "0";
    const hasUnread = !!badge && badgeText !== "" && badgeText !== "0";

    return { username, preview, hasUnread };
  }

  // Find a sidebar item whose text contains the given username
  function findConvByUsername(username) {
    return getConvItems().find(item =>
      (item.textContent || "").includes(username)
    ) || null;
  }

  // ── Send reply via Z2U chat UI ──────────────────────────────────────────────

  async function sendReplyToUser(username, text) {
    const item = findConvByUsername(username);
    if (!item) {
      WARN(`Sidebar item for "${username}" not found — cannot send reply`);
      return;
    }

    // Open that conversation
    item.click();
    await sleep(800);

    // Find the message input (textarea, contenteditable div, or plain input)
    const input = document.querySelector(
      '[class*="messageInput"] textarea, ' +
      '[class*="chatInput"] textarea, ' +
      '[class*="inputBox"] textarea, ' +
      'textarea[placeholder], ' +
      'div[contenteditable="true"][class*="input"], ' +
      'div[contenteditable="true"][class*="msg"], ' +
      'div[contenteditable="true"][class*="chat"]'
    );

    if (!input) {
      WARN("Message input not found on chat page");
      return;
    }

    input.focus();

    if (input.getAttribute("contenteditable") === "true") {
      // ContentEditable div (React Draft / Slate / Lexical editors)
      input.textContent = "";
      document.execCommand("insertText", false, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // Standard textarea / input
      const proto = input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await sleep(300);

    // Click the Send button, or press Enter if no button found
    const sendBtn = Array.from(document.querySelectorAll("button, [role='button']"))
      .find(b => /send|submit/i.test(b.className + " " + (b.getAttribute("aria-label") || "")));
    if (sendBtn) {
      sendBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown",  { key: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",    { key: "Enter", keyCode: 13, bubbles: true }));
    }

    LOG(`✅ Sent reply to "${username}": "${text.slice(0, 60)}"`);
  }

  // ── Main monitor loop ───────────────────────────────────────────────────────

  const seenMessages = new Map(); // username → last preview we forwarded (or recorded on init)
  let initialized   = false;

  function scanChats() {
    const items = getConvItems();
    if (!items.length) return; // Page not rendered yet

    for (const item of items) {
      const { username, preview, hasUnread } = extractConvInfo(item);
      if (!username || !preview) continue;

      if (!initialized) {
        // First scan: snapshot current state without forwarding anything
        seenMessages.set(username, preview);
        continue;
      }

      // After init: only forward conversations with a visible unread indicator
      // whose preview text changed since last check
      if (!hasUnread) continue;
      const lastSeen = seenMessages.get(username);
      if (lastSeen === preview) continue; // Already forwarded this exact message

      seenMessages.set(username, preview);
      forwardToTelegram(username, preview);
    }

    if (!initialized) {
      initialized = true;
      LOG(`Initialized — ${seenMessages.size} existing conversations snapshotted (not forwarded)`);
    }
  }

  // Wait for initial page render
  await sleep(2000);
  scanChats();

  // Watch for DOM changes (unread badges appearing, new conversations)
  new MutationObserver(() => scanChats()).observe(document.body, {
    childList: true,
    subtree:   true,
  });

  // Poll Telegram every 5 s for replies
  setInterval(pollTelegram, 5000);

  LOG("Chat monitor started on", window.location.href);
})();
