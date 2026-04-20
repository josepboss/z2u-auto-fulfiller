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
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  const url = serverUrl || "http://localhost:3000";
  document.getElementById("serverUrl").value = url;
  document.getElementById("adminLink").href = `${url}/api/admin`;
  updateStatus(url);
  refreshPauseUI();
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const url = document.getElementById("serverUrl").value.trim();
  if (!url) return;
  await chrome.storage.local.set({ serverUrl: url });
  document.getElementById("adminLink").href = `${url}/api/admin`;
  document.getElementById("msg").textContent = "Saved!";
  setTimeout(() => (document.getElementById("msg").textContent = ""), 2000);
  updateStatus(url);
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
