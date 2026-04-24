importScripts("config.js");

// ── Startup: auto-clear bad captures (e.g. Cloudflare /cdn-cgi/ beacons) ───
chrome.storage.local.get(["z2uUploadEndpoint"], (d) => {
  const saved = d.z2uUploadEndpoint;
  if (saved?.url && /cdn-cgi|beacon|analytics|rum|ping|track/i.test(saved.url)) {
    console.log("[Z2U] Auto-clearing bad captured endpoint:", saved.url);
    chrome.storage.local.remove("z2uUploadEndpoint");
  } else if (saved?.url) {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
  }
});

// ── Debugger-based upload URL capture ────────────────────────────────────────
// KEY DESIGN: listener is registered at TOP LEVEL so it survives MV3 service-
// worker restarts. Capture state is persisted in chrome.storage.session so it
// is restored automatically when the SW wakes back up.
// A keep-alive alarm fires every 20 s during capture to prevent SW termination.

let captureTabIds = new Set(); // all tabs being monitored (multi-tab support)
let captureTabId  = null;     // kept for backward compat / single-tab restore
let captureActive = false;

// ── Restore state on every SW startup ───────────────────────────────────────
chrome.storage.session.get(["captureTabIds", "captureActive"], async (d) => {
  if (d.captureActive && d.captureTabIds?.length) {
    captureActive = true;
    for (const tid of d.captureTabIds) {
      captureTabIds.add(tid);
      try {
        await chrome.debugger.sendCommand({ tabId: tid }, "Network.enable");
        await chrome.debugger.sendCommand({ tabId: tid }, "Fetch.enable", {
          patterns: [{ requestStage: "Request" }],
        });
        console.log("[Z2U-debugger] Restored capture on tab", tid);
      } catch (e) {
        console.warn("[Z2U-debugger] Could not restore tab", tid, ":", e.message);
        captureTabIds.delete(tid);
      }
    }
    if (captureTabIds.size === 0) {
      captureActive = false;
      chrome.storage.session.remove(["captureTabIds", "captureActive"]);
    } else {
      captureTabId = [...captureTabIds][0]; // keep compat var
    }
  }
});

// ── TOP-LEVEL listener: survives SW restarts ─────────────────────────────────
const pendingRequests = new Map();

// Registered at top level — Chrome re-registers this on every SW startup.
// IMPORTANT: captureActive may be false on first invocation after SW restart
// because chrome.storage.session.get (async) hasn't resolved yet.
// We handle this by doing a one-shot storage check inside the listener.
chrome.debugger.onEvent.addListener(function onDebugEvent(source, method, params) {
  if (captureActive && captureTabIds.has(source.tabId)) {
    // Normal path — state already loaded
    handleDebugEvent(source, method, params);
    return;
  }

  // SW may have just restarted: captureActive is still false.
  // Lazily read session storage and re-process this event.
  if (!captureActive) {
    chrome.storage.session.get(["captureTabIds", "captureActive"], (d) => {
      if (d.captureActive && d.captureTabIds?.length) {
        captureActive = true;
        for (const tid of d.captureTabIds) captureTabIds.add(tid);
        captureTabId = [...captureTabIds][0];
        console.log("[Z2U-debugger] Lazily restored capture for tabs:", [...captureTabIds]);
        if (captureTabIds.has(source.tabId)) {
          handleDebugEvent(source, method, params);
        }
      }
    });
  }
});

