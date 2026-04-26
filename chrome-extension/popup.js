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
  const tabs = resp.tabCount || 1;
  captureMsg.textContent = `Listening on ${tabs} tab(s)… do your upload now.`;
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
  await chrome.storage.local.remove(["processed", "preparedOnly", "pendingOrderId", "pendingTitle", "prepareOnly"]);
  const el = document.getElementById("clearMsg");
  el.textContent = "History cleared — orders can be reprocessed.";
  setTimeout(() => (el.textContent = ""), 3000);
});

async function refreshEndpointUI() {
  const box = document.getElementById("endpointBox");
  const { z2uUploadEndpoint: ep } = await chrome.storage.local.get("z2uUploadEndpoint");
  if (ep?.url) {
    const fileField = ep.fields?.find((f) => f.type === "file")?.key;
    const probe = ep.probeFields;
    const fieldInfo = probe
      ? "🔍 probing upfile/file/upload…"
      : fileField
        ? `file field: "${fileField}"`
        : "field: unknown";
    box.innerHTML = `Upload endpoint: ✅ captured<br><span style="color:#94a3b8;font-size:.7rem;">${ep.url.slice(0,55)}…<br>${fieldInfo}</span>`;
    box.style.color = "#6ee7b7";
    document.getElementById("uploadUrl").value = ep.url;
    if (fileField && !probe) {
      document.getElementById("fileField").value = fileField;
    }
  } else {
    box.textContent = "Upload endpoint: ⏳ not yet — do one manual upload";
    box.style.color = "#fcd34d";
  }
}

// ── Telegram settings ────────────────────────────────────────────────────────
document.getElementById("tgSaveBtn").addEventListener("click", async () => {
  const token  = document.getElementById("tgToken").value.trim();
  const chatId = document.getElementById("tgChatId").value.trim();
  if (!token || !chatId) {
    document.getElementById("tgMsg").textContent = "Both fields required.";
    document.getElementById("tgMsg").style.color = "#fca5a5";
    return;
  }
  await chrome.storage.local.set({ tgToken: token, tgChatId: chatId });
  document.getElementById("tgMsg").textContent = "Saved!";
  document.getElementById("tgMsg").style.color = "#6ee7b7";
  setTimeout(() => (document.getElementById("tgMsg").textContent = ""), 2000);
  await verifyTgBot(token, chatId);
});

document.getElementById("tgTestBtn").addEventListener("click", async () => {
  const testEl = document.getElementById("tgTestMsg");
  const token  = document.getElementById("tgToken").value.trim();
  const chatId = document.getElementById("tgChatId").value.trim();
  if (!token || !chatId) {
    testEl.textContent = "Save Bot Token + Chat ID first.";
    testEl.style.color = "#fca5a5";
    return;
  }
  testEl.textContent = "Sending…";
  testEl.style.color = "#c4b5fd";
  try {
    const text =
      `💬 <b>Z2U Chat</b>\n` +
      `👤 <b>TestUser</b>:\n` +
      `This is a test message from your extension.\n\n` +
      `<i>↩ Reply to this message to test the reply pipeline</i>`;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const d = await r.json();
    if (d.ok) {
      // Store the mapping so the reply pipeline can be tested too
      const stored = await chrome.storage.local.get(["tgMsgMap"]);
      const map = stored.tgMsgMap || {};
      map[String(d.result.message_id)] = "TestUser";
      await chrome.storage.local.set({ tgMsgMap: map });
      testEl.textContent = `✅ Sent! (msg_id=${d.result.message_id}) — reply to it in Telegram to test replies.`;
      testEl.style.color = "#6ee7b7";
    } else {
      testEl.textContent = `❌ ${d.description}`;
      testEl.style.color = "#fca5a5";
    }
  } catch (e) {
    testEl.textContent = `❌ ${e.message}`;
    testEl.style.color = "#fca5a5";
  }
});

async function verifyTgBot(token, chatId) {
  const statusEl = document.getElementById("tgStatus");
  statusEl.textContent = "Verifying bot…";
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = await r.json();
    if (d.ok) {
      statusEl.textContent = `✅ Bot: @${d.result.username}`;
      statusEl.style.color = "#6ee7b7";
    } else {
      statusEl.textContent = `❌ ${d.description}`;
      statusEl.style.color = "#fca5a5";
    }
  } catch {
    statusEl.textContent = "❌ Could not reach Telegram";
    statusEl.style.color = "#fca5a5";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["serverUrl", "z2uUploadEndpoint", "z2uFileField", "tgToken", "tgChatId"]);

  const url = data.serverUrl || "https://z2.itspanel.com";
  document.getElementById("serverUrl").value = url;
  document.getElementById("adminLink").href = `${url}/api/admin`;
  updateStatus(url);
  refreshPauseUI();
  refreshEndpointUI();

  // Restore Telegram fields
  if (data.tgToken)  document.getElementById("tgToken").value  = data.tgToken;
  if (data.tgChatId) document.getElementById("tgChatId").value = data.tgChatId;
  if (data.tgToken && data.tgChatId) verifyTgBot(data.tgToken, data.tgChatId);

  document.getElementById("fileField").value = data.z2uFileField || "upfile";
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const url       = document.getElementById("serverUrl").value.trim();
  const uploadUrl = document.getElementById("uploadUrl").value.trim();
  const fileField = document.getElementById("fileField").value.trim() || "file";

  const toSave = { serverUrl: url || "https://z2.itspanel.com", z2uFileField: fileField };

  if (uploadUrl) {
    toSave.z2uUploadEndpoint = {
      url:         uploadUrl,
      method:      "POST",
      fields:      [{ key: fileField, type: "file" }],
      probeFields: false,  // user specified the field name explicitly
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
