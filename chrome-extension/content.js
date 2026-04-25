(() => {
  "use strict";

  const href = window.location.href;
  const isListPage   = /sellOrder\/index/.test(href);
  const isDetailPage = !isListPage && /sellOrder(\?|$)/.test(href);

  // ── Listen for upload requests captured by injected.js ────────────────────
  // injected.js now runs as a MAIN-world content script at document_start
  // (declared in manifest.json) — it patches fetch/XHR before Z2U's code
  // loads, so Z2U captures our patched versions and can't bypass them.
  // It communicates back here via window.postMessage.
  window.addEventListener("message", (e) => {
    if (e.data?.source !== "__z2u_injected__") return;
    if (e.data.type === "UPLOAD_REQUEST_CAPTURED") {
      const captured = { url: e.data.url, method: e.data.method, fields: e.data.fields };
      console.log("[Z2U][CAPTURE] Upload endpoint learned:", captured.method, captured.url, captured.fields);
      chrome.storage.local.set({ z2uUploadEndpoint: captured }, () => {
        // Signal background to update badge
        chrome.runtime.sendMessage({ type: "ENDPOINT_CAPTURED" });
      });
    }
  });

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

  // ── Analytics helpers (fire-and-forget, no fulfillment impact) ────────────

  function extractOrderAmount() {
    // 1) Look for a labelled row: element containing "Price"/"Total" then a sibling
    const allEls = Array.from(document.querySelectorAll("*"));
    for (const el of allEls) {
      if (el.childElementCount > 0) continue;
      const t = (el.textContent || "").trim();
      if (/^(price|total|order\s*(total|price|value)|sale\s*price|amount)$/i.test(t)) {
        const candidates = [
          el.nextElementSibling,
          el.parentElement?.nextElementSibling,
          el.parentElement?.nextElementSibling?.querySelector("span,div,p"),
        ];
        for (const c of candidates) {
          if (!c) continue;
          const m = (c.textContent || "").trim().match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
          if (m) {
            const v = parseFloat(m[1]);
            if (v > 0 && v < 100000) return v;
          }
        }
      }
    }
    // 2) Fallback: scan visible text for $XX.XX patterns, pick the largest plausible one
    const matches = (document.body.innerText || "").match(/\$\s*(\d+(?:\.\d{1,2})?)/g);
    if (matches) {
      const amounts = matches
        .map((m) => parseFloat(m.replace("$", "").trim()))
        .filter((v) => v > 0.5 && v < 100000);
      if (amounts.length) return Math.max(...amounts);
    }
    return null;
  }

  function recordAnalytics(orderId, title, quantity) {
    try {
      const amount = extractOrderAmount();
      chrome.runtime.sendMessage({
        type: "RECORD_ANALYTICS",
        orderId, title, quantity, amount,
      }).catch(() => {});
    } catch (_) {}
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

  // For unmapped orders that only had "Preparing" clicked — separate from fully-fulfilled.
  function bgIsPreparedOnly(orderId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "IS_PREPARED_ONLY", orderId }, (r) =>
        resolve(r?.prepared === true)
      );
    });
  }

  function bgMarkPreparedOnly(orderId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "MARK_PREPARED_ONLY", orderId }, () => resolve());
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

    // Preserve original filename from Content-Disposition header; fall back to URL segment
    const cd = res.headers.get("content-disposition") || "";
    const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
    const filename = (cdMatch?.[1] || url.split("/").pop() || "template.xlsx")
      .replace(/[^\w\-. ]/g, "_")   // sanitise any unsafe chars
      .replace(/^_+|_+$/g, "")
      || "template.xlsx";

    log("DL", `Downloaded ${bytes.byteLength} bytes → filename: "${filename}"`);
    return { bytes, filename };
  }

  // ── Backend call ───────────────────────────────────────────────────────────
  // The fetch runs inside background.js (service workers are exempt from the
  // browser's mixed-content policy, so HTTP VPS URLs work from HTTPS Z2U pages).

  async function sendToBackend({ orderId, title, quantity, templateBlob, templateFilename }) {
    log("BACKEND", `Sending to backend → orderId=${orderId} title="${title.slice(0, 40)}..." qty=${quantity} blobSize=${templateBlob.length} filename="${templateFilename}"`);

    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "PROCESS_ORDER", data: { orderId, title, quantity, templateBlob, templateFilename } }, (r) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        log("BACKEND", `Backend response received: ok=${r?.ok} filledSize=${r?.result?.filledFile?.length ?? 0}`);
        resolve(r);
      });
    });

    if (!result?.ok) throw new Error(result?.error || "Unknown backend error");
    return new Uint8Array(result.result.filledFile);
  }

  // ── Upload filled file ─────────────────────────────────────────────────────

  function injectFileIntoInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    // Try native files setter first (React-compatible)
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files");
    if (desc && desc.set) {
      desc.set.call(input, dt.files);
      log("UPLOAD", `[inject] native files setter used`);
    } else {
      Object.defineProperty(input, "files", { value: dt.files, configurable: true });
      log("UPLOAD", `[inject] Object.defineProperty fallback used`);
    }
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Injects a file AND fires React's internal onChange so the component state updates.
  // Z2U uses React; without this the file shows visually but the React state stays empty
  // and SUBMIT fails with a "Please input note" (= "no file selected") validation error.
  async function injectFileAndUpdateReact(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);

    // 1. Set the native files property
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "files")?.set;
    if (nativeSetter) {
      nativeSetter.call(input, dt.files);
    } else {
      Object.defineProperty(input, "files", { value: dt.files, configurable: true, writable: true });
    }

    // 2. Call React's own onChange handler via the __reactProps key on the DOM node.
    //    This is the only reliable way to update React's internal component state
    //    when setting files programmatically (native events alone don't always work).
    const reactPropsKey = Object.keys(input).find(
      (k) => k.startsWith("__reactProps") || k.startsWith("__reactInternals")
    );
    if (reactPropsKey) {
      const props = input[reactPropsKey];
      const onChangeFn = props?.onChange;
      if (typeof onChangeFn === "function") {
        const fakeEvent = {
          target: input, currentTarget: input,
          type: "change", bubbles: true,
          nativeEvent: { target: input, type: "change" },
          preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
        };
        onChangeFn(fakeEvent);
        log("UPLOAD", `[inject] Called React onChange via ${reactPropsKey}`);
      } else {
        log("UPLOAD", `[inject] React props found (${reactPropsKey}) but no onChange`);
      }
    } else {
      // Fallback: try __reactFiber memoizedProps
      const fiberKey = Object.keys(input).find((k) => k.startsWith("__reactFiber"));
      if (fiberKey) {
        const onChange = input[fiberKey]?.memoizedProps?.onChange;
        if (typeof onChange === "function") {
          const fakeEvent = {
            target: input, currentTarget: input, type: "change", bubbles: true,
            nativeEvent: { target: input }, preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
          };
          onChange(fakeEvent);
          log("UPLOAD", `[inject] Called React onChange via __reactFiber`);
        }
      } else {
        log("UPLOAD", `[inject] No React props key found — dispatching native events only`);
      }
    }

    // 3. Also dispatch native events as belt-and-suspenders
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    await sleep(50);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(200);

    const count = input.files?.length ?? 0;
    log("UPLOAD", `[inject] After injection: files.length=${count} name="${input.files?.[0]?.name}"`);
    return count > 0;
  }

  // Find the xlsx upload input — Z2U uses id="upfile" / name="upload" for the
  // bulk delivery form. FilePond inputs (order_before_img / order_after_img) are
  // for trade screenshots and must be avoided.
  function findXlsxInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    log("UPLOAD", `[B] All file inputs: ${inputs.map(i => `id="${i.id}" name="${i.name}" accept="${i.accept}"`).join(" | ")}`);

    // Priority 1: known Z2U xlsx input IDs/names
    const byId   = inputs.find((i) => i.id === "upfile" || i.name === "upload");
    if (byId) return byId;

    // Priority 2: explicitly accepts spreadsheet types
    const byAccept = inputs.find((i) => /xlsx|spreadsheet|csv|xls/i.test(i.accept || ""));
    if (byAccept) return byAccept;

    // Priority 3: exclude FilePond screenshot inputs
    const nonFilePond = inputs.find((i) => !/filepond|order_before|order_after/i.test(i.id + i.name));
    if (nonFilePond) return nonFilePond;

    return null;
  }

  // ── Confirm Delivered flow ────────────────────────────────────────────────
  // PREREQUISITE: "View Delivery Account Information" MUST be visible before
  // this function clicks anything. Z2U only shows that button after it has
  // processed and recorded the uploaded XLSX. Clicking "Confirm Delivered"
  // before that button appears means the XLSX was never accepted.
  async function confirmDeliveredFlow(quantity) {
    // ── [D1] Wait for "View Delivery Account Information" ──────────────────
    function hasViewDeliveryBtn() {
      return Array.from(document.querySelectorAll("button, a"))
        .some((b) => /view\s+delivery\s+account/i.test(b.textContent || ""));
    }

    log("UPLOAD", "[D1] Waiting up to 30s for 'View Delivery Account Information'…");
    const viewEnd = Date.now() + 30_000;
    while (Date.now() < viewEnd) {
      if (hasViewDeliveryBtn()) break;
      await sleep(800);
    }

    if (!hasViewDeliveryBtn()) {
      warn("UPLOAD", "[D1] ❌ 'View Delivery Account Information' never appeared — XLSX not accepted by Z2U. NOT clicking Confirm Delivered.");
      dumpButtons("UPLOAD-NO-VIEW-DELIVERY");
      return false;
    }
    log("UPLOAD", "[D1] ✅ 'View Delivery Account Information' present — upload accepted.");

    dumpButtons("UPLOAD-BEFORE-CONFIRM");

    // ── [D2] Find "Confirm Delivered" button ───────────────────────────────
    log("UPLOAD", "[D2] Looking for 'Confirm Delivered' button…");
    const confirmBtn =
      await waitForElementByText("button", "confirm delivered", 8000) ||
      await waitForElementByText("button", "delivered", 5000);

    if (!confirmBtn) {
      warn("UPLOAD", "[D2] 'Confirm Delivered' button not found.");
      dumpButtons("UPLOAD-FAILED");
      return false;
    }
    log("UPLOAD", `[D2] Found: "${confirmBtn.textContent?.trim()}"`);

    // ── [D2b] Fill inline quantity input BEFORE clicking ──────────────────
    // Z2U renders a number/text input directly on the page (next to the
    // Confirm Delivered button) that must be filled with the delivered count.
    // Look inside the same container as the button, then fall back to any
    // visible non-modal input on the page.
    function fillInput(el, val) {
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (nativeSet) nativeSet.call(el, String(val)); else el.value = String(val);
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const inlineInput = await (async () => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        // Priority 1: input that is a sibling or cousin of the Confirm button
        const container = confirmBtn.closest("div, section, form, td, li") || document.body;
        const nearby = Array.from(container.querySelectorAll("input"))
          .find((i) => i.type !== "file" && i.type !== "hidden" && i.type !== "checkbox" && !i.readOnly);
        if (nearby) return nearby;

        // Priority 2: any visible, non-modal, non-search input on the page
        const page = Array.from(document.querySelectorAll("input"))
          .find((i) =>
            i.type !== "file" && i.type !== "hidden" && i.type !== "checkbox" &&
            !i.readOnly &&
            !i.closest(".ant-modal, [role='dialog'], [class*='modal'], [class*='search'], header, nav") &&
            i.offsetParent !== null
          );
        if (page) return page;
        await sleep(300);
      }
      return null;
    })();

    if (inlineInput) {
      fillInput(inlineInput, quantity);
      log("UPLOAD", `[D2b] ✅ Filled inline quantity input: ${quantity}`);
      await sleep(600);
    } else {
      log("UPLOAD", "[D2b] No inline quantity input found — clicking without pre-fill.");
    }

    // ── [D2c] Click Confirm Delivered ─────────────────────────────────────
    // Set a persistent flag BEFORE the click resolves — if Z2U reloads the
    // page (as it does for Preparing), this flag survives and the new content
    // script's [0c] block will navigate to sellOrder/index instead of stalling.
    const _navOrderId = new URLSearchParams(window.location.search).get("order_id") || "";
    if (_navOrderId) {
      await chrome.storage.local.set({ pendingNavigateToList: _navOrderId });
      log("UPLOAD", `[D2c] 🔖 Set pendingNavigateToList=${_navOrderId} (survives reload).`);
    }
    confirmBtn.click();
    await sleep(2000);

    // ── [D3] Handle any quantity / OK dialog that Z2U may show ─────────────
    const modalEl = () => document.querySelector(
      ".ant-modal, .ant-modal-content, .modal, [role='dialog'], [class*='modal'], [class*='dialog']"
    );

    // Fill quantity if a number input appeared in a post-click modal
    const numInput = await (async () => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const vis = Array.from(document.querySelectorAll("input[type='number']"))
          .find((i) => !i.closest("[style*='display:none'], [hidden]"));
        if (vis) return vis;
        const m = modalEl();
        if (m) {
          const inp = Array.from(m.querySelectorAll("input"))
            .find((i) => i.type !== "file" && i.type !== "hidden" && i.type !== "checkbox");
          if (inp) return inp;
        }
        await sleep(400);
      }
      return null;
    })();

    if (numInput) {
      fillInput(numInput, quantity);
      log("UPLOAD", `[D3] Filled post-click modal quantity: ${quantity}`);
      await sleep(400);
    }

    // Click OK / Confirm inside any modal that appeared
    const okBtn = await (async () => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const m = modalEl();
        if (m) {
          const btn = Array.from(m.querySelectorAll("button"))
            .find((b) => /^(ok|confirm|yes)$/i.test(b.textContent?.trim() || ""));
          if (btn) return btn;
        }
        const global = Array.from(document.querySelectorAll("button"))
          .find((b) => /^(ok|confirm|yes)$/i.test(b.textContent?.trim() || ""));
        if (global) return global;
        await sleep(400);
      }
      return null;
    })();

    if (okBtn) {
      log("UPLOAD", `[D3] Clicking dialog button: "${okBtn.textContent?.trim()}"`);
      okBtn.click();
      await sleep(2500);
    } else {
      log("UPLOAD", "[D3] No OK/Confirm dialog appeared — continuing.");
    }

    // ── [D4] Final success check ────────────────────────────────────────────
    // After clicking Confirm Delivered, Z2U usually keeps or removes the
    // "View Delivery Account Information" button. Either way, we already
    // confirmed it was there before clicking, so the delivery was recorded.
    const errBanner = document.querySelector(".ant-message-notice, .ant-message-error, .ant-message-warning");
    if (errBanner) {
      const txt = errBanner.textContent?.trim() || "";
      warn("UPLOAD", `[D4] Z2U message after confirm: "${txt.slice(0, 200)}"`);
      if (/error|fail|invalid|reject/i.test(txt)) return false;
    }

    log("UPLOAD", "[D4] ✅ Confirm Delivered flow complete — returning to order list.");
    await chrome.storage.local.remove(["pendingNavigateToList"]);
    window.location.href = "https://www.z2u.com/sellOrder/index";
    return true;
  }

  // ── Direct API upload (bypasses the modal entirely) ───────────────────────
  // Uses the endpoint captured by injected.js from a previous manual/successful
  // upload.  Replays the exact same FormData structure with our filled file,
  // substituting the orderId field with the current order's ID.
  // Z2U file field names to probe when CDP couldn't decode the multipart body
  const Z2U_FILE_FIELDS = ["upfile", "file", "upload", "excel", "formFile"];

  async function tryUploadWithField(url, method, fieldName, extraFields, file, orderId, csrfToken, note) {
    const formData = new FormData();
    // Attach extra string fields first (order_id, note, etc.)
    for (const field of (extraFields || [])) {
      if (field.type !== "file") {
        const val = /^Z\d+$/i.test(field.value) ? orderId : (field.value || "");
        formData.append(field.key, val);
      }
    }
    if (orderId && !(extraFields || []).some((f) => /order_?id/i.test(f.key))) {
      formData.append("order_id", orderId);
    }
    // Z2U's upload modal requires a "note" field — include it always
    const noteValue = note || "Delivered";
    if (!(extraFields || []).some((f) => /^note$/i.test(f.key))) {
      formData.append("note", noteValue);
    }
    formData.append(fieldName, file, file.name);
    log("UPLOAD-API", `  Trying field="${fieldName}" note="${noteValue}" + ${(extraFields||[]).filter(f=>f.type!=="file").map(f=>f.key).join(",")}`);

    // Headers that make this look like a legitimate same-origin XHR request
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      "Referer": window.location.href,
      "Origin": window.location.origin,
    };
    if (csrfToken) {
      headers["X-XSRF-TOKEN"] = csrfToken;
      headers["X-CSRF-TOKEN"]  = csrfToken;
    }

    const res = await fetch(url, { method: method || "POST", body: formData, credentials: "include", headers });
    const text = await res.text();
    log("UPLOAD-API", `  HTTP ${res.status} → ${text.slice(0, 300)}`);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

    // Parse Z2U's JSON response
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }

    if (json) {
      const code = json.code ?? json.status ?? json.errCode;
      // code 0, 200, 1, true → success; anything else → failure
      const isOkCode = code === 0 || code === 200 || code === "0" || code === "200" || code === true || code === 1;
      if (!isOkCode) {
        throw new Error(`app-error code=${code} msg=${json.msg ?? json.message ?? "?"}`);
      }
      // Extra check: successful Z2U uploads return a non-empty data field
      // If data is empty/null and msg suggests no file, treat as failure
      const msg = (json.msg || json.message || "").toLowerCase();
      if (/select|no file|missing|require|please/i.test(msg)) {
        throw new Error(`app-error: "${json.msg ?? json.message}"`);
      }
      // data field should be a URL or non-empty object for real uploads
      const hasData = json.data !== null && json.data !== undefined && json.data !== "" && json.data !== false;
      log("UPLOAD-API", `  code=${code} data=${JSON.stringify(json.data)?.slice(0,100)} hasData=${hasData}`);
      return hasData;
    }

    // Non-JSON response — if we got 200 and it's not an HTML error page, assume OK
    return !text.toLowerCase().includes("<html") && !text.toLowerCase().includes("error");
  }

  // Known Z2U XLSX delivery upload endpoints.
  // IMPORTANT: uploadOrderImg.html is intentionally excluded — it accepts any
  // file and returns success, but it is for trade evidence screenshots, NOT for
  // the bulk delivery XLSX template.  Including it causes false-positive
  // "upload succeeded" results which skip the real upload and confirm delivery empty.
  const Z2U_KNOWN_ENDPOINTS = [
    { url: "https://www.z2u.com/sellOrder/uploadSellForm",   method: "POST" },
    { url: "https://www.z2u.com/SellOrder/uploadSellForm",   method: "POST" },
    { url: "https://www.z2u.com/sellOrder/uploadDelivery",   method: "POST" },
    { url: "https://www.z2u.com/sellOrder/deliveryUpload",   method: "POST" },
    { url: "https://www.z2u.com/sellOrder/uploadFile",       method: "POST" },
    { url: "https://www.z2u.com/api/sellOrder/uploadSellForm", method: "POST" },
    { url: "https://www.z2u.com/api/sellOrder/uploadDelivery", method: "POST" },
    { url: "https://www.z2u.com/api/upload/sellForm",        method: "POST" },
  ];

  // Returns true if a URL is the image-evidence endpoint (wrong for XLSX delivery)
  function isImageEndpoint(url) {
    return /uploadOrderImg|uploadImg|uploadImage|orderImg/i.test(url || "");
  }

  async function tryEndpoint(epUrl, epMethod, extraFields, file, orderId, label, csrfToken) {
    for (const fieldName of Z2U_FILE_FIELDS) {
      try {
        const ok = await tryUploadWithField(epUrl, epMethod, fieldName, extraFields, file, orderId, csrfToken);
        if (ok) {
          log("UPLOAD-API", `✅ [${label}] field="${fieldName}" worked!`);
          return fieldName;
        }
        warn("UPLOAD-API", `[${label}] field="${fieldName}": no data — trying next`);
      } catch (e) {
        warn("UPLOAD-API", `[${label}] field="${fieldName}" error: ${e.message}`);
      }
    }
    return null;
  }

  async function directApiUpload(file, orderId, csrfToken) {
    const stored = await new Promise((r) =>
      chrome.storage.local.get(["z2uUploadEndpoint"], (d) => r(d.z2uUploadEndpoint))
    );

    // ── Try stored endpoint first (skip if it's the image-evidence endpoint) ──
    if (stored?.url && isImageEndpoint(stored.url)) {
      warn("UPLOAD-API", `Stored endpoint "${stored.url}" is an image/screenshot endpoint — skipping to avoid false-positive. Use Reset Endpoint + Capture Mode to get the real XLSX endpoint.`);
    }
    if (stored?.url && !isImageEndpoint(stored.url)) {
      log("UPLOAD-API", `Stored endpoint: ${stored.method || "POST"} ${stored.url}`);

      // Case 1: CDP decoded the multipart body — we know the exact field name
      if (!stored.probeFields && stored.fields?.length) {
        const fileField  = stored.fields.find((f) => f.type === "file");
        const fieldName  = fileField?.key || "upfile";
        const extraFields = stored.fields.filter((f) => f.type !== "file");
        log("UPLOAD-API", `Using captured field name: "${fieldName}"`);
        try {
          const ok = await tryUploadWithField(stored.url, stored.method, fieldName, extraFields, file, orderId, csrfToken);
          if (ok) return true;
          warn("UPLOAD-API", `Stored endpoint returned empty data — will probe fallbacks`);
        } catch (e) {
          warn("UPLOAD-API", `Stored endpoint failed: ${e.message} — will probe fallbacks`);
        }
      } else {
        // Case 2: probe field names on stored endpoint
        const extraFields = (stored.fields || []).filter((f) => f.type !== "file");
        const winField = await tryEndpoint(stored.url, stored.method || "POST", extraFields, file, orderId, "stored", csrfToken);
        if (winField) {
          const updatedFields = [...extraFields, { key: winField, type: "file" }];
          chrome.storage.local.set({ z2uUploadEndpoint: { ...stored, fields: updatedFields, probeFields: false } });
          return true;
        }
        warn("UPLOAD-API", `All field probes failed on stored endpoint — trying known fallbacks`);
      }
    } else {
      log("UPLOAD-API", "No stored endpoint — going straight to known fallbacks");
    }

    // ── Try known Z2U endpoints as fallbacks ──────────────────────────────────
    // Skip any URL identical to the stored one (already tried above)
    const storedUrl = stored?.url || "";
    for (const ep of Z2U_KNOWN_ENDPOINTS) {
      if (ep.url === storedUrl) continue;
      log("UPLOAD-API", `Probing fallback: ${ep.method} ${ep.url}`);
      const winField = await tryEndpoint(ep.url, ep.method, [], file, orderId, ep.url.split("/").pop(), csrfToken);
      if (winField) {
        // Save the discovered endpoint so we use it directly next time
        const saved = {
          url: ep.url, method: ep.method,
          fields: [{ key: winField, type: "file" }],
          probeFields: false,
        };
        chrome.storage.local.set({ z2uUploadEndpoint: saved });
        log("UPLOAD-API", `✅ Saved new endpoint: ${ep.url} / field="${winField}"`);
        return true;
      }
    }

    // All endpoints exhausted — fall through to UI approach
    warn("UPLOAD-API", "All known endpoints failed. Falling back to UI approach.");
    return null;
  }

  async function uploadAndConfirm(filledBytes, filename, quantity) {
    const uploadName = filename || "template.xlsx";
    log("UPLOAD", `[A] Creating file object as: "${uploadName}" (qty=${quantity})`);
    const file = new File([new Uint8Array(filledBytes)], uploadName, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    // Derive orderId from URL (needed for direct API upload field substitution)
    const _params  = new URLSearchParams(window.location.search);
    const _orderId = _params.get("order_id") || _params.get("orderId") || "";

    // ── Step A: Close any open modals ────────────────────────────────────────
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(500);

    // ── Step B: Download file to disk (visual confirmation for the user) ──────
    log("UPLOAD", `[B] Downloading XLSX to disk…`);
    const dlResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CDP_DOWNLOAD_FILE", fileBytes: Array.from(filledBytes), filename: uploadName },
        (r) => resolve(r || { ok: false, error: "No response" })
      );
    });
    if (dlResult.ok) {
      log("UPLOAD", `[B] ✅ File on disk: "${dlResult.filePath}"`);
    } else {
      warn("UPLOAD", `[B] Download to disk failed (non-fatal): ${dlResult.error}`);
    }

    // ── Step C: Direct API upload — DISABLED ─────────────────────────────────
    // The endpoint-probing approach causes false positives: one of the guessed
    // URLs returns HTTP 200 with a JSON body that looks like success, but the
    // file is NOT actually uploaded.  This causes confirmDeliveredFlow to run
    // on an empty order, which fails, and the extension loops forever.
    // Skipping directly to the bridge (C_LOCAL) which is proven reliable.

    // ── Step C_LOCAL: Local Playwright Bridge ─────────────────────────────────
    // Sends the filled XLSX to bridge.py running on your local machine.
    // bridge.py connects to your real Chrome via CDP and uploads the file from
    // inside your live session — same IP, real cookies, zero detection surface.
    log("UPLOAD", "[C_LOCAL] Sending XLSX to local Playwright bridge at http://localhost:5000/upload…");
    try {
      const bridgeResp = await fetch("http://localhost:5000/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileBytes: Array.from(filledBytes),
          orderId:   _orderId,
          pageUrl:   window.location.href,
          filename:  uploadName,
        }),
      });
      if (!bridgeResp.ok) {
        warn("UPLOAD", `[C_LOCAL] Bridge HTTP ${bridgeResp.status} — check bridge.py console.`);
      } else {
        const bridgeJson = await bridgeResp.json().catch(() => ({}));
        if (bridgeJson.ok) {
          log("UPLOAD", `[C_LOCAL] ✅ Bridge upload succeeded: ${bridgeJson.message || "ok"}`);
          // Persist a "pending confirm" flag BEFORE marking processed.
          // If Z2U navigates/reloads the page when the upload modal closes,
          // the current async chain dies here. The new content script checks
          // this flag at startup and resumes confirmDeliveredFlow directly,
          // bypassing the bgIsProcessed early-return that would otherwise skip it.
          await chrome.storage.local.set({
            pendingConfirmOrderId: _orderId,
            pendingConfirmQty:     quantity,
          });
          // Now lock against re-upload.
          sessionDone.add(_orderId);
          await bgMarkProcessed(_orderId);
          log("UPLOAD", `[C_LOCAL] 🔒 Order ${_orderId} locked as processed — no re-upload possible.`);
          await sleep(1500);
          const confirmed = await confirmDeliveredFlow(quantity);
          // Clean up the pending flag now that we finished (success or not).
          await chrome.storage.local.remove(["pendingConfirmOrderId", "pendingConfirmQty"]);
          return confirmed;
        }
        warn("UPLOAD", `[C_LOCAL] Bridge returned failure: ${bridgeJson.error || "unknown"}`);
      }
    } catch (e) {
      warn("UPLOAD", `[C_LOCAL] Bridge unreachable (is bridge.py running?): ${e.message}`);
    }

    err("UPLOAD", "[C_LOCAL] ❌ Upload failed. Make sure bridge.py is running on your local machine.");
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

    // Normalise: collapse whitespace, trim, remove zero-width/invisible chars.
    // Used for fuzzy title matching on both list and detail pages.
    function normaliseTitle(s) {
      return (s || "")
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width / soft-hyphen
        .replace(/\s+/g, " ")
        .trim();
    }
    function findMapping(title) {
      if (mappings[title]) return title; // exact match
      const norm = normaliseTitle(title);
      return mappingKeys.find((k) => normaliseTitle(k) === norm) || null;
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

      // Title — try multiple selectors in priority order
      const titleEl = (
        panel.querySelector(".o-l-col.productInfo a") ||
        panel.querySelector(".productInfo a") ||
        panel.querySelector('[class*="productInfo"] a') ||
        panel.querySelector('[class*="goodsName"]') ||
        panel.querySelector('[class*="offerTitle"]') ||
        panel.querySelector('[class*="productTitle"]')
      );
      const title = titleEl?.textContent?.trim() || "";
      if (!title) warn("LIST", `Could not extract title for panel — orderId="${panel.querySelector("[data-clipboard-text]")?.getAttribute("data-clipboard-text")?.trim()}". HTML snippet: ${panel.innerHTML.slice(0, 300)}`);

      // Detail link
      const detailLink = panel.querySelector('.o-l-col.productStatus a[href*="sellOrder"]');
      const detailHref = detailLink?.getAttribute("href") || "";

      const resolvedListTitle = findMapping(title);
      log("LIST", `🔍 NEW ORDER → orderId="${orderId}" | title="${title}" | resolvedTitle="${resolvedListTitle}" | href="${detailHref}"`);

      if (!orderId) {
        warn("LIST", "Could not extract orderId — skipping.");
        continue;
      }

      // ── Unmapped NEW ORDER: click Prepare and return ─────────────────────
      if (!resolvedListTitle) {
        // Only act on NEW ORDER status for unmapped offers (PREPARING/DELIVERING leave them alone)
        if (!statusText.includes("NEW ORDER")) {
          log("LIST", `Unmapped order ${orderId} in state "${statusText}" — ignoring.`);
          continue;
        }

        if (sessionDone.has(orderId)) {
          log("LIST", `Unmapped order ${orderId} already prepared this session.`);
          continue;
        }
        const alreadyPrepared = await bgIsPreparedOnly(orderId);
        if (alreadyPrepared) {
          log("LIST", `Unmapped order ${orderId} already had Prepare clicked — skipping.`);
          continue;
        }

        if (!detailHref) {
          warn("LIST", `No detail link for unmapped order ${orderId}.`);
          continue;
        }

        log("LIST", `⚡ Unmapped NEW ORDER "${title}" (${orderId}) → navigating to click Prepare only`);
        sessionDone.add(orderId);
        await chrome.storage.local.set({ prepareOnly: true, pendingOrderId: orderId, pendingUnmappedTitle: title });
        window.location.href = detailHref;
        return;
      }

      // ── Mapped order: full fulfillment flow ───────────────────────────────
      if (resolvedListTitle !== title) {
        warn("LIST", `Fuzzy title match: extracted="${title}" → mapping key="${resolvedListTitle}"`);
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

      // Store the resolved (mapping-key) title so the detail page finds it immediately
      await chrome.storage.local.set({ pendingOrderId: orderId, pendingTitle: resolvedListTitle });
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

    // ── Prepare-only mode (unmapped orders) ──────────────────────────────────
    // Set by the list page when an unmapped NEW ORDER is detected.
    // We just click "Preparing" and go back — no upload, no confirm.
    const { prepareOnly, pendingOrderId: prepareOrderId, pendingUnmappedTitle: unmappedTitle } = await new Promise((r) =>
      chrome.storage.local.get(["prepareOnly", "pendingOrderId", "pendingUnmappedTitle"], r)
    );

    if (prepareOnly && prepareOrderId === orderId) {
      log("DETAIL", `[PREPARE-ONLY] Unmapped order ${orderId} — clicking Prepare then returning to list.`);
      await chrome.storage.local.remove(["prepareOnly", "pendingOrderId", "pendingUnmappedTitle"]);

      const allBtns = Array.from(document.querySelectorAll("button, a"));
      const prepBtn = allBtns.find((b) => b.textContent?.trim().toUpperCase() === "PREPARING");

      if (prepBtn) {
        log("DETAIL", `[PREPARE-ONLY] Clicking "Preparing" button…`);
        // Store return-to-list flag BEFORE clicking.
        // If clicking Prepare causes Z2U to reload the page, the current async
        // chain is killed. The new script checks pendingReturnToList at [0b]
        // and navigates back to sellOrder/index, keeping the pipeline alive.
        await chrome.storage.local.set({ pendingReturnToList: orderId, pendingReturnTitle: unmappedTitle || "" });
        // If it's an anchor tag, prevent it from navigating away from the page.
        if (prepBtn.tagName === "A") {
          prepBtn.addEventListener("click", (e) => e.preventDefault(), { once: true });
        }
        prepBtn.click();
        log("DETAIL", `[PREPARE-ONLY] ✅ Clicked.`);
        await sleep(1500);
      } else {
        warn("DETAIL", `[PREPARE-ONLY] "Preparing" button not found — already past NEW ORDER? Returning to list anyway.`);
        // Order is already past NEW ORDER; still need to go back to the list.
        await chrome.storage.local.set({ pendingReturnToList: orderId, pendingReturnTitle: unmappedTitle || "" });
      }

      // Mark as "prepare-only" and record analytics, then navigate back.
      chrome.runtime.sendMessage({ type: "MARK_PREPARED_ONLY", orderId }).catch(() => {});
      recordAnalytics(orderId, unmappedTitle || "", 1);
      await chrome.storage.local.remove(["pendingReturnToList", "pendingReturnTitle"]);
      log("DETAIL", `[PREPARE-ONLY] Navigating back to order list.`);
      window.location.href = "https://www.z2u.com/sellOrder/index";
      return;
    }

    // ── [0b] Return to list after Prepare click caused a page reload ───────────
    // If clicking "Preparing" reloaded the page before window.location.href ran,
    // pendingReturnToList is still in storage. Navigate back immediately.
    const { pendingReturnToList, pendingReturnTitle } = await new Promise((r) =>
      chrome.storage.local.get(["pendingReturnToList", "pendingReturnTitle"], r)
    );
    if (pendingReturnToList && pendingReturnToList === orderId) {
      log("DETAIL", `[0b] ↩ Prepare already clicked for ${orderId} — returning to list.`);
      await chrome.storage.local.remove(["pendingReturnToList", "pendingReturnTitle"]);
      chrome.runtime.sendMessage({ type: "MARK_PREPARED_ONLY", orderId }).catch(() => {});
      recordAnalytics(orderId, pendingReturnTitle || "", 1);
      window.location.href = "https://www.z2u.com/sellOrder/index";
      return;
    }

    // ── [0] Resume pending Confirm Delivery after page reload ─────────────────
    // If Z2U navigated/reloaded the page after the bridge uploaded the XLSX,
    // the previous async chain was killed before confirmDeliveredFlow could run.
    // We stored pendingConfirmOrderId + pendingConfirmQty to survive that reload.
    // This check MUST come before [4] bgIsProcessed, which would otherwise
    // return early (the order IS marked processed to block re-upload).
    const { pendingConfirmOrderId, pendingConfirmQty } = await new Promise((r) =>
      chrome.storage.local.get(["pendingConfirmOrderId", "pendingConfirmQty"], r)
    );
    if (pendingConfirmOrderId && pendingConfirmOrderId === orderId) {
      const qty = pendingConfirmQty || 1;
      log("DETAIL", `[0] ↩ Resuming confirmDeliveredFlow for ${orderId} (qty=${qty}) after page reload.`);
      await chrome.storage.local.remove(["pendingConfirmOrderId", "pendingConfirmQty"]);
      await confirmDeliveredFlow(qty);
      return;
    }

    // ── [0c] Navigate to list after Confirm Delivered caused a page reload ────
    // When clicking "Confirm Delivered" triggers a Z2U page reload, the async
    // chain is killed before [D4] can run. pendingNavigateToList was set just
    // before the click and survives the reload — navigate back to the order list.
    const { pendingNavigateToList } = await new Promise((r) =>
      chrome.storage.local.get(["pendingNavigateToList"], r)
    );
    if (pendingNavigateToList && pendingNavigateToList === orderId) {
      log("DETAIL", `[0c] ↩ Confirm Delivered completed for ${orderId} — navigating to order list.`);
      await chrome.storage.local.remove(["pendingNavigateToList"]);
      window.location.href = "https://www.z2u.com/sellOrder/index";
      return;
    }

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

        // Only auto-click Preparing + redirect if the list-page automation
        // triggered this navigation (prepareOnly flag set).
        // If the user manually opened the order, leave the page completely alone.
        if (prepareOnly && hasNew) {
          const prepBtn = Array.from(document.querySelectorAll("button, a"))
            .find((b) => b.textContent?.trim().toUpperCase() === "PREPARING");
          if (prepBtn) {
            log("DETAIL", `[3] Unmapped NEW ORDER (automation) — clicking Preparing.`);
            prepBtn.click();
          } else {
            warn("DETAIL", `[3] Unmapped — Preparing button not found.`);
          }
          chrome.runtime.sendMessage({ type: "MARK_PROCESSED", orderId }).catch(() => {});
          window.location.href = "https://www.z2u.com/sellOrder/index";
        } else {
          log("DETAIL", `[3] Unmapped order — user navigated manually. Leaving page alone.`);
        }
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

    // ── Analytics: fire-and-forget (no fulfillment impact) ────────────────────
    recordAnalytics(orderId, title, quantity);

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

      // Find the XLSX delivery template download link.
      // IMPORTANT: be specific — broad selectors like a[href*="download"] or
      // a[href*="template"] match Z2U's app-download and unrelated links, producing
      // false positives that make hasTemplateLink=true and skip PREPARING entirely.
      function findTemplateLink() {
        const allAnchors = Array.from(document.querySelectorAll("a, button"));
        // Primary: text must say DOWNLOAD + a delivery/template-specific word
        const byText = allAnchors.find((el) => {
          const t = el.textContent?.trim().toUpperCase() || "";
          return t.includes("DOWNLOAD") && (
            t.includes("TEMPLATE") ||
            t.includes("BULK DELIVERY") ||
            t.includes("DELIVERY FORM") ||
            t.includes("SELL FORM")
          );
        });
        if (byText) return byText;
        // Href-based: only actual XLSX file links — do NOT use href*="download"
        // or href*="template" as those are too broad
        return document.querySelector('a[href*=".xlsx"], a[download][href*="sell"]');
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

      // ── WAIT FOR CONFIRMED guard ───────────────────────────────────────────
      // Use badgeText (the actual status badge element) NOT pageText (the full page body).
      // pageText includes progress-bar step labels like "Waiting for confirmation"
      // which could false-match and skip PREPARING on a NEW ORDER.
      const hasWaitForConfirm = badgeText.includes("WAIT FOR CONFIRM") ||
                                badgeText.includes("WAITING FOR CONFIRM");
      if (hasWaitForConfirm) {
        log("DETAIL", `[6] 🟡 Badge="${badgeText}" → WAIT FOR CONFIRMED — skipping upload, going straight to confirm delivery.`);
        return await confirmDeliveredFlow(quantity);
      }

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
      const { bytes: templateBlob, filename: templateFilename } = await downloadBlob(templateUrl);
      log("DETAIL", `[9] Original template filename: "${templateFilename}"`);

      // ── [10] Backend ───────────────────────────────────────────────────────
      log("DETAIL", "[10] Sending to backend…");
      let filledBytes;
      try {
        filledBytes = await sendToBackend({
          orderId,
          title: resolvedTitle,
          quantity,
          templateBlob: Array.from(templateBlob),
          templateFilename,
        });
        log("DETAIL", `[10] ✅ Backend success. Filled file size: ${filledBytes.length} bytes`);
      } catch (backendErr) {
        err("DETAIL", `[10] Backend failed: ${backendErr.message}`);
        return;
      }

      // ── [11] Upload + confirm delivered ───────────────────────────────────
      log("DETAIL", "[11] Uploading filled file…");
      const uploaded = await uploadAndConfirm(filledBytes, templateFilename, quantity);
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
    // Check pause flag — network interceptor (injected.js) always runs regardless,
    // so manual uploads are still captured even while automation is paused.
    chrome.storage.local.get(["autoPaused"], ({ autoPaused }) => {
      if (autoPaused) {
        log("INIT", "⏸ Auto-processing is PAUSED. Network capture still active. Resume from popup.");
        return;
      }

      if (isListPage) {
        log("INIT", "▶ Running on LIST page. Will scan every 30s.");
        setTimeout(runListPage, 2500);
        setInterval(runListPage, 30000);
      } else if (isDetailPage) {
        log("INIT", "▶ Running on DETAIL page.");
        setTimeout(runDetailPage, 2500);
      } else {
        log("INIT", `Page not matched: ${href}`);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
