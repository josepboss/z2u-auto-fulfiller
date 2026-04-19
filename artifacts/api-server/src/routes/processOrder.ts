import { Router } from "express";
import multer from "multer";
import { createRequire } from "module";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const require = createRequire(import.meta.url);
const XlsxPopulate = require("xlsx-populate");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPPINGS_FILE   = path.resolve(__dirname, "../../mappings.json");
const LFOLLOWERS_API_URL = "https://lfollowers.com/api/v2";

// ── Order cache ──────────────────────────────────────────────────────────────
// Two files per order:
//   <orderId>.json  — raw account lines from Lfollowers (source of truth)
//   <orderId>.xlsx  — filled XLSX ready for upload (derived from .json + template)
//
// This means the Lfollowers API is called AT MOST ONCE per order.
// Deleting the XLSX just causes it to be rebuilt from the saved accounts data —
// no new purchase is triggered.
const CACHE_DIR = path.resolve(__dirname, "../../order-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function safeName(orderId: string): string {
  return orderId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function xlsxPath(orderId: string)    { return path.join(CACHE_DIR, `${safeName(orderId)}.xlsx`); }
function accountsPath(orderId: string){ return path.join(CACHE_DIR, `${safeName(orderId)}.json`); }

function loadCachedAccounts(orderId: string): string[] | null {
  const p = accountsPath(orderId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function saveCachedAccounts(orderId: string, lines: string[]): void {
  fs.writeFileSync(accountsPath(orderId), JSON.stringify(lines, null, 2));
  logger.info({ orderId, count: lines.length }, "Account data saved to cache");
}

function loadCachedXlsx(orderId: string): Buffer | null {
  const p = xlsxPath(orderId);
  if (!fs.existsSync(p)) return null;
  logger.info({ orderId }, "XLSX cache HIT");
  return fs.readFileSync(p);
}

function saveCachedXlsx(orderId: string, buf: Buffer): void {
  fs.writeFileSync(xlsxPath(orderId), buf);
  logger.info({ orderId, bytes: buf.length }, "XLSX cache SAVED");
}

// ── Fill template with accounts using xlsx-populate ─────────────────────────
// xlsx-populate patches ONLY the exact cells written to; everything else in the
// file (styles, merges, protection, formatting) stays byte-for-byte identical.
async function fillTemplate(templateBuffer: Buffer, accountLines: string[], qty: number): Promise<Buffer> {
  const workbook = await XlsxPopulate.fromDataAsync(templateBuffer);
  const sheet = workbook.sheet(0);

  // Find the first empty row after all header rows.
  // Z2U template: row1=info, row2=empty, row3=column labels → data from row 4.
  let startRow = 4;
  for (let r = 1; r <= 20; r++) {
    const a = sheet.cell(`A${r}`).value();
    const b = sheet.cell(`B${r}`).value();
    const hasContent = (a !== null && a !== undefined && a !== "") ||
                       (b !== null && b !== undefined && b !== "");
    if (hasContent) startRow = r + 1;
  }
  logger.info({ startRow, qty }, "Filling XLSX from row");

  for (let i = 0; i < qty; i++) {
    const line = accountLines[i] ?? `placeholder_${i + 1}`;
    const [email, password] = line.split("|");
    sheet.cell(`A${startRow + i}`).value(email ?? line);
    sheet.cell(`B${startRow + i}`).value(password ?? "");
  }

  return workbook.outputAsync();
}

function loadMappings(): Record<string, string> {
  if (!fs.existsSync(MAPPINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPINGS_FILE, "utf-8"));
}

function getApiKey(): string {
  const key = process.env.LFOLLOWERS_API_KEY;
  if (!key) throw new Error("LFOLLOWERS_API_KEY is not set");
  return key;
}

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

router.post("/process-order", upload.single("file"), async (req, res) => {
  try {
    const { title, quantity, orderId } = req.body as {
      title: string;
      quantity: string;
      orderId?: string;
    };

    if (!title || !quantity) {
      res.status(400).json({ error: "title and quantity are required" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    if (!orderId) {
      res.status(400).json({ error: "orderId is required" });
      return;
    }

    const qty = parseInt(quantity, 10);
    const sendXlsx = (buf: Buffer) => {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="order_${orderId}_filled.xlsx"`);
      res.send(buf);
    };

    // ── 1. XLSX already cached → return immediately, zero cost ───────────────
    const cachedXlsx = loadCachedXlsx(orderId);
    if (cachedXlsx) {
      sendXlsx(cachedXlsx);
      return;
    }

    // ── 2. Accounts already purchased, XLSX just needs rebuilding ─────────────
    // (happens when the XLSX was deleted to fix formatting, but accounts are saved)
    const cachedAccounts = loadCachedAccounts(orderId);
    if (cachedAccounts) {
      logger.info({ orderId }, "Rebuilding XLSX from cached accounts — no API call");
      const buf = await fillTemplate(req.file.buffer, cachedAccounts, qty);
      saveCachedXlsx(orderId, buf);
      sendXlsx(buf);
      return;
    }

    // ── 3. First time — call Lfollowers API ──────────────────────────────────
    const mappings = loadMappings();
    const productId = mappings[title];
    if (!productId) {
      res.status(404).json({ error: `No mapping found for title: "${title}"` });
      return;
    }

    logger.info({ title, productId, quantity: qty, orderId }, "Purchasing from Lfollowers");

    const lfResponse = await axios.post(LFOLLOWERS_API_URL, {
      key: getApiKey(),
      action: "purchase",
      product_id: productId,
      quantity: qty,
    });

    const purchaseResult = lfResponse.data as {
      delivered_data?: string;
      error?: string;
    };

    if (purchaseResult.error) {
      logger.error({ error: purchaseResult.error }, "Lfollowers purchase error");
      res.status(502).json({ error: `Lfollowers error: ${purchaseResult.error}` });
      return;
    }

    const accountLines = (purchaseResult.delivered_data ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Save accounts FIRST — if anything else fails, data is never lost
    saveCachedAccounts(orderId, accountLines);

    const buf = await fillTemplate(req.file.buffer, accountLines, qty);
    saveCachedXlsx(orderId, buf);
    sendXlsx(buf);

  } catch (err) {
    logger.error({ err }, "process-order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Cache management endpoints ────────────────────────────────────────────────

router.get("/order-cache", (_req, res) => {
  if (!fs.existsSync(CACHE_DIR)) { res.json([]); return; }
  const orders = new Map<string, { orderId: string; xlsxBytes?: number; accounts?: number; mtime: string }>();
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const base = f.replace(/\.(xlsx|json)$/, "");
    if (!orders.has(base)) orders.set(base, { orderId: base, mtime: "" });
    const entry = orders.get(base)!;
    const stat = fs.statSync(path.join(CACHE_DIR, f));
    if (f.endsWith(".xlsx")) entry.xlsxBytes = stat.size;
    if (f.endsWith(".json")) {
      const lines = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8")) as string[];
      entry.accounts = lines.length;
    }
    if (!entry.mtime || stat.mtime.toISOString() > entry.mtime) entry.mtime = stat.mtime.toISOString();
  }
  res.json([...orders.values()].sort((a, b) => b.mtime.localeCompare(a.mtime)));
});

// Delete XLSX only — accounts data is kept so XLSX can be rebuilt without a new purchase
router.delete("/order-cache/:orderId/xlsx", (req, res) => {
  const p = xlsxPath(req.params.orderId);
  if (fs.existsSync(p)) { fs.unlinkSync(p); res.json({ ok: true, message: "XLSX deleted — accounts data kept, will rebuild on next request" }); }
  else res.status(404).json({ error: "XLSX not in cache" });
});

// Delete everything for an order — NEXT REQUEST WILL CALL THE API AGAIN
router.delete("/order-cache/:orderId", (req, res) => {
  const x = xlsxPath(req.params.orderId);
  const a = accountsPath(req.params.orderId);
  const deleted: string[] = [];
  if (fs.existsSync(x)) { fs.unlinkSync(x); deleted.push("xlsx"); }
  if (fs.existsSync(a)) { fs.unlinkSync(a); deleted.push("accounts"); }
  if (deleted.length) res.json({ ok: true, deleted });
  else res.status(404).json({ error: "Not in cache" });
});

// Delete all XLSX files only — accounts data preserved across the board
router.delete("/order-cache", (req, res) => {
  const xlsxOnly = req.query.xlsxOnly === "true";
  if (!fs.existsSync(CACHE_DIR)) { res.json({ ok: true, message: "Nothing to clear" }); return; }
  const files = fs.readdirSync(CACHE_DIR);
  const toDelete = xlsxOnly ? files.filter((f) => f.endsWith(".xlsx")) : files;
  toDelete.forEach((f) => fs.unlinkSync(path.join(CACHE_DIR, f)));
  res.json({ ok: true, message: `Cleared ${toDelete.length} file(s)` });
});

export default router;
