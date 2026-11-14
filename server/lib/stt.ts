// Speech-to-text with Whisper. Uses Groq's free tier by default (same GROQ_API_KEY as the AI parser).
// Any OpenAI-compatible /audio/transcriptions API works with STT_BASE_URL + STT_API_KEY (+ STT_MODEL).
import { AppError } from "./errors";
import { cachedModel, isModelMissing, replacementModel, type ApiConfig } from "./models";

export function sttConfig(): ApiConfig | null {
  if (process.env.STT_BASE_URL && process.env.STT_API_KEY) {
    return { base: process.env.STT_BASE_URL.replace(/\/$/, ""), key: process.env.STT_API_KEY, model: process.env.STT_MODEL || "whisper-1" };
  }
  if (process.env.GROQ_API_KEY) {
    return { base: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, model: process.env.STT_MODEL || "whisper-large-v3-turbo" };
  }
  return null;
}

// Whisper treats the prompt as "text that came just before", so a short sample in the expected style
// steers it towards these names and words.
// - No numbers: Whisper copies numbers from its prompt into what it "hears".
// - No labels like "Names:": Whisper sometimes copies the start of the prompt into the transcript.
function vocabularyPrompt(names: string[], lang: "en" | "ur", words: string[] = []): string {
  const n = names.slice(0, 40);
  const pick = (i: number, fallback: string) => n[i] || fallback;
  const rest = n.slice(6);
  const also = rest.length ? ` ${lang === "ur" ? "Aur" : "Also"} ${rest.join(", ")}.` : "";
  const extra = words.length ? ` ${words.slice(0, 20).join(", ")}.` : "";
  if (lang === "ur") {
    return `Maine ${pick(0, "Bilal")} ko rupay diye. ${pick(1, "Hamza")} se rupay udhaar liye. ${pick(2, "Saad")} ne paise wapis kiye.${also}${extra}`;
  }
  return `${pick(0, "Bilal")} owes me. I owe ${pick(1, "Hamza")}. I gave ${pick(2, "Ali")} rupees. I lent ${pick(3, "Saad")}. I borrowed from ${pick(4, "Usman")}. ${pick(5, "Zain")} paid me back.${also}${extra}`;
}

/** Removes pieces of the prompt that Whisper sometimes copies to the start of the transcript. */
export function stripPromptLeak(text: unknown, prompt: string): string {
  let t = String(text || "").trim();
  for (let k = 0; k < 4; k++) {
    const before = t;
    const label = t.match(/^(names?|naam|money ledger|hisaab kitaab|ledger)\s*[:&,.;\-–]*\s*/i);
    if (label) {
      t = t.slice(label[0].length);
      if (/^names?|naam/i.test(label[1])) {
        const list = t.match(/^[\p{L}' ,&]+\.\s+/u);
        if (list && t.length > list[0].length + 3) t = t.slice(list[0].length);
      }
    }
    const first = t.match(/^[^.!?]+[.!?]\s+/);
    if (first && prompt.toLowerCase().includes(first[0].trim().toLowerCase()) && t.length > first[0].length + 3) {
      t = t.slice(first[0].length);
    }
    if (t === before) break;
  }
  return t.trim();
}

// Whisper sometimes "hears" these on silence or noise.
const PHANTOMS = /^(?:thank you\.?|thanks for watching\.?|thank you for watching\.?|you\.?|bye\.?|\.+|subtitles by .*|please subscribe\.?)$/i;

export interface TranscribeInput {
  audio: Buffer;
  mimeType: string;
  filename: string;
  lang: "en" | "ur";
  names: string[];
  words?: string[];
}

export async function transcribe(input: TranscribeInput, retried = false): Promise<string> {
  const cfg = sttConfig();
  if (!cfg) throw new AppError("Accurate speech isn't set up.", "not_configured");
  const { audio, mimeType, filename, lang, names, words = [] } = input;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType || "audio/webm" }), filename);
  const model = cachedModel(cfg, "stt");
  form.append("model", model);
  const prompt = vocabularyPrompt(names, lang, words);
  form.append("prompt", prompt);
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("language", lang);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${cfg.base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form,
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new AppError("The free speech limit is used up for now. Try again in a minute, or type instead.", "rate_limited");
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (!retried && isModelMissing(res.status, detail)) {
        clearTimeout(timer);
        if (await replacementModel(cfg, "stt", model)) return transcribe(input, true);
      }
      throw new AppError(`Speech service failed (${res.status}).`, "stt_error", detail);
    }
    const data = (await res.json()) as { text?: string };
    const text = stripPromptLeak(data.text, prompt);
    return PHANTOMS.test(text) ? "" : text;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new AppError("The speech service took too long.", "timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
