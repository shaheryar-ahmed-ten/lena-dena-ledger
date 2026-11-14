// Sign-up, login, logout, and "who am I".
import crypto from "node:crypto";
import { Router } from "express";
import { checkPassword, checkUsername, COOKIE, hashPassword, sessionCookie, startSession, verifyPassword, currentUser } from "../lib/auth";
import { createUser, findUser, loginFailures, noteLoginFailure, hasDatabase } from "../lib/store";
import { enabledProviders } from "../lib/oauth";
import { sleep } from "../middleware";

const router = Router();
const MAX_FAILURES = 10;

// What the login/sign-up pages need to know before anyone is logged in.
router.get("/auth/config", (_req, res) => {
  res.json({ providers: enabledProviders(), needsCode: Boolean(process.env.SIGNUP_CODE), hasDatabase });
});

router.get("/me", async (req, res) => {
  const user = await currentUser(req);
  if (!user) return void res.status(401).json({ error: "Not logged in." });
  res.json({ username: user.username });
});

router.post("/signup", async (req, res) => {
  const body = req.body || {};
  const code = process.env.SIGNUP_CODE;
  if (code && String(body.code || "").trim() !== code) {
    await sleep(600);
    return void res.status(403).json({ error: "That invite code isn't right. Ask the person who shared this app with you." });
  }
  const u = checkUsername(body.username);
  if ("error" in u) return void res.status(400).json({ error: u.error });
  const p = checkPassword(body.password);
  if ("error" in p) return void res.status(400).json({ error: p.error });

  const { salt, hash } = await hashPassword(p.value);
  const user = { id: crypto.randomUUID(), username: u.value, salt, hash, sessionVersion: 0, createdAt: new Date().toISOString() };
  if (!(await createUser(user))) return void res.status(409).json({ error: "That username is taken. Try another." });
  await startSession(res, user);
  res.json({ ok: true });
});

router.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) return void res.status(400).json({ error: "Enter your username and password." });
  if ((await loginFailures(username)) >= MAX_FAILURES) {
    return void res.status(429).json({ error: "Too many wrong attempts. Wait 15 minutes, then try again." });
  }
  const user = await findUser(username);
  if (!user || !(await verifyPassword(password, user))) {
    await noteLoginFailure(username);
    await sleep(600); // slow down guessing
    return void res.status(401).json({ error: "Wrong username or password." });
  }
  await startSession(res, user);
  res.json({ ok: true });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE, { ...sessionCookie, maxAge: undefined });
  res.json({ ok: true });
});

export default router;
