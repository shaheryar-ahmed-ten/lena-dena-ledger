// "Continue with Google": start (redirect to Google), callback (Google redirects back), and status.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { checkInviteCode, currentUser, encryptSecret, OAUTH_COOKIE, openState, sealState, startSession, sessionCookie, type OAuthState } from "../lib/auth";
import { callbackUrl, DRIVE_FILE_SCOPE, enabledProviders, finishSignIn, getProvider, SignInCancelled, startSignIn, suggestUsername, type ExtraAccess } from "../lib/oauth";
import { createUser, findIdentity, findUser, identitiesOf, linkIdentity, saveDriveToken, type User } from "../lib/store";
import { requestOrigin } from "../middleware";

const router = Router();

const stateCookie = { httpOnly: true, secure: sessionCookie.secure, sameSite: "lax" as const, path: "/api/oauth" };
const goTo = (res: Response, path: string) => res.redirect(302, path);
const withError = (page: string, msg: string) => `/${page}?error=${encodeURIComponent(msg)}`;
// Where to show an error: the sign-up page, the ledger itself (already logged in), or the login page.
const errorPage = (mode?: OAuthState["mode"]) => (mode === "signup" ? "signup" : mode === "drive" ? "" : "login");

// Extra Google permissions asked for, per mode. Only "drive" asks for more than sign-in.
const EXTRA_ACCESS: Partial<Record<OAuthState["mode"], ExtraAccess>> = {
  drive: { scopes: [DRIVE_FILE_SCOPE], params: { include_granted_scopes: "true" } },
};

// GET /api/oauth/google/start?mode=login|signup|link|drive[&code=INVITE]
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
  const mode: OAuthState["mode"] = q.mode === "signup" || q.mode === "link" || q.mode === "drive" ? q.mode : "login";
  const page = errorPage(mode);
  const p = getProvider(provider);
  if (!p) return goTo(res, withError(page, "That sign-in option isn't set up."));

  // "link" (connect Google to this account) and "drive" (allow Google Drive access) need a logged-in user.
  let linkUser: string | null = null;
  if (mode === "link" || mode === "drive") {
    const user = await currentUser(req);
    if (!user) return goTo(res, withError("login", mode === "link" ? "Log in first, then connect another sign-in method." : "Log in first, then import from Google Sheets."));
    linkUser = user.username.toLowerCase();
  }
  const invited = mode === "signup" && Boolean(process.env.SIGNUP_CODE) && checkInviteCode(q.code);
  if (mode === "signup" && process.env.SIGNUP_CODE && !invited) {
    return goTo(res, withError("signup", "Enter the invite code first, then choose how to sign up."));
  }

  // openid-client creates state, nonce and the PKCE pair and builds Google's URL.
  // They are kept in a signed cookie until Google sends the browser back.
  const redirectUri = callbackUrl(origin, provider);
  let signIn;
  try {
    signIn = await startSignIn(provider, redirectUri, EXTRA_ACCESS[mode]);
  } catch (e) {
    console.error("OAuth start error:", provider, (e as Error).message);
    return goTo(res, withError(page, `Couldn't reach ${p.name}. Please try again.`));
  }
  const { url, state, nonce, verifier } = signIn;
  res.cookie(OAUTH_COOKIE, await sealState({ provider, state, nonce, verifier, mode, invited, linkUser, redirectUri }), { ...stateCookie, maxAge: 10 * 60 * 1000 });
  goTo(res, url);
});

// GET /api/oauth/google/callback?code=…&state=…   (Google sends the browser here)
router.get("/oauth/:provider/callback", async (req: Request<{ provider: string }>, res) => {
  const { provider } = req.params;
  const st = await openState(req.cookies?.[OAUTH_COOKIE]);
  res.clearCookie(OAUTH_COOKIE, stateCookie); // single use, whatever happens next
  const page = errorPage(st?.mode);
  const p = getProvider(provider);
  if (!p) return goTo(res, withError(page, "That sign-in option isn't set up."));

  // No valid cookie means this browser didn't start this sign-in (or it's older than 10 minutes).
  if (!st || st.provider !== provider) {
    return goTo(res, withError("login", "That sign-in took too long or came from somewhere else. Please try again."));
  }

  // The address Google sent the browser to: the registered callback plus Google's query string.
  // Rebuilt from the sealed redirectUri so it is exact behind Vercel's proxy.
  const current = new URL(st.redirectUri);
  current.search = req.originalUrl.split("?")[1] || "";

  let prof;
  try {
    // openid-client checks state, exchanges the code (client_secret + PKCE) and validates the ID token.
    prof = await finishSignIn(provider, current, { state: st.state, nonce: st.nonce, verifier: st.verifier });
  } catch (e) {
    const drive = st.mode === "drive";
    if (e instanceof SignInCancelled) return goTo(res, withError(page, drive ? "Google Drive access was cancelled." : `Sign-in with ${p.name} was cancelled.`));
    const err = e as Error & { cause?: { message?: string } };
    console.error("OAuth error:", provider, err.message, err.cause?.message ? `(${err.cause.message})` : "");
    return goTo(res, withError(page, drive ? "Couldn't get access to Google Drive. Please try again." : `Couldn't sign in with ${p.name}. Please try again.`));
  }

  // Allowing Google Drive access for "Import from Google Sheets". This doesn't sign anyone in or link
  // accounts: any Google account the user picks is fine, it only decides whose Drive files they can pick.
  if (st.mode === "drive") {
    const user = await currentUser(req);
    if (!user || user.username.toLowerCase() !== st.linkUser) return goTo(res, withError("login", "Log in again, then import from Google Sheets."));
    if (!prof.grant.scopes.includes(DRIVE_FILE_SCOPE)) {
      return goTo(res, withError("", "To import a sheet, tick the Google Drive box on Google's screen. Only the files you pick are shared."));
    }
    await saveDriveToken(user.id, {
      token: await encryptSecret(prof.grant.accessToken),
      scope: prof.grant.scopes.join(" "),
      expiresAt: Date.now() + prof.grant.expiresIn * 1000,
    });
    return goTo(res, "/?import=sheets");
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
