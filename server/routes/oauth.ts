// "Continue with Google": start (redirect to Google), callback (Google redirects back), and status.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { checkInviteCode, currentUser, OAUTH_COOKIE, openState, sealState, startSession, sessionCookie } from "../lib/auth";
import { authorizeUrl, callbackUrl, enabledProviders, fetchProfile, getProvider, newPkce, suggestUsername } from "../lib/oauth";
import { createUser, findIdentity, findUser, identitiesOf, linkIdentity, type User } from "../lib/store";
import { requestOrigin } from "../middleware";

const router = Router();

const stateCookie = { httpOnly: true, secure: sessionCookie.secure, sameSite: "lax" as const, path: "/api/oauth" };
const goTo = (res: Response, path: string) => res.redirect(302, path);
const withError = (page: string, msg: string) => `/${page}?error=${encodeURIComponent(msg)}`;

// GET /api/oauth/google/start?mode=login|signup|link[&code=INVITE]
router.get("/oauth/:provider/start", async (req: Request<{ provider: string }>, res) => {
  const { provider } = req.params;
  const { host, origin } = requestOrigin(req);

  // Always run sign-in on the main address, so Google's registered callback matches and the state cookie comes back.
  if (process.env.APP_URL) {
    try {
      const main = new URL(process.env.APP_URL.trim());
      if (main.host !== host) return goTo(res, new URL(req.originalUrl, main.origin).toString());
    } catch { /* bad APP_URL: carry on with the current address */ }
  }

  const q = req.query as Record<string, string | undefined>;
  const mode = q.mode === "signup" || q.mode === "link" ? q.mode : "login";
  const page = mode === "signup" ? "signup" : "login";
  const p = getProvider(provider);
  if (!p) return goTo(res, withError(page, "That sign-in option isn't set up."));

  let linkUser: string | null = null;
  if (mode === "link") {
    const user = await currentUser(req);
    if (!user) return goTo(res, withError("login", "Log in first, then connect another sign-in method."));
    linkUser = user.username.toLowerCase();
  }
  const invited = mode === "signup" && Boolean(process.env.SIGNUP_CODE) && checkInviteCode(q.code);
  if (mode === "signup" && process.env.SIGNUP_CODE && !invited) {
    return goTo(res, withError("signup", "Enter the invite code first, then choose how to sign up."));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const { verifier, challenge } = newPkce();
  const redirectUri = callbackUrl(origin, provider);
  res.cookie(OAUTH_COOKIE, await sealState({ provider, state, verifier, mode, invited, linkUser, redirectUri }), { ...stateCookie, maxAge: 10 * 60 * 1000 });
  goTo(res, authorizeUrl(provider, { state, challenge, redirectUri }));
});

// GET /api/oauth/google/callback?code=…&state=…   (Google sends the browser here)
router.get("/oauth/:provider/callback", async (req: Request<{ provider: string }>, res) => {
  const { provider } = req.params;
  const q = req.query as Record<string, string | undefined>;
  const st = await openState(req.cookies?.[OAUTH_COOKIE]);
  res.clearCookie(OAUTH_COOKIE, stateCookie); // single use, whatever happens next
  const page = st?.mode === "signup" ? "signup" : "login";
  const p = getProvider(provider);
  if (!p) return goTo(res, withError(page, "That sign-in option isn't set up."));

  // The state must match the one stored before going to Google (stops forged logins).
  const sent = String(q.state || "");
  if (!st || st.provider !== provider || sent.length !== st.state.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(st.state))) {
    return goTo(res, withError("login", "That sign-in took too long or came from somewhere else. Please try again."));
  }
  if (q.error) return goTo(res, withError(page, `Sign-in with ${p.name} was cancelled.`));
  if (!q.code) return goTo(res, withError(page, `${p.name} didn't send a sign-in code. Please try again.`));

  let prof;
  try {
    prof = await fetchProfile(provider, { code: q.code, verifier: st.verifier, redirectUri: st.redirectUri });
  } catch (e) {
    console.error("OAuth error:", provider, (e as Error).message);
    return goTo(res, withError(page, `Couldn't sign in with ${p.name}. Please try again.`));
  }

  const linked = await findIdentity(provider, prof.sub);

  // Connecting Google to the account you're logged into.
  if (st.mode === "link") {
    const user = await currentUser(req);
    if (!user || user.username.toLowerCase() !== st.linkUser) return goTo(res, withError("login", "Log in again, then connect the account."));
    if (linked && linked.username.toLowerCase() !== st.linkUser) {
      return goTo(res, `/?error=${encodeURIComponent(`That ${p.name} account is already used by another ledger account.`)}`);
    }
    if (!linked) await linkIdentity(provider, prof.sub, user.username);
    return goTo(res, `/?connected=${provider}`);
  }

  // Returning user.
  if (linked) {
    await startSession(res, linked);
    return goTo(res, "/");
  }

  // New user: create an account (invite-only mode needs the code entered on the sign-up page).
  if (process.env.SIGNUP_CODE && !st.invited) {
    return goTo(res, withError("signup", `There's no account for this ${p.name} login yet. Enter the invite code, then choose ${p.name} again.`));
  }
  const base = suggestUsername(prof);
  let user: User | null = null;
  for (let i = 0; i < 50 && !user; i++) {
    const candidate: User = { id: crypto.randomUUID(), username: i === 0 ? base : `${base.slice(0, 26)}${i + 1}`, salt: null, hash: null, sessionVersion: 0, createdAt: new Date().toISOString(), via: provider };
    if (await createUser(candidate)) user = candidate;
  }
  if (!user) return goTo(res, withError(page, "Couldn't create your account. Please try again."));
  if (!(await linkIdentity(provider, prof.sub, user.username))) {
    const winner = await findIdentity(provider, prof.sub); // someone finished the same sign-in a moment earlier
    if (winner) { await startSession(res, winner); return goTo(res, "/"); }
  }
  await startSession(res, user);
  goTo(res, "/?welcome=1");
});

router.get("/oauth/status", async (req, res) => {
  const providers = enabledProviders();
  const user = await currentUser(req);
  if (!user) return void res.json({ providers });
  const [connected, record] = await Promise.all([identitiesOf(user.username), findUser(user.username)]);
  res.json({ providers, connected, hasPassword: Boolean(record?.hash) });
});

export default router;
