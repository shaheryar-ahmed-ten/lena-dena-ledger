// The signed-in user's word list (fixes for words the mic keeps mishearing).
import { Router } from "express";
import type { WordPair } from "../../shared/types";
import { getDictionary, setDictionary } from "../lib/store";
import { me, requireUser } from "../middleware";

const router = Router();
router.use("/dictionary", requireUser);

router.get("/dictionary", async (req, res) => {
  res.json({ pairs: await getDictionary(me(req).id) });
});

// Replaces the whole list (it's small, and this keeps edits simple). The first meaning sent for a word wins.
router.put("/dictionary", async (req, res) => {
  if (!Array.isArray(req.body?.pairs)) return void res.status(400).json({ error: "Bad request." });
  const seen = new Set<string>();
  const pairs: WordPair[] = [];
  for (const p of req.body.pairs.slice(0, 200)) {
    const heard = String(p?.heard ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const meant = String(p?.meant ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!heard || heard.toLowerCase() === meant.toLowerCase() || seen.has(heard.toLowerCase())) continue;
    seen.add(heard.toLowerCase());
    pairs.push({ heard, meant });
  }
  res.json({ pairs: await setDictionary(me(req).id, pairs) });
});

export default router;
