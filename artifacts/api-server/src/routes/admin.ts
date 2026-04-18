import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPPINGS_FILE = path.resolve(__dirname, "../../mappings.json");

function loadMappings(): Record<string, string> {
  if (!fs.existsSync(MAPPINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPINGS_FILE, "utf-8"));
}

function saveMappings(data: Record<string, string>) {
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(data, null, 2));
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
  button.danger:hover{background:#dc2626}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;padding:.5rem .75rem;background:#0f172a;color:#94a3b8;font-weight:500;border-bottom:1px solid #334155}
  td{padding:.5rem .75rem;border-bottom:1px solid #1e293b;vertical-align:middle}
  tr:hover td{background:#0f172a}
  .tag{display:inline-block;padding:.15rem .5rem;border-radius:.25rem;font-size:.75rem;background:#312e81;color:#a5b4fc}
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
        o.textContent = \`[\${s.product_id}] \${s.name} | Stock: \${s.quantity} | $\${s.price}\`;
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
  tbody.innerHTML = entries.map(([title, id]) => \`
    <tr>
      <td>\${title}</td>
      <td><span class="tag">\${id}</span></td>
      <td><button class="danger" onclick="deleteMapping('\${encodeURIComponent(title)}')">Delete</button></td>
    </tr>
  \`).join('');
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

document.getElementById('serviceSelect').addEventListener('change', function() {
  if (this.value) document.getElementById('serviceId').value = this.value;
});

loadServices();
loadMappings();
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
  const { title, serviceId } = req.body as { title: string; serviceId: string };
  if (!title || !serviceId) {
    res.status(400).json({ error: "title and serviceId are required" });
    return;
  }
  const mappings = loadMappings();
  mappings[title] = String(serviceId);
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

export default router;
