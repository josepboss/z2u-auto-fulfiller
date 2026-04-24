// chat.js — Z2U /Chat page: monitor incoming messages → Telegram; reply from Telegram → Z2U
// Completely independent of content.js (order fulfillment logic).
(async () => {
  const LOG  = (...a) => console.log("[Z2U-CHAT]", ...a);
  const WARN = (...a) => console.log("[Z2U-CHAT] ⚠", ...a); // log not warn — avoid chrome://extensions error panel entries
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const handles = { poll: null, refresh: null, observer: null };

  // ── Extension context guard ─────────────────────────────────────────────────
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function shutdown(reason) {
    // Do NOT log here — any console output from an invalidated extension context
    // shows up as an error entry in chrome://extensions, which confuses the user.
    if (handles.poll)     { try { clearInterval(handles.poll);    } catch {} handles.poll = null; }
    if (handles.refresh)  { try { clearTimeout(handles.refresh);  } catch {} handles.refresh = null; }
    if (handles.observer) { try { handles.observer.disconnect();  } catch {} handles.observer = null; }
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

  // Returns true if a leaf element looks like a badge (1-2 digit positive number,
  // NOT a pure time string like "22:39" and NOT part of a long sentence).
  function looksLikeBadge(el) {
    if (el.childElementCount > 0) return false;
    const t = el.textContent?.trim() || "";
    return /^[1-9]\d?$/.test(t); // 1-99 only, no colons/letters
  }

  // Find all conversation list items using a 4-strategy cascade.
  function getConvItems() {
    // ── Strategy 1: common class-name patterns ────────────────────────────────
    const classPatterns = [
      '[class*="chatListItem"]', '[class*="chat-list-item"]',
      '[class*="chatItem"]',     '[class*="contactItem"]',
      '[class*="conversationItem"]', '[class*="userListItem"]',
      '[class*="chat-user"]',    '[class*="msg-item"]',
      '[class*="imItem"]',       '[class*="im-item"]',
      '[class*="userItem"]',     '[class*="friendItem"]',
    ];
    for (const sel of classPatterns) {
      const items = Array.from(document.querySelectorAll(sel));
      if (items.length >= 2) return items;
    }

    // ── Strategy 2: li elements that contain an avatar <img> ─────────────────
    const lisWithImg = Array.from(document.querySelectorAll("li"))
      .filter(li => li.querySelector("img"));
    if (lisWithImg.length >= 2) return lisWithImg;

    // ── Strategy 3: badge-first — find a number badge, walk up to its list-item
    //    container, then return all siblings of that container ─────────────────
    const allEls = Array.from(document.querySelectorAll("*"));
    for (const el of allEls) {
      if (!looksLikeBadge(el)) continue;
      // Walk up until we find a sibling-rich parent (the list container)
      let node = el.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!node || node === document.body) break;
        const parent = node.parentElement;
        if (!parent) break;
        const siblings = Array.from(parent.children);
        // Each sibling should have at least 2 text-leaf children (name + message)
        const convLike = siblings.filter(s => {
          const texts = Array.from(s.querySelectorAll("*"))
            .filter(c => c.childElementCount === 0 && (c.textContent?.trim().length || 0) > 1);
          return texts.length >= 2;
        });
        if (convLike.length >= 3) return convLike; // Found the list!
        node = parent;
      }
    }

    // ── Strategy 4: structural — list-like containers in the left sidebar ─────
    const leftItems = Array.from(document.querySelectorAll(
      ".chatList li, [class*='chatList'] li, [class*='sideBar'] li, aside li, nav li"
    ));
    return leftItems;
  }

  // Returns true if the item contains a visible unread-count badge.
  function itemHasUnread(item) {
    return Array.from(item.querySelectorAll("*")).some(looksLikeBadge);
  }

  function extractConvInfo(item) {
    // Collect all leaf text nodes, filtering out pure numbers/timestamps/single chars
    const leaves = Array.from(item.querySelectorAll("*"))
      .filter(el => el.childElementCount === 0)
      .map(el => el.textContent?.trim() || "")
      .filter(t => t.length > 1 && !/^[\d:]+$/.test(t)); // skip badges & times

    const username = leaves[0] || "";
    const preview  = leaves[1] || "";

    return { username, preview, hasUnread: itemHasUnread(item) };
  }

  function findConvByUsername(username) {
    return getConvItems().find(item =>
      (item.textContent || "").includes(username)
    ) || null;
  }

  // ── Send reply via Z2U chat UI ──────────────────────────────────────────────
  // Helper: fire React's own onChange/onInput on an element so its internal
  // state actually updates (plain dispatchEvent alone doesn't reach React).
  function fireReactChange(el, value) {
    // Try __reactProps first (React 17+)
    const propKey = Object.keys(el).find(k => k.startsWith("__reactProps"));
    if (propKey) {
      const props = el[propKey];
      const synth = {
        target: el, currentTarget: el, type: "change", bubbles: true,
        nativeEvent: { target: el, data: value },
        preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
      };
      if (typeof props?.onChange === "function") { props.onChange(synth); return true; }
      if (typeof props?.onInput  === "function") { props.onInput(synth);  return true; }
    }
    // Try __reactFiber (React 16)
    const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternals"));
    if (fiberKey) {
      const fiber = el[fiberKey];
      const fn = fiber?.memoizedProps?.onChange || fiber?.memoizedProps?.onInput;
      if (typeof fn === "function") {
        fn({
          target: el, currentTarget: el, type: "change", bubbles: true,
          nativeEvent: { target: el, data: value },
          preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
        });
        return true;
      }
    }
    return false;
  }

  // ── Find the message input in the right (chat) panel ──────────────────────
  function findChatInput() {
    const SIDEBAR_SEL =
      '[class*="sideBar"], [class*="sidebar"], [class*="chatList"], ' +
      '[class*="chat-list"], [class*="userList"], aside, nav';

    // Returns true if this element looks like a SEARCH field (not a message input)
    function isSearchField(el) {
      if (el.type === "search") return true;
      const ph = (el.placeholder || el.getAttribute("placeholder") || "").toLowerCase();
      if (/search|find|filter|look|buscar|suche|chercher/i.test(ph)) return true;
      // If the element (or an ancestor within 5 levels) has a search-related class
      let node = el;
      for (let i = 0; i < 5; i++) {
        if (!node) break;
        if (/search|filter|find/i.test(node.className || "")) return true;
        node = node.parentElement;
      }
      return false;
    }

    // Collect ALL visible inputs that are NOT search fields
    const candidates = [];
    for (const el of document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]')) {
      if (!el.offsetParent) continue;          // invisible
      if (el.closest(SIDEBAR_SEL)) continue;  // known sidebar selectors
      if (isSearchField(el)) continue;         // looks like a search box → skip
      candidates.push(el);
    }

    if (!candidates.length) return null;

    // Priority 1: element whose placeholder explicitly says "message"
    const byPlaceholder = candidates.find(el => {
      const ph = (el.placeholder || el.getAttribute("placeholder") || "").toLowerCase();
      return /message|type|write|send|reply|chat/i.test(ph);
    });
    if (byPlaceholder) return byPlaceholder;

    // Priority 2: element inside a message-panel ancestor class
    const byAncestor = candidates.find(el =>
      el.closest('[class*="input"], [class*="compose"], [class*="editor"], [class*="msg"], [class*="bottom"], [class*="footer"], [class*="reply"]')
    );
    if (byAncestor) return byAncestor;

    // Fallback: last visible candidate (message inputs are at the bottom of the page)
    return candidates[candidates.length - 1];
  }

  // ── Inject text into any React-controlled input ─────────────────────────────
  async function injectText(input, text) {
    input.focus();
    input.click();
    await sleep(100);

    const isCE = input.getAttribute("contenteditable") === "true";

    // Method 1 (best for both types): execCommand "insertText"
    // The browser routes this through native IME → React's synthetic event system.
    if (isCE) input.textContent = "";
    else {
      // Clear textarea first
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, "");
      else input.value = "";
    }

    const execOk = document.execCommand("insertText", false, text);
    LOG(`injectText: execCommand insertText → ${execOk}, value="${(input.value || input.textContent || "").slice(0,40)}"`);

    // Method 2: dispatch a proper InputEvent (React 16/17 listens for this)
    if (!isCE) {
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: true,
        inputType: "insertText", data: text,
      }));
    }
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // Method 3: drive React's internal fiber onChange directly
    const reacted = fireReactChange(input, text);
    LOG(`injectText: fireReactChange → ${reacted}`);

    // Verify something landed
    const landed = (input.value || input.textContent || "").trim();
    LOG(`injectText: content after injection = "${landed.slice(0,60)}"`);
    return landed.length > 0;
  }

  // ── Find the send button in the chat panel ──────────────────────────────────
  function findSendButton(chatInputEl) {
    const SIDEBAR_SEL =
      '[class*="sideBar"], [class*="sidebar"], [class*="chatList"], ' +
      '[class*="chat-list"], aside, nav';

    // Look for buttons in the same panel as the input first
    const panel = chatInputEl?.closest(
      '[class*="input"], [class*="bottom"], [class*="footer"], [class*="compose"], [class*="editor"], [class*="chat"], [class*="msg"]'
    ) || document.body;

    const allBtns = Array.from(panel.querySelectorAll("button, [role='button']"));

    // 1. Named send button
    const named = allBtns.find(b => {
      if (!b.offsetParent || b.closest(SIDEBAR_SEL)) return false;
      const txt  = (b.textContent || "").trim().toLowerCase();
      const cls  = (b.className   || "").toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const ttip = (b.getAttribute("title") || "").toLowerCase();
      return /send|submit|发送|确认/.test(txt + " " + cls + " " + aria + " " + ttip);
    });
    if (named) return named;

    // 2. If there's only 1 visible button in the panel it's almost certainly Send
    const visible = allBtns.filter(b => b.offsetParent && !b.closest(SIDEBAR_SEL));
    if (visible.length === 1) return visible[0];

    // 3. Last visible button (send is usually on the right / bottom-right)
    return visible[visible.length - 1] || null;
  }

  async function sendReplyToUser(username, text) {
    const item = findConvByUsername(username);
    if (!item) { WARN(`Sidebar item for "${username}" not found`); return; }

    item.click();
    LOG(`Clicked "${username}" — waiting up to 5 s for chat input…`);

    // Give SPA time to start rendering the conversation, then poll
    await sleep(600);

    let input = null;
    const deadline = Date.now() + 4500;
    while (!input && Date.now() < deadline) {
      input = findChatInput();
      if (!input) await sleep(300);
    }

    if (!input) {
      WARN(`No message input found for "${username}" — run _z2uChatDebug.dumpInputs() to inspect the DOM`);
      return;
    }

    LOG(`Input found: <${input.tagName} contenteditable="${input.getAttribute("contenteditable")}" class="${input.className.slice(0,80)}">`);

    const injected = await injectText(input, text);
    if (!injected) {
      WARN(`Text injection may have failed — content field appears empty. Attempting send anyway.`);
    }

    await sleep(300);

    const sendBtn = findSendButton(input);
    LOG(`Send button: ${sendBtn ? `<${sendBtn.tagName} class="${sendBtn.className.slice(0,60)}">` : "not found — will use Enter"}`);

    if (sendBtn) {
      sendBtn.click();
      LOG(`✅ Clicked send button for "${username}"`);
    } else {
      const evtOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent("keydown",  evtOpts));
      input.dispatchEvent(new KeyboardEvent("keypress", evtOpts));
      input.dispatchEvent(new KeyboardEvent("keyup",    evtOpts));
      LOG(`✅ Enter key sent for "${username}"`);
    }

    LOG(`✅ Reply dispatched to "${username}": "${text.slice(0, 60)}"`);
  }

  // ── Main monitor loop ───────────────────────────────────────────────────────
  // seenMessages: in-memory dedup within this page session (prevents double-send
  // if a badge flickers or MutationObserver fires twice for the same item).
  const seenMessages = new Map(); // username → preview text we already forwarded this session
  let initialized = false;

  async function scanChats() {
    if (!isContextValid()) { shutdown("context lost during scan"); return; }
    const items = getConvItems();
    if (!items.length) {
      if (!initialized) WARN("getConvItems() returned 0 — open DevTools and run: _z2uChatDebug.dump()");
      return;
    }
    if (!initialized) LOG(`getConvItems() found ${items.length} items`);

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

  // ── Debug helpers (call from DevTools on z2u.com/Chat) ─────────────────────
  window._z2uChatDebug = {
    // Force-send a fake message to Telegram to verify the pipeline
    test: () => forwardToTelegram("DebugUser", "Test message from z2u chat content script"),
    // Dump the current conversation list to console
    dump: () => {
      const items = getConvItems();
      LOG(`getConvItems() → ${items.length} items`);
      items.forEach((item, i) => {
        const info = extractConvInfo(item);
        LOG(`  [${i}] username="${info.username}" preview="${info.preview}" hasUnread=${info.hasUnread}`);
      });
    },
    // Show persisted forwarded map
    forwarded: () => LOG("chatForwarded:", JSON.stringify(chatForwarded)),
    // Dump ALL visible inputs on the page — run this after clicking a chat to
    // see exactly what element the extension should target
    dumpInputs: () => {
      const all = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]'));
      LOG(`All inputs on page (${all.length} total):`);
      all.forEach((el, i) => {
        const vis    = !!el.offsetParent;
        const inSide = !!el.closest('[class*="sideBar"],[class*="sidebar"],[class*="chatList"],aside,nav');
        const ph     = el.placeholder || el.getAttribute("placeholder") || "";
        LOG(`  [${i}] <${el.tagName} type="${el.type}" ce="${el.getAttribute("contenteditable")}" vis=${vis} inSidebar=${inSide}>`);
        LOG(`       placeholder="${ph}" class="${el.className.slice(0,100)}"`);
        LOG(`       value="${(el.value || el.textContent || "").slice(0,40)}"`);
      });
      const picked = findChatInput();
      LOG(`findChatInput() → `, picked
        ? `<${picked.tagName} placeholder="${picked.placeholder || picked.getAttribute("placeholder") || ""}" class="${picked.className.slice(0,80)}">`
        : "null — no input found");
    },
    // Test sending a reply to a specific username from DevTools
    // Usage: _z2uChatDebug.testReply("buyerUsername", "hello!")
    testReply: (username, text) => sendReplyToUser(username, text || "Test reply from extension"),
  };

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

  LOG("Chat monitor started on", window.location.href);
})().catch(e => console.warn("[Z2U-CHAT] Fatal error:", e.message));
