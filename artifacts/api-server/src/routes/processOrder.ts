import { Router } from "express";
import multer from "multer";
import { createRequire } from "module";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

// xlsx-populate is a CommonJS module — preserves 100% of the original XLSX
// format/styles/protection and only patches the exact cells written to.
const require = createRequire(import.meta.url);
const XlsxPopulate = require("xlsx-populate");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPPINGS_FILE = path.resolve(__dirname, "../../mappings.json");
const LFOLLOWERS_API_URL = "https://lfollowers.com/api/v2";

// ── Order cache ─────────────────────────────────────────────────────────────
const CACHE_DIR = path.resolve(__dirname, "../../order-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheFilePath(orderId: string): string {
  const safe = orderId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CACHE_DIR, `${safe}.xlsx`);
}

function getCachedFile(orderId: string): Buffer | null {
  const p = cacheFilePath(orderId);
  if (fs.existsSync(p)) {
    logger.info({ orderId }, "Order cache HIT — returning cached file (no API call)");
    return fs.readFileSync(p);
  }
  return null;
}

function saveCachedFile(orderId: string, buf: Buffer): void {
  fs.writeFileSync(cacheFilePath(orderId), buf);
  logger.info({ orderId, bytes: buf.length }, "Order cache SAVED");
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

    // ── Cache check ──────────────────────────────────────────────────────────
    const cached = getCachedFile(orderId);
    if (cached) {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="order_${orderId}_filled.xlsx"`);
      res.send(cached);
      return;
    }

    // ── Call Lfollowers API ──────────────────────────────────────────────────
    const mappings = loadMappings();
    const productId = mappings[title];
    if (!productId) {
      res.status(404).json({ error: `No mapping found for title: "${title}"` });
      return;
    }

    const qty = parseInt(quantity, 10);
    logger.info({ title, productId, quantity: qty, orderId }, "Purchasing from Lfollowers");

    const key = getApiKey();
    const lfResponse = await axios.post(LFOLLOWERS_API_URL, {
      key,
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

    // ── Fill XLSX using xlsx-populate ────────────────────────────────────────
    // xlsx-populate patches ONLY the cells you set — every other cell, style,
    // merge, protection, formula stays byte-for-byte identical to the template.
    const workbook = await XlsxPopulate.fromDataAsync(req.file.buffer);
    const sheet = workbook.sheet(0);

    // Always write data starting from row 4 (Z2U template: row 3 = headers, row 4 = first data row)
    const startRow = 4;
    logger.info({ startRow }, "Writing account data from this row");

    for (let i = 0; i < qty; i++) {
      const line = accountLines[i] ?? `placeholder_${i + 1}`;
      const [email, password] = line.split("|");
      sheet.cell(`A${startRow + i}`).value(email ?? line);
      sheet.cell(`B${startRow + i}`).value(password ?? "");
    }

    const outputBuffer: Buffer = await workbook.outputAsync();

    saveCachedFile(orderId, outputBuffer);

    // Use the original template filename so the filled file keeps the same name
    const outputFilename = req.file.originalname || `${orderId}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${outputFilename}"`);
    res.send(outputBuffer);

  } catch (err) {
    logger.error({ err }, "process-order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Cache management ─────────────────────────────────────────────────────────

router.get("/order-cache", (_req, res) => {
  const files = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
  res.json({ count: files.length, orders: files.map((f) => f.replace(".xlsx", "")) });
});

router.delete("/order-cache/:orderId", (req, res) => {
  const p = cacheFilePath(req.params.orderId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    res.json({ ok: true, message: `Cache cleared for ${req.params.orderId}` });
  } else {
    res.status(404).json({ error: "Not in cache" });
  }
});

router.delete("/order-cache", (_req, res) => {
  const files = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
  files.forEach((f) => fs.unlinkSync(path.join(CACHE_DIR, f)));
  res.json({ ok: true, message: `Cleared ${files.length} cached orders` });
});

export default router;
