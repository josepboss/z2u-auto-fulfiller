(() => {
  "use strict";

  const href = window.location.href;
  const isListPage  = /sellOrder\/index/.test(href);
  const isDetailPage = !isListPage && /sellOrder(\?|$)/.test(href);

  // ── Shared utilities ───────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForElementByText(selectors, text, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const sel of selectors.split(",")) {
        const els = document.querySelectorAll(sel.trim());
        const found = Array.from(els).find(
          (el) => el.textContent?.trim().toUpperCase().includes(text.toUpperCase())
        );
        if (found) return found;
      }
      await sleep(400);
    }
    return null;
  }

  async function waitForSelector(selector, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(400);
    }
    return null;
  }

  function clickBtn(el, label) {
    if (!el) { console.warn(`[Z2U] ❌ Not found: ${label}`); return false; }
    el.click();
    console.log(`[Z2U] ✅ Clicked: ${label}`);
    return true;
  }

  // ── Persistent processed set (via background) ──────────────────────────────

  const sessionDone = new Set();

  function bgIsProcessed(orderId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "IS_PROCESSED", orderId }, (r) =>
        resolve(r?.processed === true)
      );
    });
  }

  function bgMarkProcessed(orderId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "MARK_PROCESSED", orderId }, resolve);
    });
  }

  // ── Template download ──────────────────────────────────────────────────────

  async function downloadBlob(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ── Backend call ───────────────────────────────────────────────────────────

  function sendToBackend(data) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "PROCESS_ORDER", data }, resolve);
    });
  }

  // ── Upload filled file ─────────────────────────────────────────────────────

  async function uploadAndConfirm(filledBytes) {
    const input = await waitForSelector('input[type="file"]', 8000);
    if (!input) { console.error("[Z2U] File input not found."); return false; }

    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(filledBytes)], "fulfilled_order.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    Object.defineProperty(input, "files", { value: dt.files, writable: false });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(2000);

    // Confirm delivered button
    const confirmDeliveredBtn = await waitForElementByText(
      "button, a", "confirm delivered", 8000
    ) || await waitForElementByText("button, a", "delivered", 5000);

    if (confirmDeliveredBtn) {
      confirmDeliveredBtn.click();
      console.log("[Z2U] ✅ Clicked Confirm Delivered.");
      return true;
    }
    console.warn("[Z2U] ⚠️ Confirm Delivered button not found.");
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LIST PAGE  (z2u.com/sellOrder/index)
  //  – Scans for NEW ORDER rows, reads title + orderId, navigates to detail
  // ══════════════════════════════════════════════════════════════════════════

  async function runListPage() {
    console.log("[Z2U] 📋 List page scan started.");

    const mappings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_MAPPINGS" }, (r) =>
        resolve(r?.mappings || {})
      );
    });

    if (!Object.keys(mappings).length) {
      console.log("[Z2U] ⚠️ No mappings configured.");
      return;
    }
    console.log("[Z2U] Mappings:", Object.keys(mappings));

    // Z2U renders each order as a .orderPanel div (NOT table rows).
    // Structure:
    //   .orderPanel
    //     .panelHead
    //       .o-number  → contains <a>Z1144625572</a> and <span class="neworder">
    //     .panelBody
    //       .o-l-col.productInfo  → <a>Product Title</a>
    //       .o-l-col.productStatus → <div class="smLabel dangerLabel">NEW ORDER</div>
    //                                <a href="/sellOrder?order_id=...">Order Detail</a>
    const panels = document.querySelectorAll(".orderPanel");
    console.log(`[Z2U] Found ${panels.length} .orderPanel(s).`);

    for (const panel of panels) {
      // Only process panels with a "NEW ORDER" status badge
      const statusBadge = panel.querySelector(".smLabel.dangerLabel");
      if (!statusBadge || !statusBadge.textContent.trim().toUpperCase().includes("NEW ORDER")) continue;

      // Order ID: from the clipboard data attribute (most reliable) or link text
      const copyBtn = panel.querySelector("[data-clipboard-text]");
      const orderIdFromClipboard = copyBtn?.getAttribute("data-clipboard-text")?.trim();
      const orderIdFromLink = panel.querySelector(".o-number a")?.textContent?.trim();
      const orderId = orderIdFromClipboard || orderIdFromLink;

      // Product title: the anchor inside .productInfo
      const titleEl = panel.querySelector(".o-l-col.productInfo a");
      const title = titleEl?.textContent?.trim() || "";

      // Order detail link: anchor inside .productStatus pointing to /sellOrder
      const detailLink = panel.querySelector('.o-l-col.productStatus a[href*="sellOrder"]');
      const detailHref = detailLink?.getAttribute("href");

      console.log(`[Z2U] 🔍 NEW ORDER panel | orderId="${orderId}" | title="${title.slice(0, 60)}..." | detailHref="${detailHref}"`);

      if (!orderId) {
        console.warn("[Z2U] ⚠️ Could not extract orderId — skipping panel.");
        continue;
      }

      if (!mappings[title]) {
        console.log(`[Z2U] ℹ️ No mapping for: "${title}"`);
        console.log("[Z2U] ℹ️ Available mappings:", Object.keys(mappings));
        continue;
      }

      if (sessionDone.has(orderId)) continue;
      if (await bgIsProcessed(orderId)) {
        console.log(`[Z2U] Order ${orderId} already processed.`);
        continue;
      }

      if (!detailHref) {
        console.warn(`[Z2U] ⚠️ No detail link found for order ${orderId}.`);
        continue;
      }

      // Save context for the detail page to pick up
      await chrome.storage.local.set({ pendingOrderId: orderId, pendingTitle: title });
      console.log(`[Z2U] 🔗 Navigating to detail: ${detailHref}`);
      window.location.href = detailHref;
      return; // navigation in progress — stop scanning
    }

    console.log("[Z2U] ✅ List scan complete. No unprocessed NEW ORDER panels found.");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DETAIL PAGE  (z2u.com/sellOrder?order_id=Z...)
  //  – Self-contained: reads title & quantity from the page itself.
  //  – No stored-context dependency, so it works regardless of how you arrived.
  // ══════════════════════════════════════════════════════════════════════════

  async function runDetailPage() {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order_id") || params.get("orderId");

    console.log(`[Z2U] 📄 Detail page | orderId="${orderId}"`);

    if (!orderId) {
      console.warn("[Z2U] No order_id in URL.");
      return;
    }

    // ── Guard: must be NEW ORDER status ─────────────────────────────────────
    // Give the page a moment to fully render
    await sleep(1000);
    const pageText = document.body.textContent || "";
    if (!pageText.toUpperCase().includes("NEW ORDER")) {
      console.log(`[Z2U] Order ${orderId} is not in NEW ORDER state — skipping.`);
      return;
    }

    // ── Extract title from the detail page directly ──────────────────────────
    // The page has a row: "Product Title : <title text>"
    // Try multiple approaches to find it.
    let title = "";

    // Approach 1: look for a label cell containing "Product Title" and read its sibling/next element
    const allPageElements = Array.from(document.querySelectorAll("*"));
    for (const el of allPageElements) {
      const t = el.childElementCount === 0 ? el.textContent?.trim() : "";
      if (t && /^product\s*title$/i.test(t)) {
        // Next sibling or parent's next child
        const sibling = el.nextElementSibling || el.parentElement?.nextElementSibling;
        if (sibling) { title = sibling.textContent?.trim() || ""; break; }
      }
    }

    // Approach 2: look inside a dl/table structure
    if (!title) {
      const rows = document.querySelectorAll("tr, dl dt, .info-row, .detail-row");
      for (const row of rows) {
        if ((row.textContent || "").toLowerCase().includes("product title")) {
          const nextEl = row.nextElementSibling || row.querySelector("td:nth-child(2), dd");
          title = nextEl?.textContent?.trim() || "";
          if (title) break;
        }
      }
    }

    console.log(`[Z2U] 📄 Title from page: "${title.slice(0, 80)}..."`);

    // ── Check mapping ────────────────────────────────────────────────────────
    const mappings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_MAPPINGS" }, (r) =>
        resolve(r?.mappings || {})
      );
    });

    if (!mappings[title]) {
      console.log(`[Z2U] ℹ️ No mapping for: "${title}"`);
      console.log("[Z2U] ℹ️ Available mappings:", Object.keys(mappings));
      // Clear pending so list page can retry
      await chrome.storage.local.remove(["pendingOrderId", "pendingTitle"]);
      return;
    }

    // ── Dedup (session only — persistent mark happens only on success) ────────
    if (sessionDone.has(orderId)) {
      console.log(`[Z2U] Order ${orderId} already in progress this session.`);
      return;
    }
    if (await bgIsProcessed(orderId)) {
      console.log(`[Z2U] Order ${orderId} already completed (persistent).`);
      return;
    }
    sessionDone.add(orderId);

    // Clear the pending context now that we've picked it up
    await chrome.storage.local.remove(["pendingOrderId", "pendingTitle"]);

    // ── Extract quantity ─────────────────────────────────────────────────────
    let quantity = 1;
    const allNodes = Array.from(document.querySelectorAll("*"));
    for (let j = 0; j < allNodes.length; j++) {
      const t = allNodes[j].childElementCount === 0 ? allNodes[j].textContent?.trim() : "";
      if (t && /^quantity$/i.test(t)) {
        const next = allNodes[j].nextElementSibling || allNodes[j].parentElement?.nextElementSibling;
        const val = parseInt(next?.textContent?.trim() || "0", 10);
        if (val > 0) { quantity = val; break; }
      }
    }
    console.log(`[Z2U] Quantity: ${quantity}`);

    console.log(`[Z2U] 🚀 Starting fulfillment | orderId=${orderId} | qty=${quantity}`);

    try {
      // ── Step 1: Click PREPARING ──────────────────────────────────────────
      // The button is rendered as <button>PREPARING</button> (red button)
      const preparingBtn =
        await waitForElementByText("button, a", "PREPARING", 8000);
      if (!clickBtn(preparingBtn, "PREPARING")) {
        console.error("[Z2U] ❌ PREPARING button not found. Page buttons:", 
          Array.from(document.querySelectorAll("button")).map(b => b.textContent?.trim()));
        return;
      }
      await sleep(3000);

      // ── Step 2: Click START TRADING ──────────────────────────────────────
      const startTradingBtn =
        await waitForElementByText("button, a", "START TRADING", 10000);
      if (!clickBtn(startTradingBtn, "START TRADING")) {
        console.error("[Z2U] ❌ START TRADING button not found.");
        return;
      }
      await sleep(2500);

      // ── Step 3: Confirm modal ────────────────────────────────────────────
      // Modal has CANCEL (red) and CONFIRM (green) — we want CONFIRM
      const allConfirmBtns = await (async () => {
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          const btns = Array.from(document.querySelectorAll("button")).filter(
            (b) => b.textContent?.trim().toUpperCase() === "CONFIRM"
          );
          if (btns.length) return btns;
          await sleep(400);
        }
        return [];
      })();
      if (allConfirmBtns.length) {
        // Pick the last CONFIRM (green one, not cancel)
        clickBtn(allConfirmBtns[allConfirmBtns.length - 1], "CONFIRM (modal)");
        await sleep(3000);
      } else {
        console.warn("[Z2U] ⚠️ Confirm modal not found — continuing anyway.");
      }

      // ── Step 4: Download template ────────────────────────────────────────
      const templateLink = document.querySelector(
        'a[href*="template"], a[href*=".xlsx"], a[download]'
      );
      if (!templateLink) {
        console.error("[Z2U] ❌ Template download link not found.");
        return;
      }
      const templateUrl = templateLink.getAttribute("href");
      const templateBlob = await downloadBlob(templateUrl);

      // ── Step 5: Send to backend ──────────────────────────────────────────
      const response = await sendToBackend({
        orderId,
        title,
        quantity,
        templateBlob: Array.from(templateBlob),
      });

      if (!response?.ok) {
        console.error("[Z2U] Backend error:", response?.error);
        return;
      }
      if (response.result?.skipped) {
        console.log(`[Z2U] Backend skipped order ${orderId}.`);
        return;
      }

      const filledBytes = response.result.filledFile;

      // ── Step 6: Upload + confirm delivered ───────────────────────────────
      const uploaded = await uploadAndConfirm(filledBytes);
      if (uploaded) {
        // Mark as processed ONLY after successful delivery
        await bgMarkProcessed(orderId);
        console.log(`[Z2U] ✅ Order ${orderId} fully completed and marked as processed.`);
      }
    } catch (err) {
      console.error(`[Z2U] ❌ Error on order ${orderId}:`, err);
    }
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  function init() {
    if (isListPage) {
      console.log("[Z2U] Running on LIST page.");
      setTimeout(runListPage, 2500);
    } else if (isDetailPage) {
      console.log("[Z2U] Running on DETAIL page.");
      setTimeout(runDetailPage, 2500);
    } else {
      console.log("[Z2U] Unrecognised page:", href);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
