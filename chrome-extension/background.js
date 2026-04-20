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
// Uses Chrome DevTools Protocol (CDP) Network events — captures every request
// at the browser level regardless of XHR, fetch, iframe, web worker, etc.
// No false positives: filters by z2u.com domain + multipart Content-Type.
const CAPTURE = { tabId: null, active: false, timeoutId: null };

function onDebugEvent(source, method, params) {
  if (!CAPTURE.active || source.tabId !== CAPTURE.tabId) return;
  if (method !== "Network.requestWillBeSent") return;

  const req = params.request;
  if (req.method !== "POST") return;
  if (!/z2u\.com/i.test(req.url)) return;
  if (/cdn-cgi|beacon|rum|ping|track/i.test(req.url)) return;

  // Only save multipart/form-data (actual file upload)
  const headers = req.headers || {};
  const ct = headers["content-type"] || headers["Content-Type"] || "";
  if (!ct.toLowerCase().includes("multipart/form-data")) return;

  console.log("[Z2U-debugger] ✅ File upload URL captured:", req.url, "| CT:", ct);

  // Try to read the POST body to get exact field names
  chrome.debugger.sendCommand(
    { tabId: CAPTURE.tabId },
    "Network.getRequestPostData",
    { requestId: params.requestId }
  ).then((resp) => {
    const fields = parseMultipartFields(resp?.postData || "", ct);
    saveEndpoint(req.url, fields);
  }).catch(() => {
    // Body not available — use safe default field name
    saveEndpoint(req.url, [{ key: "file", type: "file" }]);
  });

  stopCaptureMode();
}

function parseMultipartFields(postData, contentType) {
  const fields = [];
  const bm = contentType.match(/boundary=([^;,\s]+)/i);
  if (!bm) return [{ key: "file", type: "file" }];
  const sep = "--" + bm[1].trim();
  for (const part of postData.split(sep)) {
    const m = part.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i);
    if (!m) continue;
    if (m[2]) {
      fields.push({ key: m[1], type: "file" });
    } else {
      const v = part.split(/\r?\n\r?\n/);
      fields.push({ key: m[1], type: "string", value: v.length > 1 ? v[1].trim() : "" });
    }
  }
  return fields.length ? fields : [{ key: "file", type: "file" }];
}

function saveEndpoint(url, fields) {
  const endpoint = { url, method: "POST", fields };
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

  const tab = tabs[0];
  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    return { ok: false, error: `Debugger attach failed: ${e.message}` };
  }

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
  } catch (e) {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    return { ok: false, error: `Network.enable failed: ${e.message}` };
  }

  CAPTURE.tabId  = tab.id;
  CAPTURE.active = true;
  chrome.debugger.onEvent.addListener(onDebugEvent);

  // Auto-stop after 3 min if user forgets
  CAPTURE.timeoutId = setTimeout(() => stopCaptureMode(), 3 * 60 * 1000);
  console.log("[Z2U-debugger] Capture mode started on tab", tab.id, tab.url);
  return { ok: true };
}

function stopCaptureMode() {
  if (!CAPTURE.active) return;
  CAPTURE.active = false;
  if (CAPTURE.timeoutId) clearTimeout(CAPTURE.timeoutId);
  chrome.debugger.onEvent.removeListener(onDebugEvent);
  const tid = CAPTURE.tabId;
  CAPTURE.tabId = null;
  if (tid) chrome.debugger.detach({ tabId: tid }).catch(() => {});
  chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" }).catch(() => {});
  console.log("[Z2U-debugger] Capture mode stopped.");
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
});

chrome.alarms.onAlarm.addListener((alarm) => {
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
});

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
