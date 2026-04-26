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

type DeliveryMethod = "file" | "direct" | "chat";

interface MappingEntry {
  serviceId: string;
  columnMap?: Record<string, string>;
  deliveryMethod?: DeliveryMethod;
}

interface ParsedAccount {
  user: string;
  pass: string;
  email: string;
  email_pass: string;
  raw: string;
}

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

function loadMappings(): Record<string, string | MappingEntry> {
  if (!fs.existsSync(MAPPINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPINGS_FILE, "utf-8"));
}

function normalizeMappingEntry(v: string | MappingEntry): MappingEntry {
  if (typeof v === "string") {
    return {
      serviceId: v,
      deliveryMethod: "file",
      columnMap: { email: "A", password: "B" },
    };
  }
  return {
    serviceId: String(v.serviceId || ""),
    deliveryMethod: v.deliveryMethod || "file",
    columnMap: v.columnMap && Object.keys(v.columnMap).length ? v.columnMap : { email: "A", password: "B" },
  };
}

function getApiKey(): string {
  const key = process.env.LFOLLOWERS_API_KEY;
  if (!key) throw new Error("LFOLLOWERS_API_KEY is not set");
  return key;
}

function parseAccountLine(line: string): ParsedAccount {
  const parts = line.split(/[|:;\/\s]+/).map((p) => p.trim()).filter(Boolean);
  const user = parts[0] || "";
  const pass = parts[1] || "";
  const emailIdx = parts.findIndex((p) => p.includes("@"));
  const email = emailIdx >= 0 ? parts[emailIdx] : (parts[2] || "");
  const email_pass = emailIdx >= 0 ? (parts[emailIdx + 1] || parts[3] || "") : (parts[3] || "");
  return { user, pass, email, email_pass, raw: line.trim() };
}

