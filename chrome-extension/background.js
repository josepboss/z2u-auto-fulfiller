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
    if (req.method !== "POST") return;

    const ct = (req.headers || {})["content-type"] || (req.headers || {})["Content-Type"] || "(no-ct)";
    console.log("[Z2U-debugger] POST:", req.url, "| CT:", ct, "| hasPostData:", req.hasPostData);

    pendingRequests.set(params.requestId, { url: req.url, tabId });
    checkAndSave(params.requestId, req.url, req.headers || {}, tabId);
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

function checkAndSave(requestId, url, headers, tabId) {
  const ct = headers["content-type"] || headers["Content-Type"] || "";
  // Accept multipart uploads to ANY domain (Z2U may upload to S3/GCS/Azure)
  if (!ct.toLowerCase().includes("multipart/form-data")) return;

  console.log("[Z2U-debugger] ✅ Multipart POST to:", url, "| CT:", ct);
  pendingRequests.delete(requestId);
  stopCaptureMode();

  chrome.debugger.sendCommand({ tabId }, "Network.getRequestPostData", { requestId })
    .then((r) => saveEndpoint(url, parseMultipartFields(r?.postData || "", ct)))
    .catch(() => saveEndpoint(url, [{ key: "file", type: "file" }]));
}

function parseMultipartFields(postData, contentType) {
  const fields = [];
  const bm = contentType.match(/boundary=([^;,\s]+)/i);
  if (!bm) return [{ key: "file", type: "file" }];
  for (const part of postData.split("--" + bm[1].trim())) {
    const m = part.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i);
    if (!m) continue;
    if (m[2]) fields.push({ key: m[1], type: "file" });
    else {
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
      captureTabIds.add(tab.id);
      attached.push(tab.id);
      console.log("[Z2U-debugger] Attached to tab", tab.id, tab.url);
    } catch (e) {
      console.warn("[Z2U-debugger] Network.enable failed on tab", tab.id, ":", e.message);
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

function stopCaptureMode() {
  if (!captureActive) return;
  captureActive = false;
  const tids = [...captureTabIds];
  captureTabIds.clear();
  captureTabId = null;
  chrome.storage.session.remove(["captureTabIds", "captureActive"]);
  chrome.alarms.clear("capture_keepalive");
  for (const tid of tids) chrome.debugger.detach({ tabId: tid }).catch(() => {});
  chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" }).catch(() => {});
  console.log("[Z2U-debugger] Capture stopped, detached tabs:", tids);
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
