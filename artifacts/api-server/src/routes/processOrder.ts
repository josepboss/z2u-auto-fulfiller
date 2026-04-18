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

    const qty = parseInt(quantity, 10);

    logger.info(
      { title, productId, quantity: qty, orderId },
      "Purchasing accounts from Lfollowers"
    );

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
      const line = accountLines[i] ?? `account_${orderId ?? "unknown"}_${i + 1}`;
      const [email, password] = line.split("|");
      const row = worksheet.getRow(startRow + i);
      row.getCell(1).value = email ?? line;
      row.getCell(2).value = password ?? "";
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