function handleDebugEvent(source, method, params) {
  const tabId = source.tabId;

  if (method === "Network.requestWillBeSent") {
    const req = params.request;
    // Skip methods that never carry a file upload
    if (["GET", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(req.method)) return;

    const ct = (req.headers || {})["content-type"] || (req.headers || {})["Content-Type"] || "(no-ct)";
    console.log(`[Z2U-debugger] ${req.method}:`, req.url, "| CT:", ct, "| hasPostData:", req.hasPostData);

    pendingRequests.set(params.requestId, { url: req.url, tabId, hasPostData: req.hasPostData });
    checkAndSave(params.requestId, req.url, req.headers || {}, tabId, req.hasPostData);
    return;
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    const pending = pendingRequests.get(params.requestId);
    if (!pending) return;
    const hdrs = params.headers || {};
    const ct = hdrs["content-type"] || hdrs["Content-Type"] || "";
    if (ct) console.log("[Z2U-debugger] ExtraInfo CT for", pending.url, ":", ct);
    checkAndSave(params.requestId, pending.url, hdrs, pending.tabId);
    return;
  }

  if (method === "Network.responseReceived" || method === "Network.loadingFailed") {
    pendingRequests.delete(params.requestId);
    return;
  }

  // Fetch domain — intercepts ALL requests before they're sent
  // MUST call Fetch.continueRequest for EVERY paused request or the page freezes.
  // This runs even after captureActive=false (during the drain window).
  if (method === "Fetch.requestPaused") {
    const req = params.request;
    // Always resume the request FIRST — no conditions, no exceptions
    chrome.debugger.sendCommand({ tabId }, "Fetch.continueRequest", {
      requestId: params.requestId,
    }).catch(() => {});

    // Only analyze the request if we're still actively watching for uploads
    if (!captureActive) return;
    if (!["GET", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(req.method)) {
      const ct = (req.headers || {})["content-type"] || (req.headers || {})["Content-Type"] || "(no-ct)";
      console.log(`[Z2U-fetch] ${req.method}:`, req.url, "| CT:", ct, "| postData:", !!params.postData);
      // Use postData available directly in Fetch.requestPaused
      const hdrs = req.headers || {};
      if (params.postData) {
        // Body is available — check inline without a second roundtrip
        const boundary = (hdrs["content-type"] || hdrs["Content-Type"] || "").match(/boundary=([^;,\s]+)/i);
        if (boundary) {
          saveEndpoint(req.url, parseMultipartFields(params.postData, hdrs["content-type"] || hdrs["Content-Type"] || ""));
          // 4s delay: keep Fetch intercept alive so upload response can complete
          stopCaptureMode(4000);
          return;
        }
      }
      // No inline body — use normal checkAndSave with the network requestId if available
      if (params.networkId) {
        checkAndSave(params.networkId, req.url, hdrs, tabId, true);
      } else {
        checkAndSave(params.requestId, req.url, hdrs, tabId, true);
      }
    }
  }
}

// Clear capture state if a monitored tab is closed/refreshed
chrome.debugger.onDetach.addListener((source) => {
  if (!captureTabIds.has(source.tabId)) return;
  captureTabIds.delete(source.tabId);
  console.log("[Z2U-debugger] Tab", source.tabId, "detached. Remaining:", [...captureTabIds]);
  if (captureTabIds.size === 0) {
    captureActive = false;
    captureTabId  = null;
    chrome.storage.session.remove(["captureTabIds", "captureActive"]);
    chrome.alarms.clear("capture_keepalive");
    chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" }).catch(() => {});
  }
});

const UPLOAD_CT = [
  "multipart/form-data",
  "application/vnd.openxmlformats",      // xlsx
  "application/octet-stream",            // raw binary
  // Note: x-www-form-urlencoded intentionally excluded — too broad (used by all regular forms)
];

function isUploadRequest(ct, hasPostData) {
  if (!ct && !hasPostData) return false;
  return UPLOAD_CT.some((t) => ct.toLowerCase().includes(t));
}

function checkAndSave(requestId, url, headers, tabId, hasPostData = false) {
  const ct = headers["content-type"] || headers["Content-Type"] || "";

  // Skip known analytics/tracking regardless of content-type
  if (/clarity|analytics|beacon|rum|gtag|facebook|sentry|datadog|hotjar|logrocket|google\.|googleadservices|doubleclick|googlesyndication|googletagmanager|bing\.com|yahoo|twitter\.com|tiktok|snapchat/i.test(url)) return;

  // Must look like a file upload by content-type (or have a body + upload-like URL)
  // "submit" removed — too broad (Google GA uses it)
  const uploadUrl = /upload|deliver|\.xlsx|attach|file[_-]?upload|importFile/i.test(url);
  if (!isUploadRequest(ct, hasPostData) && !uploadUrl) return;

  console.log("[Z2U-debugger] ✅ Upload candidate:", url, "| CT:", ct);
  pendingRequests.delete(requestId);
  // Delay detach 4s so the upload completes before we release Fetch intercept
  stopCaptureMode(4000);

  chrome.debugger.sendCommand({ tabId }, "Network.getRequestPostData", { requestId })
    .then((r) => {
      const parsed = parseMultipartFields(r?.postData || "", ct);
      saveEndpoint(url, parsed);
    })
    .catch(() => saveEndpoint(url, null));
}

// Known Z2U file field names in priority order (matches DOM id="upfile" / name="upload")
const Z2U_FILE_FIELDS = ["upfile", "file", "upload", "excel", "formFile"];

function parseMultipartFields(postData, contentType) {
  const fields = [];
  const bm = contentType.match(/boundary=([^;,\s]+)/i);
  if (!bm) return null; // null = "not parsed, use probing fallback"
  for (const part of postData.split("--" + bm[1].trim())) {
    const m = part.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i);
    if (!m) continue;
    if (m[2]) fields.push({ key: m[1], type: "file" });
    else {
      const v = part.split(/\r?\n\r?\n/);
      fields.push({ key: m[1], type: "string", value: v.length > 1 ? v[1].trim() : "" });
    }
  }
  return fields.length ? fields : null;
}

function saveEndpoint(url, fields) {
  // fields === null means CDP couldn't decode the body → use field-probing mode
  const endpoint = { url, method: "POST", fields: fields || null, probeFields: !fields };
  chrome.storage.local.set({ z2uUploadEndpoint: endpoint }, () => {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    console.log("[Z2U-debugger] Endpoint saved:", url, fields);
    chrome.runtime.sendMessage({ type: "CAPTURE_COMPLETE", url }).catch(() => {});
  });
}

async function startCaptureMode() {
  const tabs = await chrome.tabs.query({ url: ["https://z2u.com/*", "https://www.z2u.com/*"] });
  if (!tabs.length) return { ok: false, error: "No Z2U tab open. Open z2u.com first." };

  captureTabIds.clear();
  const attached = [];

  for (const tab of tabs) {
    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    } catch (e) {
      if (!e.message.includes("already attached")) {
        console.warn("[Z2U-debugger] Could not attach to tab", tab.id, ":", e.message);
        continue;
      }
    }
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
      // Also enable Fetch domain: catches PUT/PATCH and requests Network misses
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Fetch.enable", {
        patterns: [{ requestStage: "Request" }],
      });
      captureTabIds.add(tab.id);
      attached.push(tab.id);
      console.log("[Z2U-debugger] Attached to tab", tab.id, tab.url);
    } catch (e) {
      console.warn("[Z2U-debugger] Enable failed on tab", tab.id, ":", e.message);
      chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    }
  }

  if (captureTabIds.size === 0) return { ok: false, error: "Could not attach to any Z2U tab." };

  captureActive = true;
  captureTabId  = attached[0];
  await chrome.storage.session.set({ captureTabIds: attached, captureActive: true });

  // Keep-alive alarm: wakes SW every 20 s so it doesn't die during capture
  chrome.alarms.create("capture_keepalive", { periodInMinutes: 20 / 60 });

  console.log("[Z2U-debugger] Capture started on", attached.length, "tab(s):", attached);
  return { ok: true, tabCount: attached.length };
}

