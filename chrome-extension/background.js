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

  chrome.tabs.query({ url: "https://z2u.com/sellOrder/index*" }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.reload(tabs[0].id, () => {
        console.log("[Z2U] Refreshed sell order tab.");
      });
    } else {
      chrome.tabs.create({ url: CONFIG.Z2U_ORDERS_URL, active: false });
    }
  });

  scheduleNextRefresh();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
});

async function fetchMappings() {
  const url = `${CONFIG.SERVER_URL}/api/admin/mappings`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch mappings: ${res.status}`);
  return await res.json();
}

async function handleOrderProcessing(orderData) {
  const { orderId, title, quantity, templateBlob } = orderData;

  const { processed } = await chrome.storage.local.get("processed");
  const processedSet = new Set(processed || []);

  if (processedSet.has(orderId)) {
    console.log(`[Z2U] Order ${orderId} already processed, skipping.`);
    return { skipped: true };
  }

  console.log(`[Z2U] Sending order ${orderId} to backend for processing.`);

  const formData = new FormData();
  formData.append("file", new Blob([templateBlob], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "template.xlsx");
  formData.append("title", title);
  formData.append("quantity", String(quantity));
  formData.append("orderId", orderId);

  const res = await fetch(`${CONFIG.SERVER_URL}/api/process-order`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend error: ${res.status} — ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();

  processedSet.add(orderId);
  await chrome.storage.local.set({ processed: Array.from(processedSet) });

  return { filledFile: Array.from(new Uint8Array(arrayBuffer)) };
}
