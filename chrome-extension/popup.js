document.addEventListener("DOMContentLoaded", async () => {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  const url = serverUrl || "http://localhost:3000";
  document.getElementById("serverUrl").value = url;
  document.getElementById("adminLink").href = `${url}/api/admin`;
  updateStatus(url);
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
