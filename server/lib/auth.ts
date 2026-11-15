// Passwords, signed session cookies, and the short-lived OAuth state cookie.
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, CookieOptions } from "express";
import { findUser, storedSecret, type User } from "./store";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export const COOKIE = "ledger_session";
export const OAUTH_COOKIE = "ledger_oauth";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

let secretCache: string | null = null;
async function secret(): Promise<string> {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!secretCache) secretCache = await storedSecret(() => crypto.randomBytes(32).toString("hex"));
  return secretCache;
}

async function sign(value: string): Promise<string> {
  return crypto.createHmac("sha256", await secret()).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---- passwords (scrypt with a random salt per user) ----
export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(password: string, user: User | null): Promise<boolean> {
  if (!user?.salt || !user?.hash) return false;
  const hash = (await scrypt(password, user.salt, 64)).toString("hex");
  return safeEqual(hash, user.hash);
}

// ---- sessions: "v2.<username b64>.<expires>.<sessionVersion>.<signature>" in an httpOnly cookie ----
export async function makeToken(user: User): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const payload = `v2.${Buffer.from(user.username.toLowerCase()).toString("base64url")}.${expires}.${user.sessionVersion || 0}`;
  return `${payload}.${await sign(payload)}`;
}

export interface SessionUser {
  id: string;
  username: string;
}

async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const payload = parts.slice(0, 4).join(".");
  if (!safeEqual(parts[4], await sign(payload))) return null;
  if (Number(parts[2]) < Date.now() / 1000) return null;
  const user = await findUser(Buffer.from(parts[1], "base64url").toString());
  if (!user || String(user.sessionVersion || 0) !== parts[3]) return null;
  return { id: user.id, username: user.username };
}

/** The signed-in user for this request, or null. */
export function currentUser(req: Request): Promise<SessionUser | null> {
  return userFromToken(req.cookies?.[COOKIE]);
}

export const sessionCookie: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
  sameSite: "lax",
  path: "/",
  maxAge: MAX_AGE_S * 1000, // Express uses milliseconds
};

export async function startSession(res: Response, user: User) {
  res.cookie(COOKIE, await makeToken(user), sessionCookie);
}

// ---- validation ----
export function checkUsername(u: unknown): { value: string } | { error: string } {
  const name = String(u || "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(name)) return { error: "Usernames are 3–30 letters, numbers, dots, dashes or underscores." };
  return { value: name };
}

export function checkPassword(p: unknown): { value: string } | { error: string } {
  const pass = String(p || "");
  if (pass.length < 8) return { error: "Use a password of at least 8 characters." };
  if (pass.length > 200) return { error: "That password is too long." };
  return { value: pass };
}

// ---- encryption for secrets kept in the database (Google access tokens) ----
// AES-256-GCM with a key derived from the session secret, so no extra setting is needed.
// Signing (above) stops tampering; encryption also stops anyone reading the database from using the token.
async function encryptionKey(): Promise<Buffer> {
  return Buffer.from(crypto.hkdfSync("sha256", await secret(), "lena-dena-ledger", "stored-token-encryption", 32));
}

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString("base64url")).join(".");
}

/** The original text, or null if it was changed or encrypted with a different secret. */
export async function decryptSecret(sealed: string): Promise<string | null> {
  try {
    const [iv, tag, data] = sealed.split(".").map(s => Buffer.from(s, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", await encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function checkInviteCode(code: unknown): boolean {
  const need = process.env.SIGNUP_CODE;
  return !need || String(code || "").trim() === need;
}

// ---- signed cookie carrying OAuth state between "start" and "callback" (10 minutes) ----
export interface OAuthState {
  provider: string;
  state: string;
  nonce: string;
  verifier: string;
  mode: "login" | "signup" | "link" | "drive";
  invited: boolean;
  linkUser: string | null; // the logged-in user who started a "link" or "drive" round trip
  redirectUri: string;
  exp?: number;
}

export async function sealState(obj: OAuthState): Promise<string> {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + 10 * 60 * 1000 })).toString("base64url");
  return `${body}.${await sign(body)}`;
}

export async function openState(value: string | undefined): Promise<OAuthState | null> {
  const [body, sig] = String(value || "").split(".");
  if (!body || !sig || !safeEqual(sig, await sign(body))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, "base64url").toString()) as OAuthState;
    return (obj.exp ?? 0) > Date.now() ? obj : null;
  } catch {
    return null;
  }
}
