// Sign in with Google (OAuth 2.0 authorization-code flow with PKCE).
// The button appears only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
import crypto from "node:crypto";
import type { Provider } from "../../shared/types";

type Headers = Record<string, string>;

interface ProviderConfig {
  name: string;
  id: () => string | undefined;
  secret: () => string | undefined;
  authorize: string;
  token: string;
  scope: string;
  pkce: boolean;
  extra?: Record<string, string>;
  profile: (token: string, headers: (t: string) => Headers) => Promise<Profile>;
}

export interface Profile {
  sub: string;
  name?: string;
  email?: string;
  handle?: string;
  provider?: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  google: {
    name: "Google",
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    pkce: true,
    extra: { prompt: "select_account" },
    async profile(tok, h) {
      const u = (await getJson("https://openidconnect.googleapis.com/v1/userinfo", h(tok))) as { sub: string; name?: string; email?: string };
      return { sub: u.sub, name: u.name, email: u.email };
    },
  },
};

// For local testing only: send every provider call to a mock server. Never used on a Vercel production deploy.
const MOCK = process.env.VERCEL_ENV === "production" ? "" : process.env.OAUTH_TEST_MOCK_URL || "";
function url(u: string): string {
  if (!MOCK) return u;
  const x = new URL(u);
  return `${MOCK.replace(/\/$/, "")}/${x.hostname}${x.pathname}${x.search}`;
}

async function getJson(u: string, headers: Headers): Promise<unknown> {
  const res = await fetch(url(u), { headers });
  if (!res.ok) throw new Error(`Profile request failed (${res.status})`);
  return res.json();
}

/** Providers whose keys are set (shown as buttons). */
export function enabledProviders(): Provider[] {
  return Object.entries(PROVIDERS).filter(([, p]) => p.id() && p.secret()).map(([key, p]) => ({ key, name: p.name }));
}

export function getProvider(key: string): ProviderConfig | null {
  const p = PROVIDERS[key];
  return p && p.id() && p.secret() ? p : null;
}

/** Only the site address matters, even if APP_URL was entered with a path such as the full callback URL. */
export function callbackUrl(origin: string, key: string): string {
  let base = origin;
  try { if (process.env.APP_URL) base = new URL(process.env.APP_URL.trim()).origin; } catch { /* keep origin */ }
  return `${base.replace(/\/$/, "")}/api/oauth/${key}/callback`;
}

export function newPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(key: string, opts: { state: string; challenge: string; redirectUri: string }): string {
  const p = PROVIDERS[key];
  const q = new URLSearchParams({
    client_id: p.id() || "",
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: p.scope,
    state: opts.state,
    ...(p.pkce ? { code_challenge: opts.challenge, code_challenge_method: "S256" } : {}),
    ...(p.extra || {}),
  });
  const base = url(p.authorize);
  return `${base}${base.includes("?") ? "&" : "?"}${q}`;
}

/** Swap the one-time code for a token, then read who the person is. */
export async function fetchProfile(key: string, opts: { code: string; verifier: string; redirectUri: string }): Promise<Profile & { provider: string }> {
  const p = PROVIDERS[key];
  const params: Record<string, string> = {
    client_id: p.id() || "",
    client_secret: p.secret() || "",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    ...(p.pkce ? { code_verifier: opts.verifier } : {}),
  };
  const res = await fetch(url(p.token), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; error?: any; error_description?: string };
  if (!res.ok || !tok.access_token) throw new Error(tok.error_description || tok.error?.message || tok.error || `Sign-in with ${p.name} failed.`);
  const headers = (t: string): Headers => ({ Authorization: `Bearer ${t}`, Accept: "application/json", "User-Agent": "lena-dena-ledger" });
  const prof = await p.profile(tok.access_token, headers);
  if (!prof.sub) throw new Error(`${p.name} didn't say who you are.`);
  return { ...prof, provider: key };
}

/** A readable, valid username suggestion from the profile ("alice.k@gmail.com" -> "alice.k"). */
export function suggestUsername(prof: Profile & { provider: string }): string {
  const raw = prof.handle || (prof.email ? prof.email.split("@")[0] : "") || prof.name || `${prof.provider}user`;
  let u = raw.normalize("NFKD").replace(/[^\w.\- ]/g, "").trim().replace(/\s+/g, ".").replace(/[^a-zA-Z0-9_.-]/g, "").toLowerCase();
  if (u.length < 3) u = `${u}${prof.provider}`.slice(0, 30);
  return u.slice(0, 26);
}
