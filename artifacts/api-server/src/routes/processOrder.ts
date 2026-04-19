import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPPINGS_FILE = path.resolve(__dirname, "../../mappings.json");
const LFOLLOWERS_API_URL = "https://lfollowers.com/api/v2";

// ── Order cache — filled XLSX files stored by orderId ─────────────────────────
// Prevents calling the Lfollowers API more than once per order (each call costs money).
const CACHE_DIR = path.resolve(__dirname, "../../order-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cacheFilePath(orderId: string): string {
  // Sanitise orderId to safe filename characters
  const safe = orderId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CACHE_DIR, `${safe}.xlsx`);
}

function getCachedFile(orderId: string): Buffer | null {
  const p = cacheFilePath(orderId);
  if (fs.existsSync(p)) {
    logger.info({ orderId }, "Order cache HIT — returning cached filled file (no API call)");
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

    // ── Cache check — if we already processed this order, return cached file ──
    const cached = getCachedFile(orderId);
    if (cached) {
      const fileName = `order_${orderId}_filled.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(cached);
      return;
    }

    // ── New order — call Lfollowers API ───────────────────────────────────────
    const mappings = loadMappings();
    const productId = mappings[title];

    if (!productId) {
      res.status(404).json({ error: `No mapping found for title: "${title}"` });
      return;
    }

    const qty = parseInt(quantity, 10);

    logger.info({ title, productId, quantity: qty, orderId }, "Purchasing accounts from Lfollowers");

    const key = getApiKey();
    const lfResponse = await axios.post(LFOLLOWERS_API_URL, {
      key,
      action: "purchase",
      product_id: productId,
      quantity: qty,
    });

    const purchaseResult = lfResponse.data as {
      order_id?: string;
      product_id?: string;
      quantity?: number;
      charge?: string;
      delivered_data?: string;
      error?: string;
    };

    if (purchaseResult.error) {
      logger.error({ error: purchaseResult.error }, "Lfollowers purchase error");
      res.status(502).json({ error: `Lfollowers error: ${purchaseResult.error}` });
      return;
    }

    const deliveredData = purchaseResult.delivered_data ?? "";
    const accountLines = deliveredData
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    // ── Fill the XLSX template ─────────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — ExcelJS types mismatch with Node 24 Buffer but works at runtime
    await workbook.xlsx.load(req.file.buffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      res.status(400).json({ error: "Excel file has no worksheet" });
      return;
    }

    // Z2U templates have 3 header rows:
    //   Row 1: E-Mail | Accounts | OrderID | (warning text)
    //   Row 2: (empty)
    //   Row 3: *Login Account | *Login Password | (column labels)
    //   Row 4+: data goes here
    // Scan rows 1–20 to find the last non-empty row in columns A or B,
    // then start data one row below that so headers are never overwritten.
    let startRow = 1;
    for (let r = 1; r <= 20; r++) {
      const row = worksheet.getRow(r);
      const a = row.getCell(1).value;
      const b = row.getCell(2).value;
      if (a !== null && a !== undefined && a !== "" ||
          b !== null && b !== undefined && b !== "") {
        startRow = r + 1;
      }
    }
    logger.info({ startRow }, "Writing account data starting at row");

    for (let i = 0; i < qty; i++) {
      const line = accountLines[i] ?? `account_${orderId}_${i + 1}`;
      const [email, password] = line.split("|");
      const row = worksheet.getRow(startRow + i);
      row.getCell(1).value = email ?? line;
      row.getCell(2).value = password ?? "";
      row.commit();
    }

    const outputBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    // ── Save to cache before responding ───────────────────────────────────────
    saveCachedFile(orderId, outputBuffer);

    const fileName = `order_${orderId}_filled.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(outputBuffer);

  } catch (err) {
    logger.error({ err }, "process-order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Cache management endpoints ────────────────────────────────────────────────

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
