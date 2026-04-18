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

    const mappings = loadMappings();
    const productId = mappings[title];

    if (!productId) {
      res
        .status(404)
        .json({ error: `No mapping found for title: "${title}"` });
      return;
    }

    logger.info(
      { title, productId, quantity, orderId },
      "Processing order from Z2U"
    );

    const key = getApiKey();
    const lfResponse = await axios.post(LFOLLOWERS_API_URL, null, {
      params: { key, action: "products" },
    });

    const products: Array<{ product_id: string; email?: string }> =
      lfResponse.data;

    const matchedProduct = Array.isArray(products)
      ? products.find((p) => String(p.product_id) === String(productId))
      : null;

    const qty = parseInt(quantity, 10);
    const emails: string[] = [];

    if (matchedProduct && "email" in matchedProduct) {
      for (let i = 0; i < qty; i++) {
        emails.push((matchedProduct as { email: string }).email);
      }
    }

    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — ExcelJS types mismatch with Node 24 Buffer but works at runtime
    await workbook.xlsx.load(req.file.buffer);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      res.status(400).json({ error: "Excel file has no worksheet" });
      return;
    }

    const headerRow = worksheet.getRow(1);
    const startRow = headerRow.getCell(1).value ? 2 : 1;

    for (let i = 0; i < qty; i++) {
      const row = worksheet.getRow(startRow + i);
      row.getCell(1).value = emails[i] ?? `account_${orderId ?? "unknown"}_${i + 1}`;
      row.getCell(2).value = productId;
      row.commit();
    }

    const outputBuffer = await workbook.xlsx.writeBuffer();

    const fileName = `order_${orderId ?? Date.now()}_filled.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(Buffer.from(outputBuffer));
  } catch (err) {
    logger.error({ err }, "process-order failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
