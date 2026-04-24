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

  // ── Quantity fill + Confirm Delivered + success check ─────────────────────
  // Shared between the direct-API path and the UI-modal path.
  async function confirmDeliveredFlow(quantity) {
    // Optional: fill transactions quantity if it appeared on page
    const modalElC4 = () => document.querySelector(
      ".ant-modal, .ant-modal-content, .modal, [role='dialog'], [class*='modal'], [class*='dialog']"
    );
    const qtyInputC4 = await (async () => {
      const end = Date.now() + 6000;
      while (Date.now() < end) {
        const numInput = Array.from(document.querySelectorAll("input[type='number']"))
          .find((i) => !i.closest("[style*='display:none'], [hidden]"));
        if (numInput) return numInput;
        const modal = modalElC4();
        if (modal) {
          const inp = Array.from(modal.querySelectorAll("input"))
            .find((i) => i.type !== "file" && i.type !== "hidden" && i.type !== "checkbox");
          if (inp) return inp;
        }
        await sleep(400);
      }
      return null;
    })();

    if (qtyInputC4) {
      const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (nativeSet) nativeSet.call(qtyInputC4, String(quantity));
      else qtyInputC4.value = String(quantity);
      qtyInputC4.dispatchEvent(new Event("input",  { bubbles: true }));
      qtyInputC4.dispatchEvent(new Event("change", { bubbles: true }));
      log("UPLOAD", `[C4] ✅ Set transactions to ${quantity}. Clicking OK…`);
      await sleep(400);
      const okBtn = Array.from(document.querySelectorAll("button"))
        .find((b) => /^(ok|confirm|submit|yes)$/i.test(b.textContent?.trim() || ""));
      if (okBtn) {
        okBtn.click();
        log("UPLOAD", `[C4] ✅ Clicked "${okBtn.textContent?.trim()}"`);
        await sleep(2500);
      }
    } else {
      log("UPLOAD", `[C4] No transactions quantity prompt — continuing to Confirm Delivered`);
    }

    dumpButtons("UPLOAD-BEFORE-CONFIRM");

    // Click Confirm Delivered
    log("UPLOAD", `[D] Looking for Confirm Delivered button…`);
    const confirmBtn =
      await waitForElementByText("button", "confirm delivered", 8000) ||
      await waitForElementByText("button", "delivered", 5000);

    if (!confirmBtn) {
      warn("UPLOAD", "[D] Confirm Delivered button not found.");
      dumpButtons("UPLOAD-FAILED");
      return false;
    }
    log("UPLOAD", `[D] Clicking: "${confirmBtn.textContent?.trim()}"`);
    confirmBtn.click();
    await sleep(3000);

    // Verify via "View Delivery Account Information" button (definitive success signal)
    function hasViewDeliveryBtn() {
      return Array.from(document.querySelectorAll("button, a"))
        .some((b) => /view\s+delivery\s+account/i.test(b.textContent || ""));
    }

    const successEnd = Date.now() + 6000;
    while (Date.now() < successEnd) {
      if (hasViewDeliveryBtn()) {
        log("UPLOAD", `[E] ✅ "View Delivery Account Information" appeared — delivery confirmed!`);
        return true;
      }
      await sleep(500);
    }

    // One more try: click a Confirm button inside a modal that Z2U may show
    const confirmModal = document.querySelector(".modal, [role='dialog'], [class*='modal'], [class*='dialog']");
    if (confirmModal) {
      const innerConfirm = Array.from(confirmModal.querySelectorAll("button"))
        .find((b) => /^confirm$/i.test(b.textContent?.trim() || ""));
      if (innerConfirm) {
        innerConfirm.click();
        await sleep(2500);
        if (hasViewDeliveryBtn()) {
          log("UPLOAD", `[E] ✅ Confirmed via modal — "View Delivery Account Information" appeared.`);
          return true;
        }
      }
    }

    const errBanner = document.querySelector(".ant-message-notice, .ant-message-error, .ant-message-warning");
    if (errBanner) warn("UPLOAD", `[E] Z2U message: "${errBanner.textContent?.trim().slice(0, 200)}"`);
    warn("UPLOAD", `[E] ❌ "View Delivery Account Information" never appeared — delivery NOT confirmed.`);
    return false;
  }

  // ── Direct API upload (bypasses the modal entirely) ───────────────────────
  // Uses the endpoint captured by injected.js from a previous manual/successful
  // upload.  Replays the exact same FormData structure with our filled file,
  // substituting the orderId field with the current order's ID.
  // Z2U file field names to probe when CDP couldn't decode the multipart body
  const Z2U_FILE_FIELDS = ["upfile", "file", "upload", "excel", "formFile"];

  async function tryUploadWithField(url, method, fieldName, extraFields, file, orderId, csrfToken) {
    const formData = new FormData();
    // Attach extra string fields first (order_id, etc.)
    for (const field of (extraFields || [])) {
      if (field.type !== "file") {
        const val = /^Z\d+$/i.test(field.value) ? orderId : (field.value || "");
        formData.append(field.key, val);
      }
    }
    // If orderId and no explicit orderId/order_id field was captured, inject it
    if (orderId && !(extraFields || []).some((f) => /order_?id/i.test(f.key))) {
      formData.append("order_id", orderId);
    }
    formData.append(fieldName, file, file.name);
    log("UPLOAD-API", `  Trying file field="${fieldName}" + ${(extraFields||[]).filter(f=>f.type!=="file").map(f=>f.key).join(",")}`);

    // Build request headers — include CSRF token and browser-like headers so
    // Z2U's middleware treats this as a legitimate same-origin XHR request.
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
    };
    if (csrfToken) {
      headers["X-XSRF-TOKEN"]  = csrfToken;
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
    { url: "https://www.z2u.com/sellOrder/uploadSellForm", method: "POST" },
    { url: "https://www.z2u.com/SellOrder/uploadSellForm", method: "POST" },
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

    // ── Step B: Download file to disk FIRST (before opening the modal) ────────
    // IMPORTANT: do NOT pre-inject into any page-level input. Pre-injection
    // causes the modal to open with the file already selected (in milliseconds),
    // which Z2U detects as non-human and rejects with "Please input note".
    // The correct sequence: file on disk → open empty modal → CDP select.
    log("UPLOAD", `[B] Downloading XLSX to disk before opening modal…`);
    const dlResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CDP_DOWNLOAD_FILE", fileBytes: Array.from(filledBytes), filename: uploadName },
        (r) => resolve(r || { ok: false, error: "No response from background" })
      );
    });
    if (!dlResult.ok) {
      err("UPLOAD", `[B] Download failed: ${dlResult.error}`);
      return false;
    }
    const onDiskPath = dlResult.filePath;
    log("UPLOAD", `[B] ✅ File on disk: "${onDiskPath}"`);

    // ── Step C: Click "Upload Form" — modal will open EMPTY ──────────────────
    log("UPLOAD", `[C] Clicking "Upload Form"…`);
    const uploadFormBtn = await waitForElementByText("button, a", "Upload Form", 5000);
    if (!uploadFormBtn) {
      warn("UPLOAD", `[C] "Upload Form" button not found.`);
      return false;
    }
    uploadFormBtn.click();
    log("UPLOAD", `[C] ✅ Clicked "Upload Form". Waiting for modal to open empty…`);
    await sleep(1500);

    // ── Step C2: Wait for modal to open empty, then CDP-select from disk ────────
    // The modal opens empty (no pre-injection). We wait for the file input to
    // appear, pause for a human-like delay, then use CDP DOM.setFileInputFiles
    // with the already-downloaded on-disk path. This mimics the user browsing
    // to their Downloads folder and selecting the file — isTrusted FileList.
    const modalEl = () => document.querySelector(
      ".ant-modal, .ant-modal-content, .modal, [role='dialog'], [class*='modal'], [class*='dialog']"
    );

    // Wait up to 5s for the modal + its file input to appear
    const modalWaitEnd = Date.now() + 5000;
    let m = null, modalFileInput = null;
    while (Date.now() < modalWaitEnd) {
      m = modalEl();
      if (m) {
        modalFileInput = Array.from(m.querySelectorAll("input[type='file']"))
          .find((i) => !/filepond|order_before|order_after/i.test(i.id + i.name));
        if (modalFileInput) break;
      }
      await sleep(300);
    }

    if (!modalFileInput) {
      const allInputs = Array.from(document.querySelectorAll("input[type='file']"));
      warn("UPLOAD", `[C2] No modal file input. All page inputs: ${allInputs.map(i=>`id="${i.id}" name="${i.name}"`).join(" | ")}`);
      modalFileInput = allInputs.find((i) => !/filepond|order_before|order_after/i.test(i.id + i.name)) || null;
    }

    if (!modalFileInput) {
      err("UPLOAD", "[C2] No file input found anywhere — cannot upload.");
      return false;
    }

    log("UPLOAD", `[C2] ✅ Modal open, file input empty: id="${modalFileInput.id}" name="${modalFileInput.name}"`);

    // Human-like delay: "reading the modal" before selecting file
    await sleep(1200 + Math.floor(Math.random() * 800));

    // CDP setFileInputFiles with the already-downloaded on-disk path
    log("UPLOAD", "[C2] Requesting CDP file selection (setFileInputFiles)…");
    const cdpResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CDP_SET_FILE_BY_PATH", filePath: onDiskPath },
        (r) => resolve(r || { ok: false, error: "No response from background" })
      );
    });

    if (!cdpResult.ok) {
      err("UPLOAD", `[C2] CDP setFileInputFiles failed: ${cdpResult.error}`);
      return false;
    }
    log("UPLOAD", "[C2] ✅ File selected via CDP — isTrusted FileList created.");

    // Human-like delay: "file appeared in modal, reviewing before clicking Submit"
    await sleep(1000 + Math.floor(Math.random() * 1000));

    // ── Step C2.5: Fill any required note/text fields in the modal ───────────
    // Z2U's upload modal includes a required "note" textarea. Leaving it blank
    // causes Z2U to reject the submission with "Please input note".
    {
      const noteCtx = modalEl() || document;
      const textInputs = Array.from(noteCtx.querySelectorAll(
        'textarea, input[type="text"], input:not([type="file"]):not([type="submit"])' +
        ':not([type="button"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
      ));
      for (const ti of textInputs) {
        if (!ti.value || !ti.value.trim()) {
          ti.value = "Delivered";
          ti.dispatchEvent(new Event("input",  { bubbles: true }));
          ti.dispatchEvent(new Event("change", { bubbles: true }));
          // Drive React's own onChange so component state actually updates
          const rk = Object.keys(ti).find(
            k => k.startsWith("__reactProps") || k.startsWith("__reactInternals")
          );
          if (rk && typeof ti[rk]?.onChange === "function") {
            ti[rk].onChange({
              target: ti, currentTarget: ti, type: "change", bubbles: true,
              nativeEvent: { target: ti },
              preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
            });
          } else {
            const fk = Object.keys(ti).find(k => k.startsWith("__reactFiber"));
            const fn = fk && ti[fk]?.memoizedProps?.onChange;
            if (typeof fn === "function") {
              fn({
                target: ti, currentTarget: ti, type: "change", bubbles: true,
                nativeEvent: { target: ti },
                preventDefault: () => {}, stopPropagation: () => {}, persist: () => {},
              });
            }
          }
          log("UPLOAD", `[C2.5] Filled note field tag=${ti.tagName} id="${ti.id}" name="${ti.name}"`);
        }
      }
      // Wait for React to commit all state changes before clicking SUBMIT
      await sleep(800);
    }

    // ── Step C3: Click SUBMIT to upload the file first ────────────────────────
    // Z2U flow: Submit → file uploads → THEN the transactions quantity field appears.
    log("UPLOAD", `[C3] Looking for SUBMIT button to upload file…`);
    const submitBtn = await (async () => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const modal = modalEl();
        if (modal) {
          const btn = Array.from(modal.querySelectorAll("button"))
            .find((b) => /^submit$/i.test(b.textContent?.trim() || ""));
          if (btn) return btn;
        }
        const btn = Array.from(document.querySelectorAll("button"))
          .find((b) => /^submit$/i.test(b.textContent?.trim() || ""));
        if (btn) return btn;
        await sleep(400);
      }
      return null;
    })();

    if (!submitBtn) {
      err("UPLOAD", `[C3] SUBMIT button not found — aborting to avoid false confirmation.`);
      return false;
    }

    submitBtn.click();
    log("UPLOAD", `[C3] ✅ Clicked SUBMIT. Tracking Submit button removal (= modal close = upload accepted)…`);
    await sleep(300); // brief pause so Z2U can process the click

    // ── Wait for the Submit button to leave the DOM ───────────────────────────
    // Checking document.contains(submitBtn) is selector-independent: when the
    // upload modal closes (success), Z2U removes that button from the DOM.
    // When the upload is rejected the modal stays open and the button stays in DOM.
    // We do NOT use modalEl() because Z2U's modal may use custom CSS classes.
    const waitForClose = Date.now() + 12000;
    let uploadAccepted = false;
    while (Date.now() < waitForClose) {
      // Fast-fail: catch visible error toasts
      const toastEls = Array.from(document.querySelectorAll(
        ".ant-message-notice, .ant-message-error, .ant-message-warning, " +
        ".el-message, [class*='toast'], [class*='notify']"
      ));
      for (const t of toastEls) {
        const txt = t.textContent?.trim() || "";
        if (txt && /input|note|select|file|upload|error|fail|invalid/i.test(txt)) {
          err("UPLOAD", `[C3] Upload rejected: "${txt.slice(0, 200)}" — aborting.`);
          return false;
        }
      }
      // Submit button removed from DOM = modal closed = upload accepted
      if (!document.contains(submitBtn)) {
        uploadAccepted = true;
        break;
      }
      await sleep(400);
    }

    if (!uploadAccepted) {
      warn("UPLOAD", `[C3] UI upload did not complete — trying direct API with session cookies as fallback…`);

      // ── Step Z: Direct API fallback with CSRF cookie injection ───────────
      // Read the XSRF-TOKEN cookie (non-httpOnly on most Laravel/PHP stacks)
      // and inject it as the X-XSRF-TOKEN request header so Z2U's CSRF
      // middleware accepts the programmatic POST.
      const csrfRaw = document.cookie
        .split(";")
        .map((c) => c.trim())
        .find((c) => /^XSRF-TOKEN=/i.test(c));
      const csrfToken = csrfRaw ? decodeURIComponent(csrfRaw.split("=").slice(1).join("=")) : "";
      if (csrfToken) {
        log("UPLOAD", `[Z] XSRF-TOKEN found — will include X-XSRF-TOKEN header`);
      } else {
        warn("UPLOAD", `[Z] No XSRF-TOKEN in document.cookie — direct API may still fail`);
      }

      try {
        const apiOk = await directApiUpload(file, _orderId, csrfToken);
        if (apiOk) {
          log("UPLOAD", `[Z] ✅ Direct API fallback succeeded.`);
          await sleep(1500);
          return await confirmDeliveredFlow(quantity);
        }
        err("UPLOAD", `[Z] Direct API fallback returned no data — giving up.`);
      } catch (apiErr) {
        err("UPLOAD", `[Z] Direct API fallback threw: ${apiErr.message}`);
      }
      return false;
    }

    log("UPLOAD", `[C3] ✅ Submit button gone — modal closed, upload accepted by Z2U.`);
    await sleep(500);

    // ── C4 / D / E: Shared confirm-delivered flow ────────────────────────────
    return await confirmDeliveredFlow(quantity);
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

      // ── Unmapped NEW ORDER: click Prepare and return ─────────────────────
      if (!mappings[title]) {
        // Only act on NEW ORDER status for unmapped offers (PREPARING/DELIVERING leave them alone)
        if (!statusText.includes("NEW ORDER")) {
          log("LIST", `Unmapped order ${orderId} in state "${statusText}" — ignoring.`);
          continue;
        }

        if (sessionDone.has(orderId)) {
          log("LIST", `Unmapped order ${orderId} already prepared this session.`);
          continue;
        }
        const alreadyDone = await bgIsProcessed(orderId);
        if (alreadyDone) {
          log("LIST", `Unmapped order ${orderId} already processed.`);
          continue;
        }

        if (!detailHref) {
          warn("LIST", `No detail link for unmapped order ${orderId}.`);
          continue;
        }

        log("LIST", `⚡ Unmapped NEW ORDER "${title}" (${orderId}) → navigating to click Prepare only`);
        sessionDone.add(orderId);
        await chrome.storage.local.set({ prepareOnly: true, pendingOrderId: orderId });
        window.location.href = detailHref;
        return;
      }

      // ── Mapped order: full fulfillment flow ───────────────────────────────
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

    // ── Prepare-only mode (unmapped orders) ──────────────────────────────────
    // Set by the list page when an unmapped NEW ORDER is detected.
    // We just click "Preparing" and go back — no upload, no confirm.
    const { prepareOnly, pendingOrderId: prepareOrderId } = await new Promise((r) =>
      chrome.storage.local.get(["prepareOnly", "pendingOrderId"], r)
    );

    if (prepareOnly && prepareOrderId === orderId) {
      log("DETAIL", `[PREPARE-ONLY] Unmapped order ${orderId} — clicking Prepare then returning to list.`);
      await chrome.storage.local.remove(["prepareOnly", "pendingOrderId"]);

      const allBtns = Array.from(document.querySelectorAll("button, a"));
      const prepBtn = allBtns.find((b) => b.textContent?.trim().toUpperCase() === "PREPARING");

      if (prepBtn) {
        log("DETAIL", `[PREPARE-ONLY] Clicking "Preparing" button…`);
        prepBtn.click();
        log("DETAIL", `[PREPARE-ONLY] ✅ Clicked.`);
      } else {
        warn("DETAIL", `[PREPARE-ONLY] "Preparing" button not found — may already be past NEW ORDER.`);
        dumpButtons("PREPARE-ONLY-STUCK");
      }

      // Fire-and-forget — do NOT await, SW may be sleeping and would block indefinitely
      chrome.runtime.sendMessage({ type: "MARK_PROCESSED", orderId }).catch(() => {});

      // Navigate back immediately — don't wait for anything
      log("DETAIL", `[PREPARE-ONLY] Navigating back to order list.`);
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

        // Unmapped NEW ORDER on the detail page — click Preparing and return to list.
        if (hasNew) {
          const prepBtn = Array.from(document.querySelectorAll("button, a"))
            .find((b) => b.textContent?.trim().toUpperCase() === "PREPARING");
          if (prepBtn) {
            log("DETAIL", `[3] Unmapped NEW ORDER — clicking Preparing.`);
            prepBtn.click();
          } else {
            warn("DETAIL", `[3] Unmapped — Preparing button not found.`);
          }
          chrome.runtime.sendMessage({ type: "MARK_PROCESSED", orderId }).catch(() => {});
          window.location.href = "https://www.z2u.com/sellOrder/index";
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
