import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPPINGS_FILE   = path.resolve(__dirname, "../../mappings.json");
const CACHE_DIR       = path.resolve(__dirname, "../../order-cache");
const ANALYTICS_FILE  = path.resolve(__dirname, "../../analytics.json");

interface AnalyticsRecord {
  orderId:    string;
  title:      string;
  quantity:   number;
  amount:     number | null;
  date:       string;
  recordedAt: string;
}

function loadAnalytics(): AnalyticsRecord[] {
  if (!fs.existsSync(ANALYTICS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf-8")); }
  catch { return []; }
}

function saveAnalytics(records: AnalyticsRecord[]): void {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(records, null, 2));
}

type DeliveryMethod = "file" | "direct" | "chat";
interface MappingEntry {
  serviceId: string;
  columnMap?: Record<string, string>;
  deliveryMethod?: DeliveryMethod;
}

function loadMappings(): Record<string, string | MappingEntry> {
  if (!fs.existsSync(MAPPINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPINGS_FILE, "utf-8"));
}

function saveMappings(data: Record<string, string | MappingEntry>) {
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(data, null, 2));
}

function listCachedOrders(): { orderId: string; bytes: number; mtime: string }[] {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs
    .readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".xlsx"))
    .map((f) => {
      const stat = fs.statSync(path.join(CACHE_DIR, f));
      return { orderId: f.replace(".xlsx", ""), bytes: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const router = Router();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Z2U ↔ Lfollowers Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:2rem}
  h1{font-size:1.6rem;font-weight:700;margin-bottom:.25rem;color:#f8fafc}
  .sub{color:#94a3b8;font-size:.875rem;margin-bottom:2rem}
  .card{background:#1e293b;border:1px solid #334155;border-radius:.75rem;padding:1.5rem;margin-bottom:1.5rem}
  h2{font-size:1rem;font-weight:600;margin-bottom:1rem;color:#cbd5e1}
  label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;margin-top:.75rem}
  input,select{width:100%;padding:.5rem .75rem;background:#0f172a;border:1px solid #334155;border-radius:.375rem;color:#e2e8f0;font-size:.875rem}
  input:focus,select:focus{outline:2px solid #6366f1;border-color:#6366f1}
  button{margin-top:1rem;padding:.5rem 1.25rem;background:#6366f1;color:#fff;border:none;border-radius:.375rem;cursor:pointer;font-size:.875rem;font-weight:500}
  button:hover{background:#4f46e5}
  button.danger{background:#ef4444}
  .badge{background:#6366f1;color:#fff;font-size:.65rem;font-weight:700;border-radius:.25rem;padding:.1rem .35rem;vertical-align:middle;margin-left:.35rem}
  button.pg{margin-top:0;padding:.3rem .75rem;background:#1e293b;border:1px solid #334155;font-size:.8rem;color:#cbd5e1}
  button.pg:hover:not(:disabled){background:#334155}
  button.pg:disabled{opacity:.35;cursor:default}
  button.danger:hover{background:#dc2626}
  button.dl{background:#0369a1;margin-top:0}
  button.dl:hover{background:#0284c7}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;padding:.5rem .75rem;background:#0f172a;color:#94a3b8;font-weight:500;border-bottom:1px solid #334155}
  td{padding:.5rem .75rem;border-bottom:1px solid #1e293b;vertical-align:middle}
  tr:hover td{background:#0f172a}
  .tag{display:inline-block;padding:.15rem .5rem;border-radius:.25rem;font-size:.75rem;background:#312e81;color:#a5b4fc}
  .badge{display:inline-block;padding:.15rem .5rem;border-radius:.25rem;font-size:.75rem;background:#064e3b;color:#6ee7b7}
  #msg{padding:.5rem 1rem;border-radius:.375rem;margin-bottom:1rem;font-size:.875rem;display:none}
  .ok{background:#064e3b;color:#6ee7b7}
  .err{background:#7f1d1d;color:#fca5a5}
</style>
</head>
<body>
<h1>Z2U &harr; Lfollowers Admin</h1>
<p class="sub">Map Z2U Offer Titles to Lfollowers Product IDs for automated order processing.</p>
<div id="msg"></div>

<div class="card">
  <h2>📊 Daily Revenue</h2>
  <div id="analyticsToday" style="display:flex;gap:2.5rem;margin-bottom:1.25rem"></div>
  <table id="analyticsTable">
    <thead><tr><th>Date</th><th>Orders</th><th>Revenue (USD)</th><th>Avg / Order</th></tr></thead>
    <tbody id="analyticsBody"><tr><td colspan="4" style="color:#64748b">Loading...</td></tr></tbody>
  </table>
  <div style="display:flex;align-items:center;justify-content:flex-end;gap:.75rem;margin-top:.75rem">
    <button id="analyticsPrev" class="pg" onclick="_analyticsPage--;renderAnalyticsPage()" disabled>&#8592; Prev</button>
    <span id="analyticsPageInfo" style="font-size:.8rem;color:#94a3b8"></span>
    <button id="analyticsNext" class="pg" onclick="_analyticsPage++;renderAnalyticsPage()" disabled>Next &#8594;</button>
  </div>
</div>

<div class="card">
  <h2>🗂 Order Records <span style="font-size:.75rem;color:#64748b;font-weight:400">(individual — remove cancelled/unfulfilled)</span></h2>
  <table id="recordsTable">
    <thead><tr><th>Order ID</th><th>Title</th><th>Date</th><th>Amount</th><th></th></tr></thead>
    <tbody id="recordsBody"><tr><td colspan="5" style="color:#64748b">Loading...</td></tr></tbody>
  </table>
  <div style="display:flex;align-items:center;justify-content:flex-end;gap:.75rem;margin-top:.75rem">
    <button id="recordsPrev" class="pg" onclick="_recordsPage--;renderRecordsPage()" disabled>&#8592; Prev</button>
    <span id="recordsPageInfo" style="font-size:.8rem;color:#94a3b8"></span>
    <button id="recordsNext" class="pg" onclick="_recordsPage++;renderRecordsPage()" disabled>Next &#8594;</button>
  </div>
</div>

<div class="card">
  <h2>Add / Update Mapping</h2>
  <label>Z2U Offer Title (exact match)</label>
  <input id="title" placeholder="e.g. FIFA 25 PS4 Coins 1M" />
  <label>Lfollowers Product</label>
  <select id="serviceSelect"><option value="">-- loading products... --</option></select>
  <label>Or enter Product ID manually</label>
  <input id="serviceId" placeholder="e.g. 1234" />
  <button onclick="addMapping()">Save Mapping</button>
</div>

<div class="card">
  <h2>Current Mappings</h2>
  <table id="mappingsTable">
    <thead><tr><th>Z2U Title</th><th>Product ID</th><th>Action</th></tr></thead>
    <tbody id="mappingsBody"><tr><td colspan="3" style="color:#64748b">Loading...</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>Processed Orders <span id="orderCount" style="color:#64748b;font-weight:400;font-size:.8rem"></span></h2>
  <p style="color:#64748b;font-size:.8rem;margin-bottom:1rem">Filled XLSX files cached on the server. Each order is processed only once — retries serve the cached file.</p>
  <table>
    <thead><tr><th>Order ID</th><th>Size</th><th>Processed At</th><th>Download</th></tr></thead>
    <tbody id="ordersBody"><tr><td colspan="4" style="color:#64748b">Loading...</td></tr></tbody>
  </table>
  <button class="danger" style="margin-top:1rem" onclick="clearAllOrders()">Clear All Cached Orders</button>
</div>

<script>
function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3500);
}

async function loadServices() {
  try {
    const res = await fetch('/api/admin/services');
    const data = await res.json();
    const sel = document.getElementById('serviceSelect');
    sel.innerHTML = '<option value="">-- select product --</option>';
    if (data.data && Array.isArray(data.data)) {
      data.data.forEach(s => {
        const o = document.createElement('option');
        o.value = s.product_id;
        o.textContent = \`[\${s.product_id}] \${s.name} | Stock: \${s.quantity} | \$\${s.price}\`;
        sel.appendChild(o);
      });
    }
  } catch(e) { console.error(e); }
}

async function loadMappings() {
  const res = await fetch('/api/admin/mappings');
  const data = await res.json();
  const tbody = document.getElementById('mappingsBody');
  const entries = Object.entries(data);
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:#64748b">No mappings yet.</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(([title, conf]) => \`
    <tr>
      <td>\${title}</td>
      <td><span class="tag">\${(typeof conf === "string" ? conf : conf.serviceId) || ""}</span></td>
      <td><button class="danger" onclick="deleteMapping('\${encodeURIComponent(title)}')">Delete</button></td>
    </tr>
  \`).join('');
}

async function loadOrders() {
  try {
    const res = await fetch('/api/admin/cached-orders');
    const data = await res.json();
    const tbody = document.getElementById('ordersBody');
    const count = document.getElementById('orderCount');
    count.textContent = \`(\${data.length} orders)\`;
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#64748b">No processed orders yet.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(o => {
      const kb = (o.bytes / 1024).toFixed(1);
      const dt = new Date(o.mtime).toLocaleString();
      return \`<tr>
        <td><span class="badge">\${o.orderId}</span></td>
        <td>\${kb} KB</td>
        <td>\${dt}</td>
        <td><button class="dl" onclick="downloadOrder('\${o.orderId}')">⬇ Download</button></td>
      </tr>\`;
    }).join('');
  } catch(e) { console.error(e); }
}

async function addMapping() {
  const title = document.getElementById('title').value.trim();
  const selVal = document.getElementById('serviceSelect').value;
  const manualId = document.getElementById('serviceId').value.trim();
  const serviceId = manualId || selVal;
  if (!title || !serviceId) { showMsg('Title and Service ID are required.', false); return; }
  const res = await fetch('/api/admin/mappings', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title, serviceId })
  });
  if (res.ok) { showMsg('Mapping saved!', true); loadMappings(); }
  else { showMsg('Failed to save mapping.', false); }
}

async function deleteMapping(encodedTitle) {
  const title = decodeURIComponent(encodedTitle);
  const res = await fetch('/api/admin/mappings/' + encodeURIComponent(title), { method:'DELETE' });
  if (res.ok) { showMsg('Deleted.', true); loadMappings(); }
  else showMsg('Failed to delete.', false);
}

function downloadOrder(orderId) {
  window.location.href = '/api/admin/cached-orders/' + orderId + '/download';
}

async function clearAllOrders() {
  if (!confirm('Clear all cached orders? The next retry for each order will call the Lfollowers API again.')) return;
  const res = await fetch('/api/order-cache', { method: 'DELETE' });
  if (res.ok) { showMsg('All cached orders cleared.', true); loadOrders(); }
  else showMsg('Failed to clear orders.', false);
}

document.getElementById('serviceSelect').addEventListener('change', function() {
  if (this.value) document.getElementById('serviceId').value = this.value;
});

let _analyticsData = [];
let _analyticsPage  = 0;
const ANALYTICS_PAGE_SIZE = 10;

function renderAnalyticsPage() {
  const tbody   = document.getElementById('analyticsBody');
  const pageInfo = document.getElementById('analyticsPageInfo');
  const btnPrev  = document.getElementById('analyticsPrev');
  const btnNext  = document.getElementById('analyticsNext');
  const data     = _analyticsData;

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:#64748b">No orders recorded yet. Analytics appear automatically when orders are detected.</td></tr>';
    if (pageInfo) pageInfo.textContent = '';
    return;
  }

  const totalPages = Math.ceil(data.length / ANALYTICS_PAGE_SIZE);
  _analyticsPage   = Math.max(0, Math.min(_analyticsPage, totalPages - 1));

  const start      = _analyticsPage * ANALYTICS_PAGE_SIZE;
  const slice      = data.slice(start, start + ANALYTICS_PAGE_SIZE);
  const todayDate  = new Date().toISOString().slice(0, 10);

  tbody.innerHTML = slice.map(d => {
    const avg     = d.orders > 0 ? (d.revenue / d.orders).toFixed(2) : '—';
    const isToday = d.date === todayDate;
    return \`<tr\${isToday ? ' style="background:#1a2744"' : ''}>
      <td>\${d.date}\${isToday ? ' <span class="badge">today</span>' : ''}</td>
      <td>\${d.orders}</td>
      <td style="color:#22c55e;font-weight:600">\$\${d.revenue.toFixed(2)}</td>
      <td style="color:#f59e0b">\$\${avg}</td>
    </tr>\`;
  }).join('');

  if (pageInfo) pageInfo.textContent = \`Page \${_analyticsPage + 1} of \${totalPages}\`;
  if (btnPrev)  btnPrev.disabled  = _analyticsPage === 0;
  if (btnNext)  btnNext.disabled  = _analyticsPage >= totalPages - 1;
}

async function loadAnalytics() {
  try {
    const res  = await fetch('/api/admin/analytics');
    const data = await res.json();

    _analyticsData = data;
    _analyticsPage = 0;

    const todayEl  = document.getElementById('analyticsToday');
    const todayDate = new Date().toISOString().slice(0, 10);
    const todayData = data.find(d => d.date === todayDate);

    if (todayData) {
      todayEl.innerHTML = \`
        <div><div style="font-size:.7rem;color:#94a3b8;letter-spacing:.05em">TODAY'S REVENUE</div>
          <div style="font-size:2rem;font-weight:700;color:#22c55e">\$\${todayData.revenue.toFixed(2)}</div></div>
        <div><div style="font-size:.7rem;color:#94a3b8;letter-spacing:.05em">ORDERS TODAY</div>
          <div style="font-size:2rem;font-weight:700;color:#6366f1">\${todayData.orders}</div></div>
        <div><div style="font-size:.7rem;color:#94a3b8;letter-spacing:.05em">AVG / ORDER</div>
          <div style="font-size:2rem;font-weight:700;color:#f59e0b">\$\${(todayData.revenue / todayData.orders).toFixed(2)}</div></div>
      \`;
    } else {
      todayEl.innerHTML = '<span style="color:#64748b;font-size:.875rem">No orders today yet.</span>';
    }

    renderAnalyticsPage();
  } catch(e) { console.error(e); }
}

let _recordsData = [];
let _recordsPage  = 0;
const RECORDS_PAGE_SIZE = 15;

function renderRecordsPage() {
  const tbody    = document.getElementById('recordsBody');
  const pageInfo = document.getElementById('recordsPageInfo');
  const btnPrev  = document.getElementById('recordsPrev');
  const btnNext  = document.getElementById('recordsNext');
  const data     = _recordsData;
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b">No records yet.</td></tr>';
    if (pageInfo) pageInfo.textContent = '';
    return;
  }
  const totalPages = Math.ceil(data.length / RECORDS_PAGE_SIZE);
  _recordsPage = Math.max(0, Math.min(_recordsPage, totalPages - 1));
  const start  = _recordsPage * RECORDS_PAGE_SIZE;
  const slice  = data.slice(start, start + RECORDS_PAGE_SIZE);
  tbody.innerHTML = slice.map(r => {
    const amt    = typeof r.amount === 'number' ? '\$' + r.amount.toFixed(2) : '—';
    const title  = (r.title || '').slice(0, 48) || '<em style="color:#64748b">unmapped</em>';
    return \`<tr>
      <td style="font-family:monospace;font-size:.8rem">\${r.orderId}</td>
      <td style="font-size:.8rem">\${title}</td>
      <td style="font-size:.8rem">\${r.date}</td>
      <td style="color:#22c55e;font-size:.8rem">\${amt}</td>
      <td><button class="danger" style="padding:.25rem .6rem;font-size:.75rem" onclick="removeRecord('\${r.orderId}')">Remove</button></td>
    </tr>\`;
  }).join('');
  if (pageInfo) pageInfo.textContent = \`Page \${_recordsPage + 1} of \${totalPages}\`;
  if (btnPrev)  btnPrev.disabled  = _recordsPage === 0;
  if (btnNext)  btnNext.disabled  = _recordsPage >= totalPages - 1;
}

async function loadRecords() {
  try {
    const res  = await fetch('/api/admin/analytics/records');
    _recordsData = await res.json();
    _recordsPage = 0;
    renderRecordsPage();
  } catch(e) { console.error(e); }
}

async function removeRecord(orderId) {
  if (!confirm('Remove this order record from analytics? This cannot be undone.')) return;
  const res = await fetch('/api/admin/analytics/' + encodeURIComponent(orderId), { method: 'DELETE' });
  if (res.ok) {
    showMsg('Record removed.', true);
    loadAnalytics();
    loadRecords();
  } else {
    showMsg('Failed to remove record.', false);
  }
}

loadServices();
loadMappings();
loadOrders();
loadAnalytics();
loadRecords();
setInterval(loadAnalytics, 60000);
setInterval(loadRecords, 60000);
</script>
</body>
</html>`;

router.get("/admin", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

router.get("/admin/mappings", (_req, res) => {
  res.json(loadMappings());
});

router.post("/admin/mappings", (req, res) => {
  const { title, serviceId, columnMap, deliveryMethod } = req.body as {
    title: string;
    serviceId: string;
    columnMap?: Record<string, string>;
    deliveryMethod?: DeliveryMethod;
  };
  if (!title || !serviceId) {
    res.status(400).json({ error: "title and serviceId are required" });
    return;
  }
  const mappings = loadMappings();
  mappings[title] = {
    serviceId: String(serviceId),
    columnMap: columnMap && Object.keys(columnMap).length ? columnMap : { email: "A", password: "B" },
    deliveryMethod: deliveryMethod || "file",
  };
  saveMappings(mappings);
  res.json({ ok: true });
});

router.delete("/admin/mappings/:title", (req, res) => {
  const title = decodeURIComponent(req.params.title);
  const mappings = loadMappings();
  delete mappings[title];
  saveMappings(mappings);
  res.json({ ok: true });
});

router.get("/admin/cached-orders", (_req, res) => {
  res.json(listCachedOrders());
});

router.get("/admin/cached-orders/:orderId/download", (req, res) => {
  const safe = req.params.orderId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(CACHE_DIR, `${safe}.xlsx`);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Order not in cache" });
    return;
  }
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Z2U_delivery_temp_${safe}.xlsx"`);
  res.send(fs.readFileSync(filePath));
});

// ── Analytics ─────────────────────────────────────────────────────────────────

router.post("/admin/analytics/record", (req, res) => {
  const { orderId, title, quantity, amount } = req.body as {
    orderId: string; title?: string; quantity?: number; amount?: number | null;
  };
  if (!orderId) { res.status(400).json({ error: "orderId required" }); return; }

  const records = loadAnalytics();
  const exists   = records.some((r) => r.orderId === orderId);
  if (!exists) {
    const now = new Date();
    records.push({
      orderId,
      title:      title      ?? "",
      quantity:   quantity   ?? 0,
      amount:     typeof amount === "number" && amount > 0 ? amount : null,
      date:       now.toISOString().slice(0, 10),
      recordedAt: now.toISOString(),
    });
    saveAnalytics(records);
    console.log(`[analytics] recorded orderId=${orderId} amount=${amount ?? "null"}`);
  }
  res.json({ ok: true, duplicate: exists });
});

router.get("/admin/analytics", (_req, res) => {
  const records = loadAnalytics();
  const byDate: Record<string, { orders: number; revenue: number }> = {};
  for (const r of records) {
    if (!byDate[r.date]) byDate[r.date] = { orders: 0, revenue: 0 };
    byDate[r.date].orders++;
    if (typeof r.amount === "number" && r.amount > 0) byDate[r.date].revenue += r.amount;
  }
  const sorted = Object.entries(byDate)
    .map(([date, d]) => ({ date, ...d, revenue: Math.round(d.revenue * 100) / 100 }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);
  res.json(sorted);
});

router.get("/admin/analytics/records", (_req, res) => {
  const records = loadAnalytics()
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  res.json(records);
});

router.delete("/admin/analytics/:orderId", (req, res) => {
  const { orderId } = req.params;
  const records = loadAnalytics();
  const before  = records.length;
  const updated = records.filter((r) => r.orderId !== orderId);
  if (updated.length === before) {
    res.status(404).json({ error: "Record not found" });
    return;
  }
  saveAnalytics(updated);
  res.json({ ok: true, removed: before - updated.length });
});

// ── Pending chat-reply queue ──────────────────────────────────────────────────
// The extension polls GET /api/admin/pending-chat-replies every 5 s.
// The admin (or any Telegram-triggered webhook) pushes replies here.
// This gives a VPS-side queue so replies survive bridge.py restarts.
interface PendingReply {
  username: string;
  message:  string;
  orderId:  string;
  queuedAt: string;
}
const pendingChatReplies: PendingReply[] = [];

router.post("/admin/queue-chat-reply", (req, res) => {
  const { username, message, orderId = "" } = req.body as {
    username: string; message: string; orderId?: string;
  };
  if (!username || !message) {
    res.status(400).json({ error: "username and message are required" });
    return;
  }
  pendingChatReplies.push({ username, message, orderId, queuedAt: new Date().toISOString() });
  console.log(`[chat-queue] Queued reply for "${username}": "${message.slice(0, 60)}"`);
  res.json({ ok: true, queued: pendingChatReplies.length });
});

router.get("/admin/pending-chat-replies", (_req, res) => {
  const replies = pendingChatReplies.splice(0); // drain and return
  res.json(replies);
});

// ── VPS proxy upload ──────────────────────────────────────────────────────────
// The extension cannot use CDP (Z2U detects the debugger banner) and Z2U's
// browser-side checks block extension uploads. This endpoint runs on the VPS
// (outside the browser entirely), uses the user's real session cookies to POST
// multipart/form-data directly to Z2U's upload API. No browser-side checks apply.
router.post("/admin/proxy-upload", async (req, res) => {
  const { fileBytes, orderId, cookies, note, pageUrl } = req.body as {
    fileBytes: number[];
    orderId: string;
    cookies: { name: string; value: string; domain?: string }[];
    note?: string;
    pageUrl?: string;
  };

  if (!fileBytes?.length || !orderId || !cookies?.length) {
    res.status(400).json({ ok: false, error: "Missing fileBytes, orderId, or cookies" });
    return;
  }

  // Reconstruct the XLSX file buffer
  const buf = Buffer.from(fileBytes);
  const noteValue = note || "Delivered";

  // Build Cookie header from all Z2U cookies
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // Extract CSRF/XSRF token from cookies
  const xsrfCookie = cookies.find((c) => /^XSRF-TOKEN$/i.test(c.name));
  const xsrfToken  = xsrfCookie ? decodeURIComponent(xsrfCookie.value) : "";

  const referer = pageUrl || `https://www.z2u.com/sellOrder?order_id=${orderId}`;

  const Z2U_ENDPOINTS = [
    "https://www.z2u.com/sellOrder/uploadSellForm",
    "https://www.z2u.com/SellOrder/uploadSellForm",
    "https://www.z2u.com/sellOrder/uploadDelivery",
    "https://www.z2u.com/sellOrder/deliveryUpload",
    "https://www.z2u.com/sellOrder/uploadFile",
    "https://www.z2u.com/api/sellOrder/uploadSellForm",
    "https://www.z2u.com/api/sellOrder/uploadDelivery",
  ];
  const FILE_FIELDS = ["upfile", "file", "upload", "excel", "formFile"];

  const results: { url: string; field: string; status: number; body: string }[] = [];

  for (const url of Z2U_ENDPOINTS) {
    for (const fieldName of FILE_FIELDS) {
      try {
        // Use Node.js native FormData (Node 18+) with Blob
        const formData = new FormData();
        formData.append("order_id", orderId);
        formData.append("note", noteValue);
        formData.append(fieldName, new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }), `Z2U_delivery_${orderId}.xlsx`);

        const headers: Record<string, string> = {
          "Cookie": cookieHeader,
          "Referer": referer,
          "Origin": "https://www.z2u.com",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        };
        if (xsrfToken) {
          headers["X-XSRF-TOKEN"] = xsrfToken;
          headers["X-CSRF-TOKEN"]  = xsrfToken;
        }

        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: formData,
        });

        const text = await resp.text();
        results.push({ url, field: fieldName, status: resp.status, body: text.slice(0, 400) });
        console.log(`[proxy-upload] ${resp.status} ${url} field=${fieldName} → ${text.slice(0, 200)}`);

        // Parse success
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        if (json) {
          const code = json.code ?? json.status ?? json.errCode;
          const isOk = code === 0 || code === 200 || code === "0" || code === "200" || code === true || code === 1;
          if (isOk && json.data != null && json.data !== "" && json.data !== false) {
            res.json({ ok: true, url, field: fieldName, response: text.slice(0, 400), results });
            return;
          }
          // If server says file/field error, try next field; if auth error stop endpoint
          const msg = (json.msg || json.message || "").toLowerCase();
          if (/unauthori|forbidden|login|session/i.test(msg)) break; // skip other fields for this url
        } else if (resp.ok && !text.toLowerCase().includes("<html") && !text.toLowerCase().includes("error")) {
          res.json({ ok: true, url, field: fieldName, response: text.slice(0, 400), results });
          return;
        }
      } catch (e: any) {
        results.push({ url, field: fieldName, status: 0, body: e.message });
        console.error(`[proxy-upload] Error ${url} field=${fieldName}:`, e.message);
      }
    }
  }

  res.json({ ok: false, error: "All endpoints failed", results });
});

export default router;
