(() => {
  "use strict";

  const href = window.location.href;
  const isListPage   = /sellOrder\/index/.test(href);
  const isDetailPage = !isListPage && /sellOrder(\?|$)/.test(href);

  // ── Logging helper ─────────────────────────────────────────────────────────

  function log(step, msg, ...extra) {
    const ts = new Date().toISOString().slice(11, 23);
    if (extra.length) {
      console.log(`[Z2U][${ts}] ${step} ${msg}`, ...extra);
    } else {
      console.log(`[Z2U][${ts}] ${step} ${msg}`);
    }
  }
  function warn(step, msg, ...extra) {
    console.warn(`[Z2U] ${step} ⚠️  ${msg}`, ...extra);
  }
  function err(step, msg, ...extra) {
    console.error(`[Z2U] ${step} ❌ ${msg}`, ...extra);
  }

  // Dumps all visible button/link texts on the page — useful for debugging
  function dumpButtons(label) {
    const btns = Array.from(document.querySelectorAll("button, a[class*='btn'], a[class*='button']"))
      .map((b) => `"${b.textContent?.trim()}"`)
      .filter((t) => t !== '""')
      .join(", ");
    log(label, `Buttons on page → [${btns}]`);
  }

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
    if (!el) { err("CLICK", `Not found: ${label}`); return false; }
    el.click();
    log("CLICK", `✅ Clicked: ${label}`);
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
    log("DL", `Downloading template from: ${url}`);
    const res = await fetch(url, { credentials: "include" });
    log("DL", `Download response: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    log("DL", `Downloaded ${bytes.byteLength} bytes`);
    return bytes;
  }

  // ── Backend call ───────────────────────────────────────────────────────────

  function sendToBackend(data) {
    log("BACKEND", `Sending to backend → orderId=${data.orderId} title="${data.title.slice(0,40)}..." qty=${data.quantity} blobSize=${data.templateBlob.length}`);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "PROCESS_ORDER", data }, (r) => {
        log("BACKEND", `Backend response →`, r);
        resolve(r);
      });
    });
  }

  // ── Upload filled file ─────────────────────────────────────────────────────

  function injectFileIntoInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    // Try native files setter first (React-compatible)
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files");
    if (desc && desc.set) {
      desc.set.call(input, dt.files);
      log("UPLOAD", `[B] Injected via native files setter.`);
    } else {
      Object.defineProperty(input, "files", { value: dt.files, configurable: true });
      log("UPLOAD", `[B] Injected via Object.defineProperty.`);
    }
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Find file input that accepts spreadsheets (not images/screenshots)
  function findXlsxInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    log("UPLOAD", `[B] All file inputs on page: ${inputs.map(i => `accept="${i.accept}" name="${i.name}" id="${i.id}"`).join(" | ")}`);
    // Prefer one explicitly accepting xlsx/spreadsheet/csv
    const xlsx = inputs.find((i) => /xlsx|spreadsheet|csv|xls/i.test(i.accept || ""));
    if (xlsx) return xlsx;
    // Avoid image-only inputs
    const nonImage = inputs.find((i) => !/^image/i.test(i.accept || ""));
    if (nonImage) return nonImage;
    // Last resort: first input
    return inputs[0] || null;
  }

  async function uploadAndConfirm(filledBytes) {
    const file = new File([new Uint8Array(filledBytes)], "fulfilled_order.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    // ── Step A: Close any accidentally open modals (Escape key) ─────────────
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(500);

    // ── Step B: Inject into xlsx file input (may be hidden — search all) ────
    log("UPLOAD", `[B] Scanning for xlsx file input before clicking Upload Form…`);
    let input = findXlsxInput();

    if (!input) {
      // Input not yet in DOM — click "Upload Form" to reveal it
      const uploadFormBtn = await waitForElementByText("button, a", "Upload Form", 6000);
      if (!uploadFormBtn) {
        err("UPLOAD", "[B] 'Upload Form' button not found.");
        return false;
      }
      log("UPLOAD", `[B] Clicking "Upload Form" to reveal file input…`);
      uploadFormBtn.click();
      await sleep(1000);
      input = await (async () => {
        const end = Date.now() + 6000;
        while (Date.now() < end) {
          const found = findXlsxInput();
          if (found) return found;
          await sleep(300);
        }
        return null;
      })();
    }

    if (!input) {
      err("UPLOAD", "[B] File input not found after 6s.");
      return false;
    }
    log("UPLOAD", `[B] Using input: accept="${input.accept}" id="${input.id}" name="${input.name}"`);

    injectFileIntoInput(input, file);
    log("UPLOAD", `[B] File injected (${filledBytes.length} bytes). Waiting 3s for Z2U to process…`);
    await sleep(3000);

    // ── Step C: Close any modal that opened (Escape) ─────────────────────────
    // (handles case where clicking Upload Form opened a screenshot modal instead)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(500);
    dumpButtons("UPLOAD-BEFORE-CONFIRM");

    // ── Step D: Click Confirm Delivered ──────────────────────────────────────
    log("UPLOAD", `[D] Looking for Confirm Delivered button…`);
    const confirmDeliveredBtn =
      await waitForElementByText("button, a", "confirm delivered", 8000) ||
      await waitForElementByText("button, a", "delivered", 5000);

    if (!confirmDeliveredBtn) {
      warn("UPLOAD", "[D] Confirm Delivered button not found.");
      dumpButtons("UPLOAD-FAILED");
      return false;
    }
    log("UPLOAD", `[D] Clicking Confirm Delivered: "${confirmDeliveredBtn.textContent?.trim()}"`);
    confirmDeliveredBtn.click();
    await sleep(3000);

    // ── Step E: Verify Z2U accepted — Confirm Delivered button should vanish ─
    const stillThere = Array.from(document.querySelectorAll("button, a"))
      .some((b) => /confirm.*delivered/i.test(b.textContent || ""));
    if (!stillThere) {
      log("UPLOAD", `[E] ✅ Confirm Delivered gone — delivery accepted by Z2U.`);
      return true;
    }
    // Still there — check for a confirmation modal
    log("UPLOAD", `[E] Confirm Delivered still visible — looking for modal confirm button…`);
    const modalConfirm = await waitForElementByText("button", "confirm", 4000);
    if (modalConfirm) {
      log("UPLOAD", `[E] Clicking modal confirm: "${modalConfirm.textContent?.trim()}"`);
      modalConfirm.click();
      await sleep(2000);
      const gone = !Array.from(document.querySelectorAll("button, a"))
        .some((b) => /confirm.*delivered/i.test(b.textContent || ""));
      if (gone) { log("UPLOAD", `[E] ✅ Delivery confirmed via modal.`); return true; }
    }
    // Check for Z2U error message on page
    const errorMsg = document.querySelector(".error, .alert, [class*='error'], [class*='alert']");
    if (errorMsg) warn("UPLOAD", `[E] Z2U error on page: "${errorMsg.textContent?.trim()}"`);
    warn("UPLOAD", `[E] Could not confirm delivery. Check Z2U page manually.`);
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LIST PAGE  (z2u.com/sellOrder/index)
  // ══════════════════════════════════════════════════════════════════════════

  async function runListPage() {
    log("LIST", "📋 Scan started.");

    const mappings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_MAPPINGS" }, (r) =>
        resolve(r?.mappings || {})
      );
    });

    const mappingKeys = Object.keys(mappings);
    log("LIST", `Mappings loaded: ${mappingKeys.length} entries → ${JSON.stringify(mappingKeys)}`);

    if (!mappingKeys.length) {
      warn("LIST", "No mappings configured — nothing to do.");
      return;
    }

    const panels = document.querySelectorAll(".orderPanel");
    log("LIST", `Found ${panels.length} .orderPanel(s).`);

    if (!panels.length) {
      warn("LIST", "No .orderPanel divs found. Page may not have loaded yet or structure changed.");
      log("LIST", "Page body preview:", document.body.innerHTML.slice(0, 500));
    }

    for (const panel of panels) {
      // Look for any status badge (danger or warning label)
      const statusBadge = panel.querySelector(".smLabel.dangerLabel, .smLabel.warningLabel, .smLabel");
      const statusText  = statusBadge?.textContent?.trim().toUpperCase() || "(no status)";
      log("LIST", `Panel status: "${statusText}"`);

      // Process NEW ORDER, PREPARING, and DELIVERING states
      const isActionable = statusText.includes("NEW ORDER") || statusText.includes("PREPARING") || statusText.includes("DELIVERING");
      if (!isActionable) continue;

      // Order ID
      const copyBtn              = panel.querySelector("[data-clipboard-text]");
      const orderIdFromClipboard = copyBtn?.getAttribute("data-clipboard-text")?.trim();
      const orderIdFromLink      = panel.querySelector(".o-number a")?.textContent?.trim();
      const orderId              = orderIdFromClipboard || orderIdFromLink;

      // Title
      const titleEl = panel.querySelector(".o-l-col.productInfo a");
      const title   = titleEl?.textContent?.trim() || "";

      // Detail link
      const detailLink = panel.querySelector('.o-l-col.productStatus a[href*="sellOrder"]');
      const detailHref = detailLink?.getAttribute("href") || "";

      log("LIST", `🔍 NEW ORDER → orderId="${orderId}" | title="${title}" | href="${detailHref}"`);

      if (!orderId) {
        warn("LIST", "Could not extract orderId — skipping.");
        continue;
      }

      if (!mappings[title]) {
        warn("LIST", `No mapping for title: "${title}"`);
        log("LIST", `Available mappings: ${JSON.stringify(mappingKeys)}`);
        continue;
      }

      if (sessionDone.has(orderId)) {
        log("LIST", `Order ${orderId} already in progress this session.`);
        continue;
      }
      const alreadyDone = await bgIsProcessed(orderId);
      if (alreadyDone) {
        log("LIST", `Order ${orderId} already processed (persistent storage).`);
        continue;
      }

      if (!detailHref) {
        warn("LIST", `No Order Detail link for ${orderId}.`);
        continue;
      }

      await chrome.storage.local.set({ pendingOrderId: orderId, pendingTitle: title });
      log("LIST", `🔗 Navigating to detail page: ${detailHref}`);
      window.location.href = detailHref;
      return;
    }

    log("LIST", "✅ Scan complete — no unprocessed NEW ORDER panels.");
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DETAIL PAGE  (z2u.com/sellOrder?order_id=Z...)
  // ══════════════════════════════════════════════════════════════════════════

  async function runDetailPage() {
    const params  = new URLSearchParams(window.location.search);
    const orderId = params.get("order_id") || params.get("orderId");

    log("DETAIL", `📄 Page loaded | orderId="${orderId}"`);

    if (!orderId) {
      warn("DETAIL", "No order_id in URL — stopping.");
      return;
    }

    // Give page time to fully render
    log("DETAIL", "Waiting 1s for page to fully render…");
    await sleep(1000);

    // ── [1] Status check ────────────────────────────────────────────────────
    // Z2U order flow: NEW ORDER → PREPARING → Delivering → Waiting for confirmation → Completed
    // We handle all states up to and including Delivering.
    const pageText      = document.body.textContent?.toUpperCase() || "";
    const statusBadge   = document.querySelector(".smLabel.dangerLabel, .smLabel.warningLabel, .smLabel, [class*='statusLabel'], .order-status");
    const badgeText     = statusBadge?.textContent?.trim().toUpperCase() || "not found";
    const hasNew        = pageText.includes("NEW ORDER");
    const hasPreparing  = pageText.includes("PREPARING");
    const hasDelivering = pageText.includes("DELIVERING");
    const isActionable  = hasNew || hasPreparing || hasDelivering;
    log("DETAIL", `[1] Status → NEW ORDER:${hasNew} | PREPARING:${hasPreparing} | DELIVERING:${hasDelivering} | badge:"${badgeText}"`);

    if (!isActionable) {
      log("DETAIL", `[1] Order ${orderId} is not in an actionable state — skipping.`);
      return;
    }

    // ── [2] Title extraction ─────────────────────────────────────────────────
    let title = "";

    // Strip leading ": " that Z2U injects into sibling element text — keep the rest as-is
    function cleanTitle(raw) {
      return (raw || "").replace(/^[\s:]+/, "").trim();
    }

    // Try A: leaf element labelled "Product Title"
    const allEls = Array.from(document.querySelectorAll("*"));
    for (const el of allEls) {
      if (el.childElementCount > 0) continue;
      const t = el.textContent?.trim() || "";
      if (/^product\s*title$/i.test(t)) {
        const sib = el.nextElementSibling || el.parentElement?.nextElementSibling;
        const raw = sib?.textContent?.trim() || "";
        title = cleanTitle(raw);
        log("DETAIL", `[2A] Found "Product Title" label → raw: "${raw.slice(0, 80)}" → cleaned: "${title.slice(0, 80)}"`);
        break;
      }
    }

    // Try B: table row containing "product title"
    if (!title) {
      for (const row of document.querySelectorAll("tr, dl dt, .info-row, .detail-row")) {
        if ((row.textContent || "").toLowerCase().includes("product title")) {
          const next = row.nextElementSibling || row.querySelector("td:nth-child(2), dd");
          title = cleanTitle(next?.textContent?.trim() || "");
          log("DETAIL", `[2B] Row approach → "${title.slice(0, 80)}"`);
          if (title) break;
        }
      }
    }

    // Try C: any element with class containing "product" + "title"
    if (!title) {
      const el = document.querySelector('[class*="productTitle"], [class*="product-title"], [class*="goodsName"]');
      title = cleanTitle(el?.textContent?.trim() || "");
      log("DETAIL", `[2C] Class-based approach → "${title.slice(0, 80)}"`);
    }

    log("DETAIL", `[2] Final title: "${title}"`);

    if (!title) {
      err("DETAIL", "[2] Could not extract product title from page.");
      return;
    }

    // ── [3] Mapping check ────────────────────────────────────────────────────
    const mappings = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_MAPPINGS" }, (r) =>
        resolve(r?.mappings || {})
      );
    });

    log("DETAIL", `[3] Mappings available: ${JSON.stringify(Object.keys(mappings))}`);

    // Fuzzy lookup: exact first, then normalised (trim + collapse spaces)
    function normalise(s) { return s.replace(/\s+/g, " ").trim(); }
    let resolvedTitle = title;
    if (!mappings[title]) {
      const keys = Object.keys(mappings);
      const fuzzy = keys.find((k) => normalise(k) === normalise(title));
      if (fuzzy) {
        warn("DETAIL", `[3] Exact miss but fuzzy match found. Using: "${fuzzy.slice(0, 60)}"`);
        resolvedTitle = fuzzy;
      } else {
        warn("DETAIL", `[3] No mapping for title: "${title}"`);
        log("DETAIL", `[3] Available keys: ${JSON.stringify(keys)}`);
        await chrome.storage.local.remove(["pendingOrderId", "pendingTitle"]);
        return;
      }
    }

    log("DETAIL", `[3] ✅ Mapping found → productId="${mappings[resolvedTitle]}"`);

    // ── [4] Dedup ─────────────────────────────────────────────────────────────
    if (sessionDone.has(orderId)) {
      log("DETAIL", `[4] Already in progress this session — skipping.`);
      return;
    }
    const alreadyDone = await bgIsProcessed(orderId);
    log("DETAIL", `[4] bgIsProcessed → ${alreadyDone}`);
    if (alreadyDone) {
      log("DETAIL", `[4] Order ${orderId} already completed. Use popup → Clear History to retry.`);
      return;
    }
    sessionDone.add(orderId);
    await chrome.storage.local.remove(["pendingOrderId", "pendingTitle"]);

    // ── [5] Quantity ──────────────────────────────────────────────────────────
    let quantity = 1;
    const allNodes = Array.from(document.querySelectorAll("*"));
    for (let j = 0; j < allNodes.length; j++) {
      if (allNodes[j].childElementCount > 0) continue;
      const t = allNodes[j].textContent?.trim() || "";
      if (/^quantity$/i.test(t)) {
        const next = allNodes[j].nextElementSibling || allNodes[j].parentElement?.nextElementSibling;
        const val  = parseInt(next?.textContent?.trim() || "0", 10);
        log("DETAIL", `[5] Found QUANTITY label → next element text: "${next?.textContent?.trim()}" → parsed: ${val}`);
        if (val > 0) { quantity = val; break; }
      }
    }
    log("DETAIL", `[5] Using quantity: ${quantity}`);

    log("DETAIL", `🚀 Starting fulfillment | orderId=${orderId} | qty=${quantity}`);
    dumpButtons("DETAIL-BEFORE-PREPARING");

    try {
      // ── State machine: detect current stage and jump to the right step ─────
      // Z2U order stages: NEW ORDER → PREPARING → Delivering → Waiting for confirmation
      //
      // Detect by what's visible on the page right now:
      //   • "Download Bulk Delivery Form Template" link → already in Delivering, skip to [9]
      //   • "START TRADING" button → PREPARING already clicked, skip to [7]
      //   • "PREPARING" button → fresh NEW ORDER, do full flow from [6]

      // Find the template download link by text (most reliable) or by href pattern
      function findTemplateLink() {
        const allAnchors = Array.from(document.querySelectorAll("a, button"));
        // Text-based: look for "download" + "template" in visible text
        const byText = allAnchors.find((el) => {
          const t = el.textContent?.trim().toUpperCase() || "";
          return t.includes("DOWNLOAD") && (t.includes("TEMPLATE") || t.includes("FORM"));
        });
        if (byText) return byText;
        // Href-based fallback
        return document.querySelector('a[href*="template"], a[href*=".xlsx"], a[href*="download"], a[download]');
      }

      const allBtnsNow = Array.from(document.querySelectorAll("button, a"));
      const templateLinkEl  = findTemplateLink();
      const hasTemplateLink = !!templateLinkEl;
      const hasStartTrading = allBtnsNow.some((b) => b.textContent?.trim().toUpperCase().includes("START TRADING"));
      const hasPrepBtn      = allBtnsNow.some((b) => b.textContent?.trim().toUpperCase() === "PREPARING");

      if (templateLinkEl) {
        log("DETAIL", `[6] Template link found by: text="${templateLinkEl.textContent?.trim()}" href="${templateLinkEl.getAttribute("href")}"`);
      }

      log("DETAIL", `[6] Page state → hasTemplateLink:${hasTemplateLink} | hasStartTrading:${hasStartTrading} | hasPrepBtn:${hasPrepBtn}`);
      dumpButtons("DETAIL-STATE-CHECK");

      if (!hasTemplateLink) {
        // Need to advance through PREPARING and/or START TRADING first

        if (!hasStartTrading) {
          // ── [6] Click PREPARING ──────────────────────────────────────────────
          if (!hasPrepBtn) {
            err("DETAIL", "[6] Neither PREPARING nor START TRADING nor template link found.");
            dumpButtons("DETAIL-[6]-STUCK");
            return;
          }
          const preparingBtn = allBtnsNow.find((b) => b.textContent?.trim().toUpperCase() === "PREPARING");
          log("DETAIL", `[6] Clicking PREPARING: tag=${preparingBtn.tagName} class="${preparingBtn.className}"`);
          preparingBtn.click();
          log("DETAIL", "[6] ✅ Clicked PREPARING. Waiting 3s…");
          await sleep(3000);
        } else {
          log("DETAIL", "[6] START TRADING already visible — skipping PREPARING.");
        }

        // ── [7] Click START TRADING ────────────────────────────────────────────
        log("DETAIL", "[7] Waiting for START TRADING button (10s)…");
        dumpButtons("DETAIL-BEFORE-START-TRADING");
        const startBtn = await waitForElementByText("button, a", "START TRADING", 10000);
        if (!startBtn) {
          err("DETAIL", "[7] START TRADING button not found after 10s.");
          dumpButtons("DETAIL-[7]-FAILED");
          return;
        }
        log("DETAIL", `[7] Clicking START TRADING: tag=${startBtn.tagName} text="${startBtn.textContent?.trim()}" class="${startBtn.className}"`);
        startBtn.click();
        log("DETAIL", "[7] ✅ Clicked START TRADING. Waiting 2.5s…");
        await sleep(2500);

        // ── [8] Confirm modal ────────────────────────────────────────────────
        log("DETAIL", "[8] Waiting for CONFIRM button in modal (8s)…");
        dumpButtons("DETAIL-AFTER-START-TRADING");

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
          const green = allConfirmBtns[allConfirmBtns.length - 1];
          log("DETAIL", `[8] Found ${allConfirmBtns.length} CONFIRM btn(s), clicking last: class="${green.className}"`);
          green.click();
          log("DETAIL", "[8] ✅ Clicked CONFIRM. Waiting 3s…");
          await sleep(3000);
        } else {
          warn("DETAIL", "[8] CONFIRM modal not found — continuing anyway.");
          dumpButtons("DETAIL-[8]-NO-MODAL");
        }
      } else {
        log("DETAIL", "[6-8] Template link already on page — order is in Delivering state. Jumping to download.");
      }

      // ── [9] Template download ──────────────────────────────────────────────
      log("DETAIL", "[9] Looking for template download link…");
      // Re-query after any page changes (clicking START TRADING may re-render)
      const templateLink = findTemplateLink();
      if (!templateLink) {
        err("DETAIL", "[9] Template download link NOT found.");
        log("DETAIL", "[9] All <a> elements on page:",
          Array.from(document.querySelectorAll("a")).map((a) => `"${a.textContent?.trim()}" → ${a.getAttribute("href")}`).join(" | ")
        );
        return;
      }
      const templateUrl = templateLink.getAttribute("href");
      log("DETAIL", `[9] Template link: text="${templateLink.textContent?.trim()}" href="${templateUrl}"`);
      const templateBlob = await downloadBlob(templateUrl);

      // ── [10] Backend ───────────────────────────────────────────────────────
      log("DETAIL", "[10] Sending to backend…");
      const response = await sendToBackend({
        orderId,
        title: resolvedTitle,
        quantity,
        templateBlob: Array.from(templateBlob),
      });

      if (!response?.ok) {
        err("DETAIL", `[10] Backend returned error: ${response?.error}`);
        return;
      }
      if (response.result?.skipped) {
        log("DETAIL", "[10] Backend skipped (already processed there).");
        return;
      }
      log("DETAIL", `[10] ✅ Backend success. Filled file size: ${response.result?.filledFile?.length ?? 0} bytes`);

      const filledBytes = response.result.filledFile;

      // ── [11] Upload + confirm delivered ───────────────────────────────────
      log("DETAIL", "[11] Uploading filled file…");
      const uploaded = await uploadAndConfirm(filledBytes);
      if (uploaded) {
        await bgMarkProcessed(orderId);
        log("DETAIL", `[11] ✅ Order ${orderId} fully completed and marked processed.`);
      } else {
        warn("DETAIL", "[11] Upload/confirm step did not complete.");
      }

    } catch (e) {
      err("DETAIL", `Unhandled exception:`, e);
    }

    // ── Return to list page to pick up next order ─────────────────────────
    log("DETAIL", "↩ Returning to order list in 3s to process next order…");
    await sleep(3000);
    window.location.href = "/sellOrder/index";
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  function init() {
    if (isListPage) {
      log("INIT", "▶ Running on LIST page. Will scan every 30s.");
      // Initial scan after page load, then poll every 30 seconds
      setTimeout(runListPage, 2500);
      setInterval(runListPage, 30000);
    } else if (isDetailPage) {
      log("INIT", "▶ Running on DETAIL page.");
      setTimeout(runDetailPage, 2500);
    } else {
      log("INIT", `Page not matched: ${href}`);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
