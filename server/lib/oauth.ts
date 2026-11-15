// Sign in with Google using the `openid-client` library (OpenID Connect: authorization code + PKCE).
// The library does the protocol work: discovery, state/nonce/PKCE values, the Google URL,
// the code-for-token exchange and ID-token validation. This file adapts it to the app.
// The button appears only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
import type { Provider } from "../../shared/types";

// openid-client is an ES module and this server is compiled as CommonJS, so it's loaded with import().
type Oidc = typeof import("openid-client");
type Configuration = import("openid-client").Configuration;
let lib: Promise<Oidc> | null = null;
const oidc = () => (lib ??= import("openid-client"));

interface ProviderConfig {
  name: string;
  issuer: string; // OpenID Connect issuer; its /.well-known/openid-configuration lists the endpoints
  id: () => string | undefined;
  secret: () => string | undefined;
  scope: string;
  extra?: Record<string, string>;
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
    issuer: "https://accounts.google.com",
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    scope: "openid email profile",
    extra: { prompt: "select_account" },
  },
};

// For local testing only: the issuer URL of a local OpenID Connect test server, used instead of
// the real provider (plain http allowed). Never used on a Vercel production deploy.
const MOCK = process.env.VERCEL_ENV === "production" ? "" : process.env.OAUTH_TEST_MOCK_URL || "";

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

// Discovery fetches the provider's endpoints and keys once, then is reused while this server instance is warm.
const configs = new Map<string, Promise<Configuration>>();
function providerConfig(key: string): Promise<Configuration> {
  let config = configs.get(key);
  if (!config) {
    config = (async () => {
      const client = await oidc();
      const p = PROVIDERS[key];
      const issuer = new URL(MOCK || p.issuer);
      const options = MOCK ? { execute: [client.allowInsecureRequests] } : undefined;
      return client.discovery(issuer, p.id() || "", p.secret() || "", undefined, options); // client_secret_post
    })();
    config.catch(() => configs.delete(key)); // a failed lookup is retried on the next sign-in
    configs.set(key, config);
  }
  return config;
}

/** Google's "only the specific Drive files you use with this app" permission (per-file, non-sensitive). */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Extra permissions asked for on top of sign-in (incremental authorization). */
export interface ExtraAccess {
  scopes?: string[];
  params?: Record<string, string>;
}

/** Everything the callback will need to check, plus the URL to send the browser to. */
export interface SignInStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

/** Step 1: create fresh state, nonce and PKCE values and build the provider's sign-in URL. */
export async function startSignIn(key: string, redirectUri: string, extra: ExtraAccess = {}): Promise<SignInStart> {
  const client = await oidc();
  const config = await providerConfig(key);
  const p = PROVIDERS[key];
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: [p.scope, ...(extra.scopes || [])].join(" "),
    state,
    nonce,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    ...(p.extra || {}),
    ...(extra.params || {}),
  });
  return { url: url.href, state, nonce, verifier };
}

/** The person pressed Cancel (or the provider refused) on the provider's page. */
export class SignInCancelled extends Error {}

/** What the provider granted: used only when extra permissions were asked for. */
export interface Grant {
  accessToken: string;
  expiresIn: number; // seconds
  scopes: string[];
}

/**
 * Step 2: check the provider's reply and find out who signed in.
 * `currentUrl` must be the callback address exactly as registered, plus the query the provider sent;
 * the library sends that address (without the query) as redirect_uri when exchanging the code.
 */
export async function finishSignIn(
  key: string,
  currentUrl: URL,
  checks: { state: string; nonce: string; verifier: string },
): Promise<Profile & { provider: string; grant: Grant }> {
  const client = await oidc();
  const config = await providerConfig(key);
  let tokens;
  try {
    // Checks issuer and state, exchanges the code with client_secret + PKCE verifier,
    // then validates the ID token (issuer, audience = our client ID, expiry, nonce).
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      pkceCodeVerifier: checks.verifier,
      idTokenExpected: true,
    });
  } catch (e) {
    if (e instanceof client.AuthorizationResponseError) throw new SignInCancelled(e.error);
    throw e;
  }

  const claims = tokens.claims();
  if (!claims?.sub) throw new Error(`${PROVIDERS[key].name} didn't say who you are.`);
  let name = typeof claims.name === "string" ? claims.name : undefined;
  let email = typeof claims.email === "string" ? claims.email : undefined;
  if (!name && !email) {
    // Not in the ID token: ask the UserInfo endpoint (the library checks it is the same `sub`).
    const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
    name = typeof info.name === "string" ? info.name : undefined;
    email = typeof info.email === "string" ? info.email : undefined;
  }
  // The user can untick permissions on the consent screen, so report what was actually granted.
  const grant: Grant = {
    accessToken: tokens.access_token,
    expiresIn: tokens.expiresIn() ?? 3600,
    scopes: (tokens.scope || "").split(" ").filter(Boolean),
  };
  return { sub: claims.sub, name, email, provider: key, grant };
}

/** A readable, valid username suggestion from the profile ("alice.k@gmail.com" -> "alice.k"). */
export function suggestUsername(prof: Profile & { provider: string }): string {
  const raw = prof.handle || (prof.email ? prof.email.split("@")[0] : "") || prof.name || `${prof.provider}user`;
  let u = raw.normalize("NFKD").replace(/[^\w.\- ]/g, "").trim().replace(/\s+/g, ".").replace(/[^a-zA-Z0-9_.-]/g, "").toLowerCase();
  if (u.length < 3) u = `${u}${prof.provider}`.slice(0, 30);
  return u.slice(0, 26);
}