async function purchaseAccounts(productId: string, qty: number): Promise<ParsedAccount[]> {
  const key = getApiKey();
  const lfResponse = await axios.post(LFOLLOWERS_API_URL, {
    key,
    action: "purchase",
    product_id: productId,
    quantity: qty,
  });

  const purchaseResult = lfResponse.data as { delivered_data?: string; error?: string };
  if (purchaseResult.error) {
    throw new Error(`Lfollowers error: ${purchaseResult.error}`);
  }

  return (purchaseResult.delivered_data ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseAccountLine);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeFieldKey(field: string): string {
  return field.toLowerCase().replace(/[_\s-]/g, "");
}

function valueForField(account: ParsedAccount, field: string): string {
  const key = normalizeFieldKey(field);
  const dict: Record<string, string> = {
    user: account.user,
    username: account.user,
    login: account.user,
    pass: account.pass,
    password: account.pass,
    email: account.email,
    emailpass: account.email_pass,
    emailpassword: account.email_pass,
    emailpwd: account.email_pass,
    raw: account.raw,
  };
  return dict[key] ?? "";
}

function buildRowXml(rowNum: number, account: ParsedAccount, columnMap: Record<string, string>): string {
  const cells = Object.entries(columnMap)
    .map(([field, col]) => ({ field, col: String(col || "").toUpperCase().trim() }))
    .filter((x) => /^[A-Z]+$/.test(x.col))
    .map(({ field, col }) => {
      const value = valueForField(account, field);
      if (!value) return "";
      return `<c r="${col}${rowNum}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    })
    .filter(Boolean)
    .join("");

  return `<row r="${rowNum}">${cells}</row>`;
}

function fillXlsxBuffer(templateBuffer: Buffer, accounts: ParsedAccount[], qty: number, columnMap: Record<string, string>): Buffer {
  const zip = new AdmZip(templateBuffer);
  const entries: string[] = zip.getEntries().map((e: { entryName: string }) => e.entryName);
  const sheetEntry = entries.find((n) => /xl\/worksheets\/sheet\d+\.xml/.test(n));
  if (!sheetEntry) throw new Error("Could not find worksheet XML in xlsx");

  let wsXml: string = zip.readAsText(sheetEntry);
  wsXml = wsXml.replace(/<row\s[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (match, rNum) =>
    parseInt(rNum, 10) >= 4 ? "" : match,
  );
  wsXml = wsXml.replace(/<sheetData\s*\/>/, "<sheetData></sheetData>");

  const newRows = accounts
    .slice(0, qty)
    .map((a, i) => buildRowXml(4 + i, a, columnMap))
    .join("");

  wsXml = wsXml.replace("</sheetData>", newRows + "</sheetData>");
  zip.updateFile(sheetEntry, Buffer.from(wsXml, "utf8"));
  return zip.toBuffer() as Buffer;
}

function formatCredentials(accounts: ParsedAccount[]): string {
  return accounts
    .map((a, idx) => {
      const chunks = [
        a.user ? `user: ${a.user}` : "",
        a.pass ? `pass: ${a.pass}` : "",
        a.email ? `email: ${a.email}` : "",
        a.email_pass ? `email_pass: ${a.email_pass}` : "",
      ].filter(Boolean);
      return `${idx + 1}) ${chunks.join(" | ")}`;
    })
    .join("\n");
}

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

router.post("/prepare-order", async (req, res) => {
  try {
    const { title, quantity, orderId } = req.body as { title: string; quantity: number | string; orderId?: string };
    if (!title || !quantity) {
      res.status(400).json({ error: "title and quantity are required" });
      return;
    }

    const qty = parseInt(String(quantity), 10);
    const mappings = loadMappings();
    const rawMapping = mappings[title];
    if (!rawMapping) {
      res.status(404).json({ error: `No mapping found for title: \"${title}\"` });
      return;
    }

    const mapping = normalizeMappingEntry(rawMapping);
    if (!mapping.serviceId) {
      res.status(400).json({ error: `Invalid mapping config for title: \"${title}\"` });
      return;
    }

    const accounts = await purchaseAccounts(mapping.serviceId, qty);
    res.json({
      ok: true,
      orderId: orderId || "",
      title,
      productId: mapping.serviceId,
      deliveryMethod: mapping.deliveryMethod || "file",
      columnMap: mapping.columnMap || { email: "A", password: "B" },
      accounts,
      formattedCredentials: formatCredentials(accounts),
    });
  } catch (err) {
    logger.error({ err }, "prepare-order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/process-order", upload.single("file"), async (req, res) => {
  try {
    const { title, quantity, orderId } = req.body as { title: string; quantity: string; orderId?: string };

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
    const mappings = loadMappings();
    const rawMapping = mappings[title];
    if (!rawMapping) {
      res.status(404).json({ error: `No mapping found for title: \"${title}\"` });
      return;
    }
    const mapping = normalizeMappingEntry(rawMapping);

    if ((mapping.deliveryMethod || "file") !== "file") {
      const accounts = await purchaseAccounts(mapping.serviceId, qty);
      res.json({
        ok: true,
        deliveryMethod: mapping.deliveryMethod,
        columnMap: mapping.columnMap,
        accounts,
        formattedCredentials: formatCredentials(accounts),
      });
      return;
    }

    const cached = getCachedFile(orderId);
    if (cached) {
      const outputFilename = req.file.originalname || `${orderId}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${outputFilename}"`);
      res.send(cached);
      return;
    }

    logger.info({ title, productId: mapping.serviceId, quantity: qty, orderId }, "Purchasing from Lfollowers");
    const accounts = await purchaseAccounts(mapping.serviceId, qty);
    const columnMap = mapping.columnMap || { email: "A", password: "B" };

    logger.info({ qty, accounts: accounts.length, columnMap }, "Filling template via ZIP+XML surgery");
    const outputBuffer = fillXlsxBuffer(req.file.buffer, accounts, qty, columnMap);
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
