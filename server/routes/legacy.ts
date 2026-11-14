// Moves the ledger from the old single-passcode version into one account, once,
// for whoever knows that old passcode (LEDGER_PASSCODE).
import crypto from "node:crypto";
import { Router } from "express";
import { claimLegacy, legacyStatus, loginFailures, noteLoginFailure } from "../lib/store";
import { me, requireUser } from "../middleware";

const router = Router();
router.use("/import-legacy", requireUser);

router.get("/import-legacy", async (_req, res) => {
  if (!process.env.LEDGER_PASSCODE) return void res.json({ available: false, count: 0 });
  res.json(await legacyStatus());
});

router.post("/import-legacy", async (req, res) => {
  const uid = me(req).id;
  const guardKey = `legacy:${uid}`;
  if ((await loginFailures(guardKey)) >= 5) return void res.status(429).json({ error: "Too many wrong attempts. Wait 15 minutes." });
  const pass = process.env.LEDGER_PASSCODE;
  const h = (s: unknown) => crypto.createHash("sha256").update(String(s)).digest();
  if (!pass || !crypto.timingSafeEqual(h(req.body?.passcode || ""), h(pass))) {
    await noteLoginFailure(guardKey);
    return void res.status(403).json({ error: "That isn't the old passcode." });
  }
  const result = await claimLegacy(uid);
  if (!result.ok) return void res.status(409).json({ error: "Those entries were already imported into an account." });
  res.json({ imported: result.count });
});

export default router;
