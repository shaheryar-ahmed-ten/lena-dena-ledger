// AI understanding of sentences (/parse) and Whisper speech-to-text (/transcribe).
import { Router } from "express";
import multer from "multer";
import { aiConfig, aiParse } from "../lib/ai";
import { AppError } from "../lib/errors";
import { getDictionary, useAiBudget } from "../lib/store";
import { sttConfig, transcribe } from "../lib/stt";
import { me, requireUser } from "../middleware";

const router = Router();
router.use(["/parse", "/transcribe"], requireUser);

// Recordings arrive as multipart/form-data. Kept in memory (Vercel functions accept about 4.5 MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

const statusFor = (code: string) => (code === "not_configured" ? 501 : code === "rate_limited" ? 429 : 502);

function sendError(res: import("express").Response, e: unknown, label: string) {
  if (e instanceof AppError) {
    if (e.detail) console.error(`${label}:`, e.detail);
    return void res.status(statusFor(e.code)).json({ error: e.message, code: e.code });
  }
  throw e;
}

router.get("/parse", (_req, res) => {
  const cfg = aiConfig();
  res.json({ enabled: Boolean(cfg), provider: cfg?.name || null, whisper: Boolean(sttConfig()) });
});

router.post("/parse", async (req, res) => {
  if (!(await useAiBudget(me(req).id))) {
    return void res.status(429).json({ error: "You've used this hour's AI allowance. Try again later.", code: "rate_limited" });
  }
  const b = req.body || {};
  const text = String(b.text ?? "").trim().slice(0, 1000);
  if (!text) return void res.status(400).json({ error: "Say or type what happened first." });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date().toISOString().slice(0, 10);
  const strings = (v: unknown, max: number, len: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map(x => x.trim().slice(0, len)) : [];
  try {
    const entries = await aiParse({
      text,
      today,
      knownPeople: strings(b.knownPeople, 200, 60),
      drafts: Array.isArray(b.drafts) ? b.drafts.slice(0, 20) : null,
      alternatives: strings(b.alternatives, 5, 1000),
    });
    res.json({ entries });
  } catch (e) {
    sendError(res, e, "AI error");
  }
});

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  const uid = me(req).id;
  if (!(await useAiBudget(uid))) {
    return void res.status(429).json({ error: "You've used this hour's speech allowance. Try again later, or type instead.", code: "rate_limited" });
  }
  const file = req.file;
  if (!file?.size) return void res.status(400).json({ error: "No recording was received. Try again." });
  const lang = req.body?.lang === "ur" ? "ur" : "en";
  let names: string[] = [];
  try { names = (JSON.parse(String(req.body?.names || "[]")) as unknown[]).filter((n): n is string => typeof n === "string").map(n => n.slice(0, 60)).slice(0, 40); } catch { /* ignore */ }
  const type = file.mimetype || "";
  const ext = /mp4|m4a/.test(type) ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  try {
    // Words from the user's word list are mentioned in Whisper's hint so it expects them.
    const words = [...new Set((await getDictionary(uid).catch(() => [])).map(p => p.meant).filter(Boolean))];
    const text = await transcribe({ audio: file.buffer, mimeType: type, filename: `speech.${ext}`, lang, names, words });
    res.json({ text });
  } catch (e) {
    sendError(res, e, "STT error");
  }
});

export default router;
