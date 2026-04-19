import { Router } from "express";
import multer from "multer";
import { createRequire } from "module";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";

// adm-zip is CommonJS
const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

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

// ── Direct ZIP+XML XLSX fill ─────────────────────────────────────────────────
// Treats the .xlsx as a ZIP archive and does raw XML surgery on the worksheet.
// Nothing outside the inserted rows is touched — styles, merges, formulas,
// protection, and every other cell remain byte-for-byte identical to the template.

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildRowXml(rowNum: number, email: string, password: string): string {
  const eCell = `<c r="A${rowNum}" t="inlineStr"><is><t>${escapeXml(email)}</t></is></c>`;
  const pCell = password
    ? `<c r="B${rowNum}" t="inlineStr"><is><t>${escapeXml(password)}</t></is></c>`
    : "";
  return `<row r="${rowNum}">${eCell}${pCell}</row>`;
}

function fillXlsxBuffer(
  templateBuffer: Buffer,
  accountLines: string[],
  qty: number
): Buffer {
  const zip = new AdmZip(templateBuffer);

  // Find the first sheet XML — usually xl/worksheets/sheet1.xml
  const entries: string[] = zip.getEntries().map((e: { entryName: string }) => e.entryName);
  const sheetEntry = entries.find((n) => /xl\/worksheets\/sheet\d+\.xml/.test(n));
  if (!sheetEntry) throw new Error("Could not find worksheet XML in xlsx");

  let wsXml: string = zip.readAsText(sheetEntry);

  // Remove any existing rows at row 4 and above (template data rows, usually empty)
  // This prevents duplicate rows while keeping all header rows intact.
  wsXml = wsXml.replace(/<row\s[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (match, rNum) =>
    parseInt(rNum, 10) >= 4 ? "" : match
  );

  // Handle self-closing <sheetData/> edge case
  wsXml = wsXml.replace(/<sheetData\s*\/>/, "<sheetData></sheetData>");

  // Build and insert the data rows
  const newRows = accountLines
    .slice(0, qty)
    .map((line, i) => {
      const [email = line, password = ""] = line.split("|");
      return buildRowXml(4 + i, email.trim(), password.trim());
    })
    .join("");

  wsXml = wsXml.replace("</sheetData>", newRows + "</sheetData>");

  zip.updateFile(sheetEntry, Buffer.from(wsXml, "utf8"));
  return zip.toBuffer() as Buffer;
}

// ─────────────────────────────────────────────────────────────────────────────

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
      const outputFilename = req.file.originalname || `${orderId}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${outputFilename}"`);
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

    // ── Fill XLSX via direct ZIP+XML (zero format changes) ───────────────────
    logger.info({ qty, accounts: accountLines.length }, "Filling template via ZIP+XML surgery");
    const outputBuffer = fillXlsxBuffer(req.file.buffer, accountLines, qty);

    saveCachedFile(orderId, outputBuffer);

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
