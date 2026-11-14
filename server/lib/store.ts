// All database access. Upstash Redis in production; an in-memory stand-in for local development.
import { Redis } from "@upstash/redis";
import type { Entry, WordPair } from "../../shared/types";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

export const hasDatabase = Boolean(redis);

// ---- tiny key-value layer (memory resets when the server restarts; the UI warns when there's no database) ----
type Mem = { h: Map<string, Map<string, string>>; s: Map<string, string>; exp: Map<string, number> };
const g = globalThis as unknown as { __ledgerKv?: Mem };
const mem: Mem = g.__ledgerKv || (g.__ledgerKv = { h: new Map(), s: new Map(), exp: new Map() });
const memHash = (key: string) => {
  if (!mem.h.has(key)) mem.h.set(key, new Map());
  return mem.h.get(key)!;
};
const expired = (key: string) => {
  const t = mem.exp.get(key);
  if (t && t < Date.now()) { mem.s.delete(key); mem.exp.delete(key); return true; }
  return false;
};

const kv = {
  async hgetall(key: string): Promise<Record<string, unknown>> {
    return redis ? (await redis.hgetall<Record<string, unknown>>(key)) || {} : Object.fromEntries(memHash(key));
  },
  async hget(key: string, field: string): Promise<unknown> {
    return redis ? redis.hget(key, field) : memHash(key).get(field) ?? null;
  },
  async hset(key: string, field: string, value: string) {
    if (redis) await redis.hset(key, { [field]: value });
    else memHash(key).set(field, value);
  },
  async hsetnx(key: string, field: string, value: string): Promise<boolean> {
    if (redis) return (await redis.hsetnx(key, field, value)) === 1;
    const h = memHash(key);
    if (h.has(field)) return false;
    h.set(field, value);
    return true;
  },
  async hdel(key: string, field: string) {
    if (redis) await redis.hdel(key, field);
    else memHash(key).delete(field);
  },
  async get(key: string): Promise<unknown> {
    if (redis) return redis.get(key);
    expired(key);
    return mem.s.get(key) ?? null;
  },
  async set(key: string, value: string) {
    if (redis) await redis.set(key, value);
    else mem.s.set(key, value);
  },
  async setnx(key: string, value: string): Promise<boolean> {
    if (redis) return (await redis.set(key, value, { nx: true })) === "OK";
    if (mem.s.has(key)) return false;
    mem.s.set(key, value);
    return true;
  },
  /** Counter that resets `seconds` after its first increment. */
  async incrWindow(key: string, seconds: number): Promise<number> {
    if (redis) {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, seconds);
      return n;
    }
    expired(key);
    const n = (Number(mem.s.get(key)) || 0) + 1;
    mem.s.set(key, String(n));
    if (n === 1) mem.exp.set(key, Date.now() + seconds * 1000);
    return n;
  },
};

