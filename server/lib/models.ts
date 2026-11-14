// Providers retire model names over time (a retired name returns 404). When that happens,
// ask the provider which models exist and pick the best available one automatically.

export interface ApiConfig { base: string; key: string; model: string }
type Purpose = "chat" | "stt";

const cache = new Map<string, string>(); // `${base}|${purpose}` -> model id (lives while the server instance is warm)

const CHAT_PREFS = [/llama-3\.3-70b/, /gpt-oss-120b/, /llama-4-maverick/, /llama-4-scout/, /kimi-k2/, /qwen3?-32b/, /gemini-2\.5-flash(?!-lite)/, /gemini-.*flash/, /70b/, /gpt-oss-20b/, /llama-3\.1-8b/];
const CHAT_EXCLUDE = /whisper|guard|tts|embed|audio|speech|orpheus|playai|moderation|image|vision-only|compound|prompt-guard|transcribe/i;
const STT_PREFS = [/whisper-large-v3-turbo/, /distil-whisper/, /whisper-large-v3/, /whisper/];

export async function listModels(cfg: ApiConfig): Promise<string[]> {
  const res = await fetch(`${cfg.base}/models`, { headers: { Authorization: `Bearer ${cfg.key}` } });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
  return (data.data || []).map(m => String(m.id || "").replace(/^models\//, "")).filter(Boolean);
}

export function pickModel(ids: string[], purpose: Purpose): string | null {
  const pool = purpose === "stt" ? ids.filter(id => /whisper/i.test(id)) : ids.filter(id => !CHAT_EXCLUDE.test(id));
  for (const re of purpose === "stt" ? STT_PREFS : CHAT_PREFS) {
    const hit = pool.find(id => re.test(id));
    if (hit) return hit;
  }
  return pool[0] || null;
}

export const cachedModel = (cfg: ApiConfig, purpose: Purpose) => cache.get(`${cfg.base}|${purpose}`) || cfg.model;

/** True when the provider says the model name is unknown or retired. */
export const isModelMissing = (status: number, body: string) =>
  status === 404 || (status === 400 && /model|decommission|not.?found|does not exist/i.test(body || ""));

export async function replacementModel(cfg: ApiConfig, purpose: Purpose, failed: string): Promise<string | null> {
  const ids = await listModels(cfg).catch(() => [] as string[]);
  const pick = pickModel(ids.filter(id => id !== failed), purpose);
  if (pick) {
    cache.set(`${cfg.base}|${purpose}`, pick);
    console.warn(`Model "${failed}" is unavailable; switched to "${pick}". Set ${purpose === "stt" ? "STT_MODEL" : "AI_MODEL"} to choose one yourself.`);
  }
  return pick;
}
