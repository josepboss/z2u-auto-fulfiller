(() => {
  "use strict";

  const PROCESSED_KEY = "z2u_processed_orders";

  function getProcessedOrders() {
    try {
      return new Set(JSON.parse(localStorage.getItem(PROCESSED_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function markProcessed(orderId) {
    const set = getProcessedOrders();
    set.add(orderId);
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(Array.from(set)));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function clickElement(el, label) {
    if (!el) {
      console.warn(`[Z2U] Element not found: ${label}`);
      return false;
    }
    el.click();
    console.log(`[Z2U] Clicked: ${label}`);
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

  async function processOrderRow(row, mappings) {
    const statusCell = row.querySelector('[class*="status"], td:nth-child(3)');
    const status = statusCell?.textContent?.trim() || "";

    if (!status.toUpperCase().includes("NEW ORDER")) return;

    const titleCell = row.querySelector('[class*="title"], td:nth-child(2)');
    const fullTitle = titleCell?.textContent?.trim() || "";

    const orderIdCell = row.querySelector('[class*="order-id"], [class*="orderId"], td:nth-child(1)');
    const orderId = orderIdCell?.textContent?.trim() || String(Date.now());

    const quantityCell = row.querySelector('[class*="quantity"], [class*="qty"], td:nth-child(4)');
    const quantity = parseInt(quantityCell?.textContent?.trim() || "1", 10);

    if (!mappings[fullTitle]) {
      console.log(`[Z2U] No mapping for: "${fullTitle}", skipping.`);
      return;
    }

    const processed = getProcessedOrders();
    if (processed.has(orderId)) {
      console.log(`[Z2U] Order ${orderId} already processed.`);
      return;
    }

    console.log(`[Z2U] Processing order ${orderId}: "${fullTitle}" x${quantity}`);

    const prepareBtn = row.querySelector('button[class*="prepare"], a[class*="prepare"]') ||
      Array.from(row.querySelectorAll("button, a")).find(
        (el) => el.textContent?.trim().toLowerCase() === "prepare"
      );
    if (!clickElement(prepareBtn, "Prepare")) return;
    await sleep(2000);

    const startTradingBtn = await waitForElement(
      'button[class*="start"], button[class*="trading"], a[class*="trading"]'
    ) || Array.from(document.querySelectorAll("button, a")).find(
      (el) => el.textContent?.trim().toLowerCase().includes("start trading")
    );
    if (!clickElement(startTradingBtn, "Start Trading")) return;
    await sleep(2000);

    const confirmPopupBtn = await waitForElement(
      '.modal button[class*="confirm"], .popup button[class*="confirm"], .dialog button[class*="confirm"]'
    ) || Array.from(document.querySelectorAll(".modal button, .popup button, .dialog button")).find(
      (el) => el.textContent?.trim().toLowerCase() === "confirm"
    );
    if (confirmPopupBtn) {
      clickElement(confirmPopupBtn, "Confirm (popup)");
      await sleep(2000);
    }

    const templateLinkEl = document.querySelector('a[href*="template"], a[href*=".xlsx"]');
    const templateUrl = templateLinkEl?.getAttribute("href");

    if (!templateUrl) {
      console.error("[Z2U] Could not find template download link.");
      return;
    }

    let templateBlob;
    try {
      templateBlob = await downloadTemplateAsBlob(templateUrl);
    } catch (err) {
      console.error("[Z2U] Template download failed:", err);
      return;
    }

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

    const filledBytes = response.result.filledFile;

    const uploaded = await uploadFilledFile(
      filledBytes,
      'input[type="file"]',
      'button[class*="delivered"], button[class*="confirm-delivered"]'
    );

    if (uploaded) {
      markProcessed(orderId);
      console.log(`[Z2U] Order ${orderId} fully processed and delivered.`);
    }
  }

  async function scanPage() {
    console.log("[Z2U] Scanning page for new orders...");

    const mappings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_MAPPINGS" }, (response) => {
        resolve(response?.mappings || {});
      });
    });

    if (!Object.keys(mappings).length) {
      console.log("[Z2U] No mappings configured yet.");
      return;
    }

    const rows = document.querySelectorAll("table tbody tr, [class*='order-row'], [class*='order-item']");
    if (!rows.length) {
      console.log("[Z2U] No order rows found on page.");
      return;
    }

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