// Upstash returns JSON strings already parsed into objects; memory returns strings. Accept both.
function parse<T>(v: unknown): T | null {
  if (v && typeof v === "object") return v as T;
  if (typeof v !== "string") return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

// ---- users ----
export interface User {
  id: string;
  username: string;
  salt: string | null; // null for Google-only accounts (no password)
  hash: string | null;
  sessionVersion: number;
  createdAt: string;
  via?: string;
}

const USERS = "users"; // field: lowercase username -> JSON user record

export async function findUser(username: string): Promise<User | null> {
  return parse<User>(await kv.hget(USERS, username.toLowerCase()));
}

/** Creates the user only if the name is free. Returns false when it's taken. */
export async function createUser(user: User): Promise<boolean> {
  return kv.hsetnx(USERS, user.username.toLowerCase(), JSON.stringify(user));
}

// ---- per-user ledger ----
const entriesKey = (uid: string) => `u:${uid}:entries`;
const dictKey = (uid: string) => `u:${uid}:dict`;

export async function listEntries(uid: string): Promise<Entry[]> {
  return Object.values(await kv.hgetall(entriesKey(uid))).map(v => parse<Entry>(v)).filter((e): e is Entry => Boolean(e));
}

export async function saveEntry(uid: string, entry: Entry): Promise<Entry> {
  await kv.hset(entriesKey(uid), entry.id, JSON.stringify(entry));
  return entry;
}

export async function getEntry(uid: string, id: string): Promise<Entry | null> {
  return parse<Entry>(await kv.hget(entriesKey(uid), id));
}

export async function deleteEntry(uid: string, id: string) {
  await kv.hdel(entriesKey(uid), id);
}

export async function getDictionary(uid: string): Promise<WordPair[]> {
  const v = parse<WordPair[]>(await kv.get(dictKey(uid)));
  return Array.isArray(v) ? v : [];
}

export async function setDictionary(uid: string, pairs: WordPair[]): Promise<WordPair[]> {
  await kv.set(dictKey(uid), JSON.stringify(pairs));
  return pairs;
}

// ---- the old single-user ledger (passcode version), claimable once ----
const LEGACY_ENTRIES = "ledger:entries";
const LEGACY_DICT = "ledger:dictionary";
const LEGACY_CLAIMED = "ledger:legacy-claimed";

export async function legacyStatus() {
  if (await kv.get(LEGACY_CLAIMED)) return { available: false, count: 0 };
  const count = Object.keys(await kv.hgetall(LEGACY_ENTRIES)).length;
  return { available: count > 0, count };
}

export async function claimLegacy(uid: string) {
  if (!(await kv.setnx(LEGACY_CLAIMED, uid))) return { ok: false, count: 0 };
  let count = 0;
  for (const [id, raw] of Object.entries(await kv.hgetall(LEGACY_ENTRIES))) {
    const e = parse<Entry>(raw);
    if (e) { await kv.hset(entriesKey(uid), id, JSON.stringify(e)); count++; }
  }
  const dict = parse<WordPair[]>(await kv.get(LEGACY_DICT));
  if (Array.isArray(dict) && dict.length) {
    const mine = await getDictionary(uid);
    const seen = new Set(mine.map(p => p.heard.toLowerCase()));
    await setDictionary(uid, [...mine, ...dict.filter(p => !seen.has(String(p.heard).toLowerCase()))]);
  }
  return { ok: true, count };
}

// ---- protection ----
/** Wrong-password counter per username (15-minute window). */
export const noteLoginFailure = (name: string) => kv.incrWindow(`fail:${name.toLowerCase()}`, 15 * 60);
export const loginFailures = async (name: string) => Number(await kv.get(`fail:${name.toLowerCase()}`)) || 0;

/** Per-user budget for AI and speech requests (they share one free Groq allowance). */
export async function useAiBudget(uid: string, limitPerHour = 100): Promise<boolean> {
  const n = await kv.incrWindow(`rl:${uid}:${Math.floor(Date.now() / 3600000)}`, 3600);
  return n <= limitPerHour;
}

/** Cookie-signing secret: SESSION_SECRET if set, otherwise generated once and kept in the database. */
export async function storedSecret(generate: () => string): Promise<string> {
  const existing = await kv.get("ledger:session-secret");
  if (existing) return String(existing);
  await kv.setnx("ledger:session-secret", generate());
  return String(await kv.get("ledger:session-secret"));
}

// ---- Google sign-in identities: "<provider>:<id at provider>" -> lowercase username ----
const IDENTITIES = "identities";

export async function findIdentity(provider: string, sub: string): Promise<User | null> {
  const name = await kv.hget(IDENTITIES, `${provider}:${sub}`);
  return name ? findUser(String(name)) : null;
}

/** Links only if that provider account isn't linked to someone already. */
export const linkIdentity = (provider: string, sub: string, username: string) =>
  kv.hsetnx(IDENTITIES, `${provider}:${sub}`, username.toLowerCase());

/** Which providers are linked to this user. */
export async function identitiesOf(username: string): Promise<string[]> {
  const me = username.toLowerCase();
  return Object.entries(await kv.hgetall(IDENTITIES)).filter(([, v]) => String(v) === me).map(([k]) => k.split(":")[0]);
}
