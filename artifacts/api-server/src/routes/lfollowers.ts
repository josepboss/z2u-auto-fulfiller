import { Router } from "express";
import axios from "axios";
import { logger } from "../lib/logger.js";

const router = Router();

const LFOLLOWERS_API_URL = "https://lfollowers.com/api/v2";

function getApiKey(): string {
  const key = process.env.LFOLLOWERS_API_KEY;
  if (!key) throw new Error("LFOLLOWERS_API_KEY is not set in environment");
  return key;
}

router.get("/admin/services", async (_req, res) => {
  try {
    const key = getApiKey();
    const response = await axios.post(LFOLLOWERS_API_URL, null, {
      params: { key, action: "services" },
    });
    res.json({ data: response.data });
  } catch (err) {
    logger.error({ err }, "Failed to fetch lfollowers services");
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

router.post("/order", async (req, res) => {
  const { service, link, quantity } = req.body as {
    service: string;
    link: string;
    quantity: number;
  };
  if (!service || !link || !quantity) {
    res.status(400).json({ error: "service, link, and quantity are required" });
    return;
  }
  try {
    const key = getApiKey();
    const response = await axios.post(LFOLLOWERS_API_URL, null, {
      params: { key, action: "add", service, link, quantity },
    });
    res.json({ data: response.data });
  } catch (err) {
    logger.error({ err }, "Failed to place lfollowers order");
    res.status(500).json({ error: "Failed to place order" });
  }
});

export default router;