function stopCaptureMode(delayDetachMs = 0) {
  if (!captureActive) return;
  // Phase 1 (immediate): stop watching for new uploads
  captureActive = false;
  captureTabId  = null;
  chrome.storage.session.remove(["captureTabIds", "captureActive"]);
  chrome.alarms.clear("capture_keepalive");
  chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" }).catch(() => {});
  console.log("[Z2U-debugger] Capture watching stopped. Detach in", delayDetachMs, "ms.");

  // Phase 2 (delayed): detach debugger AFTER the upload request has time to complete
  // If Fetch.enable is active, detaching immediately cancels all paused requests.
  const tids = [...captureTabIds];
  const doDetach = () => {
    captureTabIds.clear();
    for (const tid of tids) chrome.debugger.detach({ tabId: tid }).catch(() => {});
    console.log("[Z2U-debugger] Detached tabs:", tids);
  };
  if (delayDetachMs > 0) {
    setTimeout(doDetach, delayDetachMs);
  } else {
    doDetach();
  }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scheduleNextRefresh() {
  const seconds = randomBetween(
    CONFIG.MIN_REFRESH_SECONDS,
    CONFIG.MAX_REFRESH_SECONDS
  );
  chrome.alarms.create("refresh_orders", { delayInMinutes: seconds / 60 });
  console.log(`[Z2U] Next refresh in ${seconds}s`);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Z2U] Extension installed. Scheduling first refresh.");
  scheduleNextRefresh();
  // Chat tab refresh is now triggered on-demand from Telegram — no auto-refresh alarm.
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // Keep-alive ping — just waking the service worker is enough
  if (alarm.name === "capture_keepalive") {
    console.log("[Z2U-debugger] Keep-alive ping — SW still active, captureActive=", captureActive);
    return;
  }

  if (alarm.name !== "refresh_orders") return;

  // Query for both z2u.com and www.z2u.com variants
  chrome.tabs.query({}, (allTabs) => {
    const z2uTab = allTabs.find(
      (t) => t.url && t.url.includes("z2u.com/sellOrder/index")
    );

    if (z2uTab) {
      chrome.tabs.reload(z2uTab.id, () => {
        console.log(`[Z2U] Refreshed tab ${z2uTab.id}: ${z2uTab.url}`);
      });
    } else {
      // Do NOT open a new tab — just wait for the user to have the page open
      console.log("[Z2U] No Z2U sell order tab found. Skipping refresh until next cycle.");
    }

    scheduleNextRefresh();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ENDPOINT_CAPTURED") {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "RESET_ENDPOINT") {
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "START_CAPTURE") {
    startCaptureMode()
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === "STOP_CAPTURE") {
    stopCaptureMode();
    sendResponse({ ok: true });
    return true;
  }

  // Inject interceptor into page's main JS world — bypasses CSP
  if (message.type === "INJECT_INTERCEPTOR") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab ID in sender" });
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId },
      files:  ["injected.js"],
      world:  "MAIN",
    }).then(() => {
      console.log(`[Z2U] Interceptor injected into tab ${tabId}`);
      sendResponse({ ok: true });
    }).catch((e) => {
      console.warn(`[Z2U] Interceptor injection failed on tab ${tabId}:`, e.message);
      sendResponse({ ok: false, error: e.message });
    });
    return true; // keep channel open for async sendResponse
  }

  if (message.type === "PROCESS_ORDER") {
    handleOrderProcessing(message.data)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_MAPPINGS") {
    fetchMappings()
      .then((mappings) => sendResponse({ ok: true, mappings }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "IS_PROCESSED") {
    const { orderId } = message;
    chrome.storage.local.get("processed", ({ processed }) => {
      const set = new Set(processed || []);
      sendResponse({ processed: set.has(orderId) });
    });
    return true;
  }

  if (message.type === "MARK_PROCESSED") {
    const { orderId } = message;
    chrome.storage.local.get("processed", ({ processed }) => {
      const set = new Set(processed || []);
      set.add(orderId);
      chrome.storage.local.set({ processed: Array.from(set) }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // Separate tracking for unmapped orders where we only clicked Prepare.
  // These are NOT fully fulfilled — kept separate so mapped orders (which
  // may share the same orderId if mapping is added later) are not blocked.
  if (message.type === "IS_PREPARED_ONLY") {
    const { orderId } = message;
    chrome.storage.local.get("preparedOnly", ({ preparedOnly }) => {
      const set = new Set(preparedOnly || []);
      sendResponse({ prepared: set.has(orderId) });
    });
    return true;
  }

  if (message.type === "MARK_PREPARED_ONLY") {
    const { orderId } = message;
    chrome.storage.local.get("preparedOnly", ({ preparedOnly }) => {
      const set = new Set(preparedOnly || []);
      set.add(orderId);
      // Keep the set bounded (max 500 entries)
      const arr = Array.from(set);
      chrome.storage.local.set({ preparedOnly: arr.slice(-500) }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // ── CDP-based file injection ───────────────────────────────────────────────
  // Downloads the filled XLSX to disk then uses DOM.setFileInputFiles (CDP) to
  // attach it to Z2U's upload modal file input.  This creates a genuinely
  // trusted FileList at the browser-engine level — identical to the user
  // picking the file through the OS file picker — so React's onChange fires
  // with isTrusted=true and the component state is properly updated.
  // Read ALL Z2U cookies (including httpOnly) for server-side proxy upload
  if (message.type === "GET_Z2U_COOKIES") {
    Promise.all([
      chrome.cookies.getAll({ domain: "z2u.com" }),
      chrome.cookies.getAll({ domain: "www.z2u.com" }),
    ]).then(([a, b]) => {
      const seen = new Set();
      const all = [...a, ...b].filter((c) => {
        const key = `${c.name}=${c.domain}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      console.log("[Z2U-EXT] GET_Z2U_COOKIES →", all.length, "cookies");
      sendResponse({ ok: true, cookies: all });
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Step 1: download XLSX to disk, return the on-disk path (no DOM interaction)
  if (message.type === "CDP_DOWNLOAD_FILE") {
    const { fileBytes, filename } = message;
    cdpDownloadFileToDisk(fileBytes, filename)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // Step 2: attach the already-downloaded file to the modal's file input via CDP
  if (message.type === "CDP_SET_FILE_BY_PATH") {
    const { filePath } = message;
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "No tab ID" }); return true; }
    cdpSetFileByPath(tabId, filePath)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ── CDP helper 1: download XLSX bytes to disk, return on-disk path ───────────
// Called BEFORE the upload modal is opened. The download appears in Chrome's
// download bar so the user can see it — then the modal opens empty.
async function cdpDownloadFileToDisk(fileBytes, filename) {
  const bytes = new Uint8Array(fileBytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const dataUrl = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`;
  const dlFilename = filename || "Z2U_delivery_temp.xlsx";

  const filePath = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: dlFilename, conflictAction: "overwrite", saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        const timeout = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChange);
          reject(new Error("Download timed out after 15s"));
        }, 15000);
        function onChange(delta) {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChange);
            clearTimeout(timeout);
            chrome.downloads.search({ id: downloadId }, (results) => {
              const p = results?.[0]?.filename;
              p ? resolve(p) : reject(new Error("Downloaded path not found"));
            });
          } else if (delta.state?.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChange);
            clearTimeout(timeout);
            reject(new Error(`Download interrupted: ${delta.error?.current || "unknown"}`));
          }
        }
        chrome.downloads.onChanged.addListener(onChange);
      }
    );
  });

  console.log("[Z2U-CDP] ✅ File saved to disk:", filePath);
  return { ok: true, filePath };
}

// ── CDP helper 2: attach on-disk file to the modal's file input via CDP ───────
// Called AFTER the modal is open and empty, with a human-like delay between.
// DOM.setFileInputFiles creates an isTrusted FileList at the browser-engine
// level — identical to the user browsing Downloads and selecting the file.
async function cdpSetFileByPath(tabId, filePath) {
  const alreadyAttached = captureTabIds.has(tabId);
  if (!alreadyAttached) {
    await chrome.debugger.attach({ tabId }, "1.3");
    console.log("[Z2U-CDP] Debugger attached to tab", tabId);
  } else {
    console.log("[Z2U-CDP] Reusing existing debugger session on tab", tabId);
  }
  try {
    const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: 1 });
    const selectors = [
      ".ant-modal input[type='file']",
      "[role='dialog'] input[type='file']",
      "[class*='modal'] input[type='file']",
      "[class*='dialog'] input[type='file']",
      "input[type='file']",
    ];
    let inputNodeId = 0;
    for (const sel of selectors) {
      const r = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
        nodeId: doc.root.nodeId, selector: sel,
      });
      if (r?.nodeId) {
        inputNodeId = r.nodeId;
        console.log("[Z2U-CDP] File input found:", sel, "nodeId:", inputNodeId);
        break;
      }
    }
    if (!inputNodeId) throw new Error("File input not found via CDP DOM query");
    await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
      nodeId: inputNodeId,
      files: [filePath],
    });
    console.log("[Z2U-CDP] ✅ DOM.setFileInputFiles complete — isTrusted FileList set.");
    return { ok: true };
  } finally {
    if (!alreadyAttached) {
      chrome.debugger.detach({ tabId }).catch(() => {});
      console.log("[Z2U-CDP] Debugger detached.");
    }
  }
}

