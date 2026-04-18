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

    // Each order in the table is TWO <tr>s:
    //   Row A (info):  order number, buyer, date
    //   Row B (data):  product | price | type | status | remarks | total
    // We look for data rows whose status cell contains "NEW ORDER".
    const allRows = Array.from(document.querySelectorAll("table tbody tr"));
    console.log(`[Z2U] Found ${allRows.length} table rows.`);

    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      const rowText = row.textContent || "";

      // Skip header or info rows — data rows contain a price (USD)
      if (!rowText.includes("NEW ORDER")) continue;

      // Extract orderId from this row OR the preceding sibling (info row)
      let orderId = null;
      const infoRow = allRows[i - 1] || null;
      for (const src of [row, infoRow].filter(Boolean)) {
        const m = (src.textContent || "").match(/Order\s*(?:number|num)[：:]\s*([A-Z0-9]+)/i);
        if (m) { orderId = m[1].trim(); break; }
      }

      // Extract product title — first <td>, strip sub-elements if possible
      let title = "";
      const firstTd = row.querySelector("td:nth-child(1)");
      if (firstTd) {
        // Try to grab a named element first
        const named = firstTd.querySelector('[class*="title"],[class*="name"],[class*="product"]');
        title = named?.textContent?.trim() || firstTd.textContent?.trim() || "";
      }

      console.log(`[Z2U] 🔍 NEW ORDER row | orderId="${orderId}" | title="${title.slice(0,60)}..."`);

      if (!orderId) {
        console.warn("[Z2U] ⚠️ Could not extract orderId — skipping.");
        continue;
      }

      if (!mappings[title]) {
        console.log(`[Z2U] ℹ️ No mapping for title. Available: ${JSON.stringify(Object.keys(mappings))}`);
        continue;
      }

      if (sessionDone.has(orderId)) continue;
      if (await bgIsProcessed(orderId)) {
        console.log(`[Z2U] Order ${orderId} already processed.`);
        continue;
      }

      // Navigate to the order detail page
      // The "Order Detail" link is in the status cell
      const detailLink =
        row.querySelector('a[href*="sellOrder"]') ||
        Array.from(row.querySelectorAll("a")).find(
          (a) => a.textContent?.trim().toLowerCase().includes("order detail")
        );

      if (detailLink) {
        const detailHref = detailLink.getAttribute("href");
        console.log(`[Z2U] 🔗 Navigating to detail: ${detailHref}`);
        // Save the pending orderId so the detail page can pick it up
        await chrome.storage.local.set({ pendingOrderId: orderId, pendingTitle: title });
        window.location.href = detailHref;
        return; // navigation in progress — stop scanning
      } else {
        // Try building the URL from the order ID
        const detailUrl = `https://www.z2u.com/sellOrder?order_id=${orderId}`;
        console.log(`[Z2U] 🔗 No link found, navigating to: ${detailUrl}`);
        await chrome.storage.local.set({ pendingOrderId: orderId, pendingTitle: title });
        window.location.href = detailUrl;
        return;
      }
    }

    console.log("[Z2U] ✅ List scan complete. No unprocessed NEW ORDER rows found.");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DETAIL PAGE  (z2u.com/sellOrder?order_id=Z...)
  //  – Runs the full PREPARING → START TRADING → CONFIRM → upload flow
  // ══════════════════════════════════════════════════════════════════════════

  async function runDetailPage() {
    // Extract orderId from URL
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order_id") || params.get("orderId");

    console.log(`[Z2U] 📄 Detail page | orderId="${orderId}"`);

    if (!orderId) {
      console.warn("[Z2U] No order_id in URL.");
      return;
    }

    // Read pending info set by list page (title + orderId)
    const stored = await chrome.storage.local.get(["pendingOrderId", "pendingTitle"]);
    const title = (stored.pendingOrderId === orderId) ? stored.pendingTitle : null;

    if (!title) {
      console.log(`[Z2U] No pending context for ${orderId} — not triggered by automation.`);
      return;
    }

    if (sessionDone.has(orderId)) return;
    if (await bgIsProcessed(orderId)) {
      console.log(`[Z2U] Order ${orderId} already processed.`);
      return;
    }

    // Reserve immediately
    sessionDone.add(orderId);
    await bgMarkProcessed(orderId);
    // Clear pending so this won't retrigger
    await chrome.storage.local.remove(["pendingOrderId", "pendingTitle"]);

    console.log(`[Z2U] 🚀 Starting fulfillment | orderId=${orderId} | title="${title.slice(0,50)}..."`);

    try {
      // ── Step 1: Click PREPARING ──────────────────────────────────────────
      const preparingBtn = await waitForElementByText("button", "PREPARING", 8000);
      if (!clickBtn(preparingBtn, "PREPARING")) return;
      await sleep(3000);

      // ── Step 2: Click START TRADING ──────────────────────────────────────
      const startTradingBtn = await waitForElementByText("button", "START TRADING", 10000);
      if (!clickBtn(startTradingBtn, "START TRADING")) return;
      await sleep(2500);

      // ── Step 3: Confirm modal — "Whether to confirm?" → CONFIRM ─────────
      const confirmBtn = await waitForElementByText(
        "button", "CONFIRM", 8000
      );
      if (confirmBtn) {
        // Make sure we click the green CONFIRM, not CANCEL
        // CONFIRM is usually the last / rightmost button in the modal
        const allBtns = Array.from(document.querySelectorAll("button")).filter(
          (b) => b.textContent?.trim().toUpperCase() === "CONFIRM"
        );
        const greenBtn = allBtns[allBtns.length - 1] || confirmBtn;
        clickBtn(greenBtn, "CONFIRM (modal)");
        await sleep(3000);
      }

      // ── Step 4: Extract quantity from the page ───────────────────────────
      let quantity = 1;
      // Look for a row labelled "QUANTITY" in the order info table
      const allCells = Array.from(document.querySelectorAll("td, th, dt, dd, [class*='label'], [class*='value']"));
      for (let j = 0; j < allCells.length; j++) {
        if ((allCells[j].textContent || "").trim().toUpperCase() === "QUANTITY") {
          const val = parseInt(allCells[j + 1]?.textContent?.trim() || "0", 10);
          if (val > 0) { quantity = val; break; }
        }
      }
      console.log(`[Z2U] Quantity: ${quantity}`);

      // ── Step 5: Download template ────────────────────────────────────────
      const templateLink = document.querySelector(
        'a[href*="template"], a[href*=".xlsx"], a[download]'
      );
      if (!templateLink) {
        console.error("[Z2U] ❌ Template download link not found.");
        return;
      }
      const templateUrl = templateLink.getAttribute("href");
      const templateBlob = await downloadBlob(templateUrl);

      // ── Step 6: Send to backend ──────────────────────────────────────────
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

      // ── Step 7: Upload and confirm delivered ─────────────────────────────
      const uploaded = await uploadAndConfirm(filledBytes);
      if (uploaded) {
        console.log(`[Z2U] ✅ Order ${orderId} fully completed.`);
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
