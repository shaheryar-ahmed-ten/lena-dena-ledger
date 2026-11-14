// Turns a sentence (or a correction) into ledger drafts with a free-tier LLM.
// Any OpenAI-compatible chat API works. Set ONE of these:
//   GROQ_API_KEY    -> https://console.groq.com/keys
//   GEMINI_API_KEY  -> https://aistudio.google.com/apikey
// Optional: AI_MODEL, or AI_BASE_URL + AI_API_KEY for another compatible provider.
import { isKind } from "../../shared/ledger";
import type { Draft, Kind } from "../../shared/types";
import { AppError } from "./errors";
import { cachedModel, isModelMissing, replacementModel, type ApiConfig } from "./models";

const PROVIDERS: Record<string, { base: string; model: string; key: () => string | undefined }> = {
  groq: { base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key: () => process.env.GROQ_API_KEY },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", key: () => process.env.GEMINI_API_KEY },
};

export function aiConfig(): (ApiConfig & { name: string }) | null {
  if (process.env.AI_API_KEY && process.env.AI_BASE_URL) {
    return { name: "custom", base: process.env.AI_BASE_URL.replace(/\/$/, ""), key: process.env.AI_API_KEY, model: process.env.AI_MODEL || "" };
  }
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const key = p.key();
    if (key) return { name, base: p.base, key, model: process.env.AI_MODEL || p.model };
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function systemPrompt(today: string, knownPeople: string[]): string {
  const [y, m, d] = today.split("-").map(Number);
  const weekday = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `You turn what a user in Karachi says about money between them and friends into ledger entries.
The user may speak English, Urdu, or Roman Urdu, or mix them. Speech-to-text may mishear words and names.

Each entry has:
- kind: one of
  "lent"     = the user gave/lent money; the other person now owes the user ("Ali owes me 500", "maine Ali ko 500 diye", "I paid for Ali's ticket")
  "borrowed" = the user took/borrowed money; the user now owes them ("I owe Hamza 1200", "Hamza se 1200 liye", "Hamza paid for my lunch")
  "received" = the other person paid the user back ("Bilal returned 1000", "Bilal ne 1000 wapis kar diye")
  "paid"     = the user paid the other person back ("I returned Saad's 800", "maine Saad ko 800 wapis diye")
- person: the other person's name, Title Case. If it sounds like one of these existing names, use that exact spelling: ${knownPeople.length ? knownPeople.join(", ") : "(none yet)"}
- amount: whole number of Pakistani rupees ("2k" = 2000, "1.5 lakh" = 150000, "dhai hazaar" = 2500, "sawa sau" = 125)
- date: YYYY-MM-DD. Today is ${today} (${weekday}). "yesterday"/"kal" (past tense) = the day before today. Use today if no date is said.
- note: short reason in English, lowercase, e.g. "ground booking", "lunch" ("" if none)

One sentence may describe several entries; return each separately. "Ali owes me 500 and Bilal 300" = two "lent" entries.
"Ali still hasn't returned my 500" means Ali owes the user 500 ("lent"), not a repayment.
The text comes from speech recognition and often contains sound-alike mistakes. Read it for what the user most likely SAID:
"came"/"game" = "gave", "post"/"owns"/"goes"/"knows" = "owes", "own"/"oh" = "owe", "pay me" = "paid me", "barred" = "borrowed", "groupies" = "rupees".
When several recognition guesses are given, use them together: they often disagree on exactly the misheard word or number, and the right one is usually among them.
If something is missing or unclear, leave that field null rather than guessing wildly.

Reply with JSON only: {"entries":[{"kind":...,"person":...,"amount":...,"date":...,"note":...}]}`;
}

function correctionPrompt(drafts: Partial<Draft>[]): string {
  return `The user is reviewing these draft entries (numbered from 1) and has asked for a change:
${JSON.stringify(drafts.map((d, i) => ({ n: i + 1, kind: d.kind, person: d.person, amount: d.amount, date: d.date, note: d.note })))}

Apply their instruction and return the FULL updated list in the same JSON format, without the "n" field.
Keep every entry they didn't mention exactly as it is. They may refer to an entry by number ("the second one"), by person, or by amount.
They can change any field, remove an entry, or add one. If the instruction is a fresh description of a transaction, add it as a new entry.`;
}

type Message = { role: "system" | "user"; content: string };

async function chat(cfg: ApiConfig, messages: Message[], retried = false): Promise<unknown> {
  const model = cachedModel(cfg, "chat");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model, messages, temperature: 0, response_format: { type: "json_object" } }),
    });
    if (res.status === 429) throw new AppError("The free AI limit is used up for now. Try again in a minute.", "rate_limited");
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (!retried && isModelMissing(res.status, detail)) {
        clearTimeout(timer);
        if (await replacementModel(cfg, "chat", model)) return chat(cfg, messages, true);
      }
      throw new AppError(`AI request failed (${res.status}).`, "ai_error", detail);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const json = (data.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/);
    if (!json) throw new AppError("The AI reply wasn't understood.", "bad_reply");
    return JSON.parse(json[0]);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new AppError("The AI took too long to answer.", "timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface AiDraft { kind: Kind | null; person: string; amount: number | null; date: string; note: string }

/** The model's reply is untrusted: keep only well-formed fields, drop the rest. */
export function sanitize(raw: any, today: string): AiDraft[] {
  const list: any[] = Array.isArray(raw?.entries) ? raw.entries : [];
  return list.slice(0, 20).map(e => {
    const n = Math.round(Number(e?.amount));
    return {
      kind: isKind(e?.kind) ? e.kind : null,
      person: typeof e?.person === "string" ? e.person.trim().replace(/\s+/g, " ").slice(0, 60) : "",
      amount: Number.isFinite(n) && n > 0 && n <= 1e10 ? n : null,
      date: typeof e?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : today,
      note: typeof e?.note === "string" ? e.note.trim().slice(0, 200) : "",
    };
  });
}

export async function aiParse(opts: { text: string; today: string; knownPeople: string[]; drafts: Partial<Draft>[] | null; alternatives?: string[] }): Promise<AiDraft[]> {
  const cfg = aiConfig();
  if (!cfg) throw new AppError("AI isn't set up.", "not_configured");
  const { text, today, knownPeople, drafts, alternatives = [] } = opts;
  const messages: Message[] = [{ role: "system", content: systemPrompt(today, knownPeople) }];
  if (drafts) messages.push({ role: "system", content: correctionPrompt(drafts) });
  const others = alternatives.filter(a => a && a !== text);
  messages.push({
    role: "user",
    content: others.length ? `Speech recognition's best guess: ${text}\nOther guesses for the same speech:\n${others.map(a => `- ${a}`).join("\n")}` : text,
  });
  return sanitize(await chat(cfg, messages), today);
}
