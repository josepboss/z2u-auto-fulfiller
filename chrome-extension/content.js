(() => {
  "use strict";

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function clickElement(el, label) {
    if (!el) {
      console.warn(`[Z2U] ❌ Element not found: ${label}`);
      return false;
    }
    el.click();
    console.log(`[Z2U] ✅ Clicked: ${label}`);
    return true;
  }

  async function waitForElement(selector, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  async function waitForElementByText(tag, text, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const els = document.querySelectorAll(tag);
      const found = Array.from(els).find(
        (el) => el.textContent?.trim().toLowerCase().includes(text.toLowerCase())
      );
      if (found) return found;
      await sleep(300);
    }
    return null;
  }

  const inProgressThisSession = new Set();

  function isProcessedInBackground(orderId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "IS_PROCESSED", orderId }, (res) => {
        resolve(res?.processed === true);
      });
    });
  }

  function markProcessedInBackground(orderId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "MARK_PROCESSED", orderId }, resolve);
    });
  }

  async function downloadTemplateAsBlob(templateUrl) {
    const res = await fetch(templateUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`Template download failed: ${res.status}`);
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function uploadFilledFile(filledBytes, uploadSelector, confirmBtnSelector) {
    const dataTransfer = new DataTransfer();
    const file = new File(
      [new Uint8Array(filledBytes)],
      "fulfilled_order.xlsx",
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    );
    dataTransfer.items.add(file);

    const input = document.querySelector(uploadSelector);
    if (!input) {
      console.error("[Z2U] File input not found:", uploadSelector);
      return false;
    }
    Object.defineProperty(input, "files", { value: dataTransfer.files, writable: false });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(1500);

    const confirmBtn = await waitForElement(confirmBtnSelector, 5000);
    if (confirmBtn) {
      confirmBtn.click();
      console.log("[Z2U] Clicked Confirm Delivered.");
      return true;
    }
    return false;
  }

  // ── Order ID extraction ────────────────────────────────────────────────────
  // Z2U renders two rows per order. The first row contains the order number
  // in text like "Order number: Z5252643865". We look at the row itself and
  // the previous sibling row.
  function extractOrderId(row) {
    // 1. data attribute
    const byAttr = row.getAttribute("data-id") ||
      row.getAttribute("data-order-id") ||
      row.getAttribute("data-orderid");
    if (byAttr) return byAttr.trim();

    // 2. Look for "Order number:" text in this row or the preceding sibling row
    const searchTargets = [row];
    const prev = row.previousElementSibling;
    if (prev) searchTargets.unshift(prev);

    for (const target of searchTargets) {
      const text = target.textContent || "";
      // Matches "Order number: Z5252643865" or "Order number：Z52526..."
      const match = text.match(/Order\s*(?:number|num)[：:]\s*([A-Z0-9\-]+)/i);
      if (match) return match[1].trim();
    }

    // 3. Any cell whose text looks like an order number (all caps/digits, 8+chars)
    for (const td of row.querySelectorAll("td, [class*='order']")) {
      const t = td.textContent?.trim() || "";
      if (/^[A-Z0-9]{8,}$/.test(t)) return t;
    }

    return null;
  }

  // ── Title extraction ───────────────────────────────────────────────────────
  // The product title lives in the first <td> of the data row, possibly inside
  // a nested element. We grab the deepest text that looks like a product title.
  function extractTitle(row) {
    // Try class-based selectors first
    for (const sel of [
      '[class*="title"]',
      '[class*="product-name"]',
      '[class*="productName"]',
      '[class*="goods-name"]',
    ]) {
      const el = row.querySelector(sel);
      if (el) return el.textContent?.trim() || "";
    }
    // Fall back: first <td> — strip the order-number line if it appears there
    const firstTd = row.querySelector("td:nth-child(1)");
    if (firstTd) {
      // Clone and remove child elements that contain dates / buyer info
      const clone = firstTd.cloneNode(true);
      clone.querySelectorAll('[class*="order-num"], [class*="buyer"], [class*="date"], small, span.num')
        .forEach((el) => el.remove());
      return clone.textContent?.trim() || "";
    }
    return "";
  }

  // ── Status extraction ──────────────────────────────────────────────────────
  // Status is in column 4 in the Z2U seller order table
  function extractStatus(row) {
    for (const sel of [
      '[class*="status"]',
      '[class*="order-status"]',
      'td:nth-child(4)',
    ]) {
      const el = row.querySelector(sel);
      if (el) return el.textContent?.trim() || "";
    }
    return "";
  }

  async function processOrderRow(row, mappings) {
    const status = extractStatus(row);
    if (!status.toUpperCase().includes("NEW ORDER")) return;

    const fullTitle = extractTitle(row);
    const orderId = extractOrderId(row);
    const quantityCell = row.querySelector(
      '[class*="quantity"], [class*="qty"], td:nth-child(4)'
    );
    const quantity = parseInt(quantityCell?.textContent?.trim() || "1", 10);

    // ── Debug log so you can see exactly what was detected ─────────────────
    console.log(`[Z2U] 🔍 Row detected | status="${status}" | orderId="${orderId}" | title="${fullTitle}" | qty=${quantity}`);

    if (!orderId) {
      console.warn("[Z2U] ⚠️ Could not extract order ID — skipping row to avoid duplicate.");
      return;
    }

    if (!mappings[fullTitle]) {
      console.log(`[Z2U] ℹ️ No mapping for: "${fullTitle}"`);
      console.log("[Z2U] ℹ️ Available mappings:", Object.keys(mappings));
      return;
    }

    // Deduplication
    if (inProgressThisSession.has(orderId)) {
      console.log(`[Z2U] Order ${orderId} already in progress this session.`);
      return;
    }
    const alreadyDone = await isProcessedInBackground(orderId);
    if (alreadyDone) {
      console.log(`[Z2U] Order ${orderId} already processed (persistent).`);
      return;
    }

    // Reserve immediately
    inProgressThisSession.add(orderId);
    await markProcessedInBackground(orderId);

    console.log(`[Z2U] 🚀 Starting fulfillment for order ${orderId}: "${fullTitle}" x${quantity}`);

    try {
      // ── Step 1: Click "Prepare" ──────────────────────────────────────────
      // Try button/link inside the row first
      let prepareBtn =
        row.querySelector('button[class*="prepare"], a[class*="prepare"]') ||
        Array.from(row.querySelectorAll("button, a")).find(
          (el) => el.textContent?.trim().toLowerCase() === "prepare"
        );

      // If not in the row, try "Order Detail" link to open the detail view
      if (!prepareBtn) {
        const detailLink =
          row.querySelector('a[class*="detail"], a[href*="detail"]') ||
          Array.from(row.querySelectorAll("a, button")).find(
            (el) => el.textContent?.trim().toLowerCase().includes("order detail")
          );
        if (detailLink) {
          console.log("[Z2U] Clicking 'Order Detail' to open detail view...");
          detailLink.click();
          await sleep(2500);
          // Now look for Prepare in the modal / expanded panel
          prepareBtn =
            await waitForElement('button[class*="prepare"], a[class*="prepare"]', 5000) ||
            await waitForElementByText("button, a", "prepare", 5000);
        }
      }

      if (!clickElement(prepareBtn, "Prepare")) {
        console.error("[Z2U] ❌ Prepare button not found. Check DevTools for the button's class name.");
        return;
      }
      await sleep(2500);

      // ── Step 2: Click "Start Trading" ────────────────────────────────────
      const startTradingBtn =
        await waitForElement(
          'button[class*="start"], button[class*="trading"], a[class*="trading"]', 6000
        ) ||
        await waitForElementByText("button, a", "start trading", 6000);

      if (!clickElement(startTradingBtn, "Start Trading")) {
        console.error("[Z2U] ❌ Start Trading button not found.");
        return;
      }
      await sleep(2500);

      // ── Step 3: Confirm popup (if any) ───────────────────────────────────
      const confirmPopupBtn =
        await waitForElement(
          '.modal button[class*="confirm"], .popup button[class*="confirm"], .dialog button[class*="confirm"], [class*="modal"] button[class*="ok"]',
          4000
        ) ||
        await waitForElementByText(
          ".modal button, .popup button, .dialog button, [class*='modal'] button",
          "confirm",
          4000
        );
      if (confirmPopupBtn) {
        clickElement(confirmPopupBtn, "Confirm (popup)");
        await sleep(2500);
      }

      // ── Step 4: Download template ─────────────────────────────────────────
      const templateLinkEl = document.querySelector(
        'a[href*="template"], a[href*=".xlsx"], a[download]'
      );
      const templateUrl = templateLinkEl?.getAttribute("href");

      if (!templateUrl) {
        console.error("[Z2U] ❌ Could not find template download link.");
        return;
      }

      let templateBlob;
      try {
        templateBlob = await downloadTemplateAsBlob(templateUrl);
      } catch (err) {
        console.error("[Z2U] Template download failed:", err);
        return;
      }

      // ── Step 5: Send to backend ───────────────────────────────────────────
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: "PROCESS_ORDER",
            data: {
              orderId,
              title: fullTitle,
              quantity,
              templateBlob: Array.from(templateBlob),
            },
          },
          resolve
        );
      });

      if (!response || !response.ok) {
        console.error("[Z2U] Backend processing failed:", response?.error);
        return;
      }
      if (response.result?.skipped) {
        console.log(`[Z2U] Order ${orderId} skipped by backend.`);
        return;
      }

      const filledBytes = response.result.filledFile;

      // ── Step 6: Upload filled file + confirm delivered ────────────────────
      const uploaded = await uploadFilledFile(
        filledBytes,
        'input[type="file"]',
        'button[class*="delivered"], button[class*="confirm-delivered"], button[class*="confirmDelivered"]'
      );

      if (uploaded) {
        console.log(`[Z2U] ✅ Order ${orderId} fully processed and delivered.`);
      }
    } catch (err) {
      console.error(`[Z2U] Unexpected error processing order ${orderId}:`, err);
    }
  }

  async function scanPage() {
    console.log("[Z2U] 🔄 Scanning page for new orders...");

    const mappings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_MAPPINGS" }, (response) => {
        resolve(response?.mappings || {});
      });
    });

    if (!Object.keys(mappings).length) {
      console.log("[Z2U] ⚠️ No mappings configured yet.");
      return;
    }

    console.log("[Z2U] Loaded mappings:", Object.keys(mappings));

    const rows = document.querySelectorAll(
      "table tbody tr, [class*='order-row'], [class*='order-item']"
    );
    console.log(`[Z2U] Found ${rows.length} row(s) on page.`);

    for (const row of rows) {
      try {
        await processOrderRow(row, mappings);
      } catch (err) {
        console.error("[Z2U] Error processing row:", err);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(scanPage, 2000);
    });
  } else {
    setTimeout(scanPage, 2000);
  }
})();
