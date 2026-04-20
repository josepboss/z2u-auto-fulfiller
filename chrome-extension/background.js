importScripts("config.js");

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