async function fetchMappings() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  const base = serverUrl || CONFIG.SERVER_URL;
  const res = await fetch(`${base}/api/admin/mappings`);
  if (!res.ok) throw new Error(`Failed to fetch mappings: ${res.status}`);
  return await res.json();
}

async function handleOrderProcessing(orderData) {
  const { orderId, title, quantity, templateBlob, templateFilename } = orderData;

  const { processed } = await chrome.storage.local.get("processed");
  const processedSet = new Set(processed || []);

  if (processedSet.has(orderId)) {
    console.log(`[Z2U] Order ${orderId} already processed, skipping.`);
    return { skipped: true };
  }

  console.log(`[Z2U] Sending order ${orderId} to backend for processing.`);

  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  const base = serverUrl || CONFIG.SERVER_URL;

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(templateBlob)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    templateFilename || "template.xlsx"
  );
  formData.append("title", title);
  formData.append("quantity", String(quantity));
  formData.append("orderId", orderId);

  const res = await fetch(`${base}/api/process-order`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend error: ${res.status} — ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();

  // NOTE: Do NOT mark as processed here — content.js does that ONLY after
  // the filled file is successfully uploaded and Z2U confirms delivery.
  return { filledFile: Array.from(new Uint8Array(arrayBuffer)) };
}
