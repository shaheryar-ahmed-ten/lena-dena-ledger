// Ledger rules shared by client and server.
import type { EntryInput, Kind } from "./types";

// sign +1: increases what the person owes you; -1: increases what you owe them.
export const KINDS: Record<Kind, { sign: 1 | -1; tag: string; label: string }> = {
  lent: { sign: 1, tag: "Lent", label: "I lent money" },
  borrowed: { sign: -1, tag: "Borrowed", label: "I borrowed money" },
  received: { sign: -1, tag: "Repaid", label: "They paid me back" },
  paid: { sign: 1, tag: "Repaid", label: "I paid them back" },
};

export const isKind = (k: unknown): k is Kind => typeof k === "string" && k in KINDS;

export const personKey = (s: unknown) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

export interface Balance {
  key: string;
  name: string;
  net: number;
  count: number;
}

export function balances(entries: { person: string; kind: Kind; amount: number }[]): Map<string, Balance> {
  const map = new Map<string, Balance>();
  for (const e of entries) {
    const k = personKey(e.person);
    if (!k) continue;
    const cur = map.get(k) || { key: k, name: e.person.trim(), net: 0, count: 0 };
    cur.net += (KINDS[e.kind]?.sign || 0) * (Number(e.amount) || 0);
    cur.count++;
    map.set(k, cur);
  }
  return map;
}

export function validateEntry(body: any): { value: EntryInput; error?: undefined } | { error: string; value?: undefined } {
  const person = String(body?.person ?? "").trim().replace(/\s+/g, " ");
  const amount = Math.round(Number(body?.amount));
  const kind = String(body?.kind ?? "");
  const note = String(body?.note ?? "").trim();
  const date = String(body?.date ?? "");
  if (!person || person.length > 60) return { error: "Enter a name up to 60 characters." };
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) return { error: "Enter an amount above zero." };
  if (!isKind(kind)) return { error: "Choose what happened." };
  if (note.length > 200) return { error: "Keep the note under 200 characters." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Pick a valid date." };
  return { value: { person, amount, kind, note, date } };
}
