// chat.js — Z2U /Chat page: monitor incoming messages → Telegram; reply from Telegram → Z2U
// Completely independent of content.js (order fulfillment logic).
(async () => {
  const LOG  = (...a) => console.log("[Z2U-CHAT]",  ...a);
  const WARN = (...a) => console.warn("[Z2U-CHAT]", ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const handles = { poll: null, refresh: null, observer: null };

  // ── Extension context guard ─────────────────────────────────────────────────
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function shutdown(reason) {
    WARN("Shutting down chat monitor:", reason);
    if (handles.poll)     { clearInterval(handles.poll);   handles.poll = null; }
    if (handles.refresh)  { clearTimeout(handles.refresh); handles.refresh = null; }
    if (handles.observer) { handles.observer.disconnect(); handles.observer = null; }
  }

  async function getTgConfig() {
    if (!isContextValid()) return {};
    return new Promise(r => {
      try {
        chrome.storage.local.get(
          ["tgToken", "tgChatId", "tgOffset", "tgMsgMap", "chatForwarded"], r
        );
      } catch (e) { shutdown(e.message); r({}); }
    });
  }

  async function setStorage(obj) {
    if (!isContextValid()) return;
    try { await chrome.storage.local.set(obj); }
    catch (e) { shutdown(e.message); }
  }

  // ── Persisted "already forwarded" map (survives page refreshes) ─────────────
  // chatForwarded: { [username]: lastPreviewTextWeForwarded }
  let chatForwarded = {};

  async function loadChatForwarded() {
    const cfg = await getTgConfig();
    chatForwarded = cfg.chatForwarded || {};
    LOG(`Loaded forwarded history: ${Object.keys(chatForwarded).length} users`);
  }

  async function markForwarded(username, preview) {
    chatForwarded[username] = preview;
    await setStorage({ chatForwarded });
  }

  // ── Telegram helpers ────────────────────────────────────────────────────────
  function escHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

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

  async function forwardToTelegram(username, preview) {
    if (!isContextValid()) return;
    const cfg = await getTgConfig();
    if (!cfg.tgToken || !cfg.tgChatId) {
      WARN("Telegram not configured — open popup to set Bot Token + Chat ID");
      return;
    }
    const text =
      `💬 <b>Z2U Chat</b>\n` +
      `👤 <b>${escHtml(username)}</b>:\n` +
      `${escHtml(preview)}\n\n` +
      `<i>↩ Reply to this message to respond via Z2U chat</i>`;
    const msgId = await tgSend(cfg.tgToken, cfg.tgChatId, text);
    if (msgId) {
      const map = cfg.tgMsgMap || {};
      map[String(msgId)] = username;
      const keys = Object.keys(map);
      if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete map[k]);
      await setStorage({ tgMsgMap: map });
      await markForwarded(username, preview);
      LOG(`→ Telegram (id=${msgId}) | ${username}: "${preview.slice(0, 60)}"`);
    }
  }

  // ── Telegram polling ────────────────────────────────────────────────────────
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

  // Returns true if the item contains a visible unread-count badge (a small positive integer).
  // Uses class selectors first, then falls back to scanning all leaf elements for 1-3 digit numbers.
  function itemHasUnread(item) {
    // Class-based selectors
    const badge = item.querySelector(
      '[class*="unread" i], [class*="badge" i], [class*="msgCount" i], ' +
      '[class*="unreadCount" i], [class*="count" i], [class*="num" i], [class*="dot" i]'
    );
    if (badge) {
      const t = badge.textContent?.trim();
      if (t && t !== "0" && /^[1-9]\d{0,2}$/.test(t)) return true;
    }

    // Fallback: any leaf element whose entire text is a 1-3 digit positive number
    // (badges like "2" will be their own element; timestamps like "22:39" have a colon)
    const leaves = Array.from(item.querySelectorAll("span, div, em, i, b, strong"))
      .filter(el => el.childElementCount === 0);
    return leaves.some(el => /^[1-9]\d{0,2}$/.test(el.textContent?.trim() || ""));
  }

  function extractConvInfo(item) {
    // Try class-targeted selectors for username and preview
    const nameEl = item.querySelector(
      '[class*="name" i]:not([class*="last"]):not([class*="msg"]):not([class*="time"]),' +
      '[class*="nick" i], [class*="title" i]'
    );
    const msgEl = item.querySelector(
      '[class*="lastMsg" i], [class*="last-msg" i], [class*="preview" i], ' +
      '[class*="content" i], [class*="desc" i], [class*="text" i]'
    );

    let username = nameEl?.textContent?.trim() || "";
    let preview  = msgEl?.textContent?.trim() || "";

    // Structural fallback: first two non-empty leaf texts
    if (!username || !preview) {
      const leaves = Array.from(item.querySelectorAll("*"))
        .filter(el => el.childElementCount === 0 && el.textContent?.trim())
        .map(el => el.textContent.trim());
      if (!username) username = leaves[0] || "";
      if (!preview)  preview  = leaves[1] || "";
    }

    return { username, preview, hasUnread: itemHasUnread(item) };
  }

  function findConvByUsername(username) {
    return getConvItems().find(item =>
      (item.textContent || "").includes(username)
    ) || null;
  }

  // ── Send reply via Z2U chat UI ──────────────────────────────────────────────
  async function sendReplyToUser(username, text) {
    const item = findConvByUsername(username);
    if (!item) { WARN(`Sidebar item for "${username}" not found`); return; }

    item.click();
    await sleep(800);

    const input = document.querySelector(
      '[class*="messageInput"] textarea, [class*="chatInput"] textarea, ' +
      '[class*="inputBox"] textarea, textarea[placeholder], ' +
      'div[contenteditable="true"][class*="input"], ' +
      'div[contenteditable="true"][class*="msg"], ' +
      'div[contenteditable="true"][class*="chat"]'
    );
    if (!input) { WARN("Message input not found"); return; }

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
    if (sendBtn) sendBtn.click();
    else {
      input.dispatchEvent(new KeyboardEvent("keydown",  { key: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",    { key: "Enter", keyCode: 13, bubbles: true }));
    }
    LOG(`✅ Sent reply to "${username}": "${text.slice(0, 60)}"`);
  }

  // ── Main monitor loop ───────────────────────────────────────────────────────
  // seenMessages: in-memory dedup within this page session (prevents double-send
  // if a badge flickers or MutationObserver fires twice for the same item).
  const seenMessages = new Map(); // username → preview text we already forwarded this session
  let initialized = false;

  async function scanChats() {
    if (!isContextValid()) { shutdown("context lost during scan"); return; }
    const items = getConvItems();
    if (!items.length) return;

    for (const item of items) {
      const { username, preview, hasUnread } = extractConvInfo(item);
      if (!username || !preview) continue;

      if (!initialized) {
        // Initial scan: record the current preview so we can detect future changes.
        // ALSO forward right now if:
        //   (a) the item has an unread badge, AND
        //   (b) we haven't already forwarded this exact preview for this user
        //       (checked against persisted storage, which survives page refreshes)
        seenMessages.set(username, preview);
        if (hasUnread && chatForwarded[username] !== preview) {
          LOG(`Init-forward (unread on load): ${username}: "${preview.slice(0, 60)}"`);
          await forwardToTelegram(username, preview);
        }
        continue;
      }

      // Post-init: only act when the badge is visible
      if (!hasUnread) continue;

      // Avoid forwarding the same message twice in the same session
      if (seenMessages.get(username) === preview) continue;

      // Avoid re-forwarding something we already sent to Telegram (survives refresh)
      if (chatForwarded[username] === preview) {
        seenMessages.set(username, preview); // keep in-memory map in sync
        continue;
      }

      seenMessages.set(username, preview);
      LOG(`New message from ${username}: "${preview.slice(0, 60)}"`);
      await forwardToTelegram(username, preview);
    }

    if (!initialized) {
      initialized = true;
      LOG(`Initialized — ${seenMessages.size} conversations snapshotted`);
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────────────
  await sleep(2000); // Wait for page to fully render
  await loadChatForwarded();
  await scanChats();

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
