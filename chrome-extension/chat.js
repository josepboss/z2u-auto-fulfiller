// chat.js — Z2U /Chat page: monitor incoming messages → Telegram; reply from Telegram → Z2U
// Completely independent of content.js (order fulfillment logic).
(async () => {
  const LOG  = (...a) => console.log("[Z2U-CHAT]",  ...a);
  const WARN = (...a) => console.warn("[Z2U-CHAT]", ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Active timer/interval handles so we can stop them on context loss
  const handles = { poll: null, refresh: null, observer: null };

  // ── Extension context guard ─────────────────────────────────────────────────
  // When the extension is reloaded while this tab is open, chrome.* calls throw
  // "Extension context invalidated". We detect this and stop all activity.

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function shutdown(reason) {
    WARN("Shutting down chat monitor:", reason);
    if (handles.poll)     { clearInterval(handles.poll);   handles.poll = null; }
    if (handles.refresh)  { clearTimeout(handles.refresh); handles.refresh = null; }
    if (handles.observer) { handles.observer.disconnect(); handles.observer = null; }
  }

  // Wrap any chrome.storage.local.get call so it never throws unhandled
  async function getTgConfig() {
    if (!isContextValid()) return {};
    return new Promise(r => {
      try {
        chrome.storage.local.get(["tgToken", "tgChatId", "tgOffset", "tgMsgMap"], r);
      } catch (e) {
        shutdown(e.message);
        r({});
      }
    });
  }

  async function setStorage(obj) {
    if (!isContextValid()) return;
    try { await chrome.storage.local.set(obj); }
    catch (e) { shutdown(e.message); }
  }

  // ── Telegram helpers ────────────────────────────────────────────────────────

  function escHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  async function forwardToTelegram(username, message) {
    if (!isContextValid()) return;
    const cfg = await getTgConfig();
    if (!cfg.tgToken || !cfg.tgChatId) {
      WARN("Telegram not configured — open the extension popup to set Bot Token + Chat ID");
      return;
    }
    const text =
      `💬 <b>Z2U Chat</b>\n` +
      `👤 <b>${escHtml(username)}</b>:\n` +
      `${escHtml(message)}\n\n` +
      `<i>↩ Reply to this message to respond via Z2U chat</i>`;
    const msgId = await tgSend(cfg.tgToken, cfg.tgChatId, text);
    if (msgId) {
      const map = cfg.tgMsgMap || {};
      map[String(msgId)] = username;
      const keys = Object.keys(map);
      if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete map[k]);
      await setStorage({ tgMsgMap: map });
      LOG(`→ Telegram (id=${msgId}) | ${username}: ${message.slice(0, 60)}`);
    }
  }

  // ── Telegram polling (check for replies every 5 s) ──────────────────────────

  async function pollTelegram() {
    if (!isContextValid()) { shutdown("context lost during poll"); return; }
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

      await setStorage({ tgOffset: lastOffset });
    } catch (e) {
      WARN("pollTelegram error:", e.message);
    }
  }

  // ── Z2U chat DOM helpers ────────────────────────────────────────────────────

  function getConvItems() {
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
    return Array.from(document.querySelectorAll(
      '.chatList li, [class*="chatList"] li, [class*="sideBar"] li, aside li'
    ));
  }

  function extractConvInfo(item) {
    const leaves = Array.from(item.querySelectorAll("*"))
      .filter(el => el.childElementCount === 0 && el.textContent?.trim());

    const username = leaves[0]?.textContent?.trim() || "";
    const preview  = leaves[1]?.textContent?.trim() || "";

    const badge = item.querySelector(
      '[class*="unread"], [class*="badge"], [class*="unreadCount"], [class*="msgCount"], [class*="dot"]'
    );
    const badgeText = badge?.textContent?.trim() || "0";
    const hasUnread = !!badge && badgeText !== "" && badgeText !== "0";

    return { username, preview, hasUnread };
  }

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

    item.click();
    await sleep(800);

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
      input.textContent = "";
      document.execCommand("insertText", false, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
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

  const seenMessages = new Map();
  let initialized   = false;

  function scanChats() {
    if (!isContextValid()) { shutdown("context lost during scan"); return; }
    const items = getConvItems();
    if (!items.length) return;

    for (const item of items) {
      const { username, preview, hasUnread } = extractConvInfo(item);
      if (!username || !preview) continue;

      if (!initialized) {
        seenMessages.set(username, preview);
        continue;
      }

      if (!hasUnread) continue;
      const lastSeen = seenMessages.get(username);
      if (lastSeen === preview) continue;

      seenMessages.set(username, preview);
      forwardToTelegram(username, preview);
    }

    if (!initialized) {
      initialized = true;
      LOG(`Initialized — ${seenMessages.size} existing conversations snapshotted`);
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────────────

  await sleep(2000);
  scanChats();

  const obs = new MutationObserver(() => {
    if (!isContextValid()) { shutdown("context lost in MutationObserver"); return; }
    scanChats();
  });
  obs.observe(document.body, { childList: true, subtree: true });
  handles.observer = obs;

  handles.poll = setInterval(() => {
    if (!isContextValid()) { shutdown("context lost in poll interval"); return; }
    pollTelegram();
  }, 5000);

  // Auto-refresh between 2–5 min
  const MIN_MS = 2 * 60 * 1000;
  const MAX_MS = 5 * 60 * 1000;
  const refreshDelay = Math.floor(Math.random() * (MAX_MS - MIN_MS + 1)) + MIN_MS;
  LOG(`Auto-refresh scheduled in ${Math.round(refreshDelay / 1000)} s`);
  handles.refresh = setTimeout(() => {
    LOG("Auto-refreshing page…");
    window.location.reload();
  }, refreshDelay);

  LOG("Chat monitor started on", window.location.href);
})().catch(e => console.warn("[Z2U-CHAT] Fatal error:", e.message));
