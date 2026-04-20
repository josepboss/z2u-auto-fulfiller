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

// ── Clear history ────────────────────────────────────────────────────────────
document.getElementById("clearBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(["processed", "pendingOrderId", "pendingTitle"]);
  const el = document.getElementById("clearMsg");
  el.textContent = "History cleared — orders can be reprocessed.";
  setTimeout(() => (el.textContent = ""), 3000);
});

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["serverUrl", "z2uUploadEndpoint", "z2uFileField"]);

  const url = data.serverUrl || "http://localhost:3000";
  document.getElementById("serverUrl").value = url;
  document.getElementById("adminLink").href = `${url}/api/admin`;
  updateStatus(url);
  refreshPauseUI();

  if (data.z2uUploadEndpoint?.url) {
    document.getElementById("uploadUrl").value = data.z2uUploadEndpoint.url;
  }
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
