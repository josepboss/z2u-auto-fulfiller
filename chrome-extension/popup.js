// ── Debugger Capture Mode ────────────────────────────────────────────────────
const captureBtn = document.getElementById("captureBtn");
const captureMsg = document.getElementById("captureMsg");
let capturing = false;

captureBtn.addEventListener("click", async () => {
  if (capturing) {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    setCaptureIdle();
    return;
  }
  captureBtn.disabled = true;
  captureMsg.textContent = "Connecting…";
  const resp = await chrome.runtime.sendMessage({ type: "START_CAPTURE" });
  captureBtn.disabled = false;
  if (!resp.ok) {
    captureMsg.style.color = "#fca5a5";
    captureMsg.textContent = "Error: " + resp.error;
    return;
  }
  capturing = true;
  captureBtn.textContent = "⏹ Stop Capture Mode";
  captureBtn.style.background = "#dc2626";
  captureMsg.style.color = "#7dd3fc";
  captureMsg.textContent = "Listening… do your manual upload on Z2U now.";
});

// Listen for capture results from the background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CAPTURE_COMPLETE") {
    setCaptureIdle();
    captureMsg.style.color = "#6ee7b7";
    captureMsg.textContent = "✅ Endpoint captured! Auto-processing will use it now.";
    refreshEndpointUI();
  }
  if (msg.type === "CAPTURE_STOPPED") {
    setCaptureIdle();
  }
});

function setCaptureIdle() {
  capturing = false;
  captureBtn.textContent = "🎯 Start Capture Mode";
  captureBtn.style.background = "#0ea5e9";
  if (!captureMsg.textContent.includes("✅")) {
    captureMsg.textContent = "";
  }
}

// ── Pause toggle ────────────────────────────────────────────────────────────
const pauseBtn = document.getElementById("pauseBtn");
const pauseMsg = document.getElementById("pauseMsg");

async function refreshPauseUI() {
  const { autoPaused } = await chrome.storage.local.get("autoPaused");
  if (autoPaused) {
    pauseBtn.textContent = "▶ Resume Auto-Processing";
    pauseBtn.style.background = "#22c55e";
    pauseMsg.textContent = "Paused — capture still active. Do your manual upload now.";
  } else {
    pauseBtn.textContent = "⏸ Pause Auto-Processing";
    pauseBtn.style.background = "#f59e0b";
    pauseMsg.textContent = "";
  }
}

pauseBtn.addEventListener("click", async () => {
  const { autoPaused } = await chrome.storage.local.get("autoPaused");
  await chrome.storage.local.set({ autoPaused: !autoPaused });
  await refreshPauseUI();
});

document.getElementById("resetEndpointBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove("z2uUploadEndpoint");
  document.getElementById("uploadUrl").value = "";
  // Tell background to reset its flag and badge
  chrome.runtime.sendMessage({ type: "RESET_ENDPOINT" });
  await refreshEndpointUI();
});

// ── Clear history ────────────────────────────────────────────────────────────
document.getElementById("clearBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(["processed", "pendingOrderId", "pendingTitle"]);
  const el = document.getElementById("clearMsg");
  el.textContent = "History cleared — orders can be reprocessed.";
  setTimeout(() => (el.textContent = ""), 3000);
});

async function refreshEndpointUI() {
  const box = document.getElementById("endpointBox");
  const { z2uUploadEndpoint } = await chrome.storage.local.get("z2uUploadEndpoint");
  if (z2uUploadEndpoint?.url) {
    box.textContent = `Upload endpoint: ✅ captured`;
    box.style.color = "#6ee7b7";
    document.getElementById("uploadUrl").value = z2uUploadEndpoint.url;
  } else {
    box.textContent = "Upload endpoint: ⏳ not yet — do one manual upload";
    box.style.color = "#fcd34d";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["serverUrl", "z2uUploadEndpoint", "z2uFileField"]);

  const url = data.serverUrl || "http://localhost:3000";
  document.getElementById("serverUrl").value = url;
  document.getElementById("adminLink").href = `${url}/api/admin`;
  updateStatus(url);
  refreshPauseUI();
  refreshEndpointUI();

  document.getElementById("fileField").value = data.z2uFileField || "file";
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const url       = document.getElementById("serverUrl").value.trim();
  const uploadUrl = document.getElementById("uploadUrl").value.trim();
  const fileField = document.getElementById("fileField").value.trim() || "file";

  const toSave = { serverUrl: url || "http://localhost:3000", z2uFileField: fileField };

  if (uploadUrl) {
    // Build a minimal endpoint object — directApiUpload fills in orderId at runtime
    toSave.z2uUploadEndpoint = {
      url:    uploadUrl,
      method: "POST",
      fields: [
        { key: fileField, type: "file" },
      ],
      // Flag so directApiUpload knows to also inject the orderId field
      manualConfig: true,
    };
  }

  await chrome.storage.local.set(toSave);
  if (url) {
    document.getElementById("adminLink").href = `${url}/api/admin`;
    updateStatus(url);
  }
  document.getElementById("msg").textContent = "Saved!";
  setTimeout(() => (document.getElementById("msg").textContent = ""), 2000);
  refreshEndpointUI();
});

async function updateStatus(url) {
  const box = document.getElementById("statusBox");
  box.textContent = "Checking backend...";
  try {
    const res = await fetch(`${url}/api/healthz`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      box.textContent = "Backend: Connected";
      box.style.color = "#6ee7b7";
    } else {
      box.textContent = `Backend: HTTP ${res.status}`;
      box.style.color = "#fca5a5";
    }
  } catch {
    box.textContent = "Backend: Unreachable";
    box.style.color = "#fca5a5";
  }
}
