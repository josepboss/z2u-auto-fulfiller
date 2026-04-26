import { Router } from "express";
import { logger } from "../lib/logger.js";

const router = Router();

interface HealSelectors {
  fileInput?: string;
  submitButton?: string;
  uploadButton?: string;
}

router.post("/heal", async (req, res) => {
  try {
    const { html, reason, selectors } = req.body as {
      html?: string;
      reason?: string;
      selectors?: HealSelectors;
    };

    if (!html || typeof html !== "string") {
      res.status(400).json({ error: "html is required" });
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "OPENROUTER_API_KEY is not configured" });
      return;
    }

    const prompt = [
      "You are repairing selectors for a Z2U upload modal.",
      "Return strict JSON only with keys: fileInput, submitButton, uploadButton.",
      "Prefer stable CSS selectors (id/name/data-testid/text-based not allowed unless unavoidable).",
      `Previous selectors: ${JSON.stringify(selectors || {})}`,
      `Failure reason: ${reason || "unknown"}`,
      "HTML:",
      html.slice(0, 120000),
    ].join("\n\n");

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.HEAL_MODEL || "google/gemini-1.5-flash",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Output only JSON. Keep selectors concise and valid." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, text }, "heal endpoint upstream failed");
      res.status(502).json({ error: "heal upstream failed", status: resp.status, detail: text.slice(0, 400) });
      return;
    }

    const data = await resp.json() as any;
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed: HealSelectors = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    res.json({ ok: true, selectors: parsed });
  } catch (err) {
    logger.error({ err }, "heal failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
