// Turns a spoken (or typed) English sentence into draft ledger entries.
// Rule-based and offline: every draft is shown for review before saving,
// so a wrong guess is fixed by the user, never saved silently.
//
//   "Ali owes me 2500 for the ground booking"        -> lent 2500 to Ali
//   "I borrowed 1200 from Hamza yesterday for lunch" -> borrowed 1200 from Hamza
//   "Bilal paid me back 1000 and I owe Saad 300"     -> two drafts

import type { Draft, Kind, WordPair } from "./types";

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000, million: 1000000 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// "two thousand five hundred" -> "2500" (speech engines usually give digits, but not always)
export function wordsToDigits(text: string): string {
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  const isNumWord = (t: string) => {
    const w = t.toLowerCase().replace(/-/g, "");
    return w in UNITS || w in TENS || w in SCALES || /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-?(one|two|three|four|five|six|seven|eight|nine)$/.test(t.toLowerCase());
  };
  while (i < tokens.length) {
    const t = tokens[i];
    const startsRun = (isNumWord(t) && !(t.toLowerCase() in SCALES)) || (/^a$/i.test(t) && tokens[i + 2] && /^(hundred|thousand|lakh|lac)$/i.test(tokens[i + 2]));
    if (!startsRun || /^\s+$/.test(t)) { out.push(t); i++; continue; }
    let total = 0, current = 0, j = i, used = false;
    while (j < tokens.length) {
      const raw = tokens[j];
      if (/^\s+$/.test(raw)) { j++; continue; }
      const w = raw.toLowerCase();
      if (w === "a" && !used) { current = 1; used = true; j++; continue; }
      if (w === "and" && used && tokens[j + 2] && isNumWord(tokens[j + 2])) { j++; continue; }
      const hy = w.match(/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)$/);
      if (hy) { current += TENS[hy[1]] + UNITS[hy[2]]; used = true; j++; continue; }
      if (w in UNITS) { current += UNITS[w]; used = true; j++; continue; }
      if (w in TENS) { current += TENS[w]; used = true; j++; continue; }
      if (w === "hundred") { current = (current || 1) * 100; used = true; j++; continue; }
      if (w in SCALES) { total += (current || 1) * SCALES[w]; current = 0; used = true; j++; continue; }
      break;
    }
    // drop trailing whitespace tokens we skipped so spacing stays intact
    let end = j;
    while (end > i && /^\s+$/.test(tokens[end - 1])) end--;
    out.push(String(total + current));
    i = end;
  }
  return out.join("");
}

const AMOUNT_RE = /(?:\b(?:rs|pkr)\.?\s*|[$₹]\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b|hundred\b|lakhs?\b|lacs?\b)?\s*(?:rupees?\b|rupee's\b|ruppees?\b|rupes\b|groupies\b|rs\b\.?|pkr\b|bucks\b|dollars?\b)?/i;

function takeAmount(s: string): { amount: number | null; rest: string } {
  const m = s.match(AMOUNT_RE);
  if (!m) return { amount: null, rest: s };
  let n = Number(m[1].replace(/,/g, ""));
  const scale = (m[2] || "").toLowerCase();
  if (scale === "k" || scale === "thousand") n *= 1000;
  else if (scale === "hundred") n *= 100;
  else if (scale.startsWith("lakh") || scale.startsWith("lac")) n *= 100000;
  const at = m.index ?? 0;
  return { amount: Math.round(n), rest: s.slice(0, at) + " " + s.slice(at + m[0].length) };
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromIso(s: string): Date { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }

function takeDate(s: string, today: string): { date: string | null; rest: string } {
  const base = fromIso(today);
  const shift = (n: number) => { const d = new Date(base); d.setDate(d.getDate() - n); return iso(d); };
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\b(?:the )?day before yesterday\b/i))) return { date: shift(2), rest: s.replace(m[0], " ") };
  if ((m = s.match(/\b(?:yesterday|last night)\b/i))) return { date: shift(1), rest: s.replace(m[0], " ") };
  if ((m = s.match(/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i))) return { date: today, rest: s.replace(m[0], " ") };
  if ((m = s.match(/\b(\d+) days? ago\b/i))) return { date: shift(Number(m[1])), rest: s.replace(m[0], " ") };
  if ((m = s.match(/\blast week\b/i))) return { date: shift(7), rest: s.replace(m[0], " ") };
  if ((m = s.match(new RegExp(`\\b(on |last |this )?(${DAYS.join("|")})\\b`, "i")))) {
    const target = DAYS.indexOf(m[2].toLowerCase());
    let back = (base.getDay() - target + 7) % 7;
    if (back === 0 && /last/i.test(m[1] || "")) back = 7;
    return { date: shift(back), rest: s.replace(m[0], " ") };
  }
  return { date: null, rest: s };
}

function takeNote(s: string): { note: string; rest: string } {
  // "for petrol", but not "I paid for Ali" (that's who, not why)
  const m = s.match(/(?<!\b(?:paid|spent|covered|pay) )\b(?:for|because of|towards)\s+(.+)$/i);
  if (!m) return { note: "", rest: s };
  return { note: m[1].trim().replace(/[.,;!?]+$/, "").replace(/^(?:the|a|an|some)\s+/i, ""), rest: s.slice(0, m.index ?? 0) };
}

const FILLER = /\b(?:please|um+|uh+|okay|ok|so|just|like|basically|actually|money|cash|amount of|an amount|of|the sum)\b/gi;
const LEAD = /^(?:names?\s*&?|(?:hey|hi|add|note|record|write|put|save|log)(?: (?:an|a|new))?(?: entry| down| that)?(?: that)?|that|and|also|then|plus)\s+/i;

function clean(s: string): string {
  let c = " " + s.toLowerCase().replace(/[’']/g, "'").replace(/i've\b/g, "i have").replace(/i'm\b/g, "i am").replace(/i'll\b/g, "i will") + " ";
  c = c.replace(FILLER, " ").replace(/[,.;!?"]/g, " ").replace(/\s+/g, " ").trim();
  for (let k = 0; k < 3; k++) c = c.replace(LEAD, "");
  return c.trim();
}

// [regex, kind or function(match) -> kind, which group holds the person (default 1)].
type Rule = [RegExp, Kind | ((m: RegExpMatchArray) => Kind), number?];
const RULES: Rule[] = [
  [/^(.+?) (?:owes|owe|owed) (?:me|us)(?: back)?$/, "lent"],
  [/^(.+?) (?:owes|owed)$/, "lent"], // "Bilal owes 1000"
  [/^(.+?) (?:has|have|needs?|should|will|is going|are going) to (?:pay|give|return) (?:me|us)(?: back)?$/, "lent"],
  [/^i (?:owe|owed) (?:to )?(.+)$/, "borrowed"],
  [/^i (?:have|need|should|will|am going|must) to (?:pay|give|return) (?:back )?(?:to )?(.+?)(?: back)?$/, "borrowed"],
  [/^i (?:paid|spent|covered|pay) (?:for|on) (.+)$/, "lent"],
  [/^i (?:lent|loaned|lend|leant) (?:to )?(.+)$/, "lent"],
  [/^i (returned|repaid|paid back|gave back|sent back|paid|gave|sent|transferred) (?:back )?(?:to )?(.+?)( back)?$/,
    m => (/returned|repaid|back|^paid$/.test(m[1]) || m[3] ? "paid" : "lent"), 2],
  [/^i (?:borrowed|borrow|took|take|taken) (?:from )?(.+)$/, "borrowed"],
  [/^i (received|collected|got|get|recovered) (?:back )?(?:from )?(.+?)( back)?$/,
    m => (m[1] === "got" || m[1] === "get") && !m[3] && !/back/.test(m[0]) ? "borrowed" : "received", 2],
  [/^(.+?) (lent|loaned|gave|sent|transferred|paid|returned|repaid|gave back|paid back|sent back) (?:to )?(?:me|us)( back)?$/,
    m => /lent|loaned/.test(m[2]) ? "borrowed" : /paid|returned|repaid|back/.test(m[2]) || m[3] ? "received" : "borrowed"],
  [/^(.+?) (?:paid|returned|repaid|cleared|settled)(?: up| back| it back| it| his dues| her dues| dues)?$/, "received"],
  [/^(?:received|got|collected) (?:back )?from (.+)$/, "received"],
  [/^(?:lent|gave|loaned) (?:to )?(.+)$/, "lent"],
  [/^(?:borrowed|took) from (.+)$/, "borrowed"],
];

// Words speech recognition often mishears in this context. Tried only when no rule matched,
// and the draft is marked so the review screen asks the user to check it.
const OWES_LIKE = "post|posts|owns|own|goes|ohs|o's|oh's|os|knows|nose|holes|those|ose|ows|owe's|blows|rose|rows|close|oaths?|both|boast|most|hose|holds|hold|folds|rolls|loads|roads|codes|homes|hopes|oats|notes|owls|oz|oh is|o is";
const SOUNDALIKES: [RegExp, string, string, string][] = [
  // [pattern, replacement, what it now reads as, the word to offer for the word list]
  [/^i (?:came|game|gay|gate|cave|gaze|gain|cake|give|gives|kave|gay of)\b/, "i gave", "gave", "gave"],
  [/^i (?:land|lands|lens|lint|lend it|lead|meant|blend|leaned)\b/, "i lent", "lent", "lent"],
  [/^i (?:o|oh|own|owned|old|ow|or|all|oh to|hold|holds|load)\b/, "i owe", "owe", "owe"],
  [/^i (?:barred|bored|burrowed|barrowed|borrow it|bar rowed|bought)\b/, "i borrowed", "borrowed", "borrowed"],
  [new RegExp(`^(.+?) (?:${OWES_LIKE})(?: to)?(?: me| us)?$`), "$1 owes me", "owes me", "owes"],
  [/^(.+?) (?:pay|pays|pet|played|paste|based|baked|page) (?:me|us)(?: back)?$/, "$1 paid me back", "paid me back", "paid"],
  [/^(.+?) (?:returns|return|retained|we turned|re turned)$/, "$1 returned", "returned", "returned"],
  [/^i (?:pay|pet|played|paste|page)( back)? /, "i paid$1 ", "paid", "paid"],
];

function matchRules(c: string): { kind: Kind; person: string } | null {
  for (const [re, k, group = 1] of RULES) {
    const m = c.match(re);
    if (m) return { kind: typeof k === "function" ? k(m) : k, person: cleanName(m[group]) };
  }
  return null;
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

function cleanName(raw: string): string {
  let n = raw.trim()
    .replace(/^(?:to|from|the|my|our)\s+/i, "")
    .replace(/^(?:friend|cousin|brother|sister|colleague|teammate)\s+/i, "")
    .replace(/\s+(?:back|now|already|me|us|to me|from me)$/i, "")
    .replace(/'s$|s'$/i, "")
    .trim();
  if (!n || n.split(" ").length > 4 || /^(i|me|you|he|she|they|we|him|her|them)$/i.test(n)) return "";
  return titleCase(n);
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function matchKnown(name: string, known: string[]): string {
  if (!name) return name;
  const low = name.toLowerCase();
  const exact = known.find(k => k.toLowerCase() === low);
  if (exact) return exact;
  // "Bilaal" -> "Bilal", "hamsa" -> "Hamza": a close spelling of someone already in the ledger
  const limit = low.length >= 7 ? 2 : low.length >= 4 ? 1 : 0;
  if (!limit) return name;
  const close = known
    .map(k => ({ k, d: editDistance(k.toLowerCase(), low) }))
    .filter(x => x.d <= limit)
    .sort((a, b) => a.d - b.d);
  return close.length && (close.length === 1 || close[0].d < close[1].d) ? close[0].k : name;
}

function parseClause(text: string, today: string) {
  let s = wordsToDigits(text);
  const d = takeDate(s, today); s = d.rest;
  const n = takeNote(s); s = n.rest;
  const a = takeAmount(s); s = a.rest;
  const c = clean(s);
  let hit = matchRules(c);
  let hint = "";
  let fixPair: WordPair | null = null;
  if (!hit) {
    for (const [re, rep, word, meant] of SOUNDALIKES) {
      if (!re.test(c)) continue;
      const fixed = c.replace(re, rep);
      const h = matchRules(fixed);
      if (h) {
        const heardWord = ((c.match(re) as RegExpMatchArray)[0].replace(/^i /, "").split(" ").find(w => !fixed.split(" ").includes(w))) || "";
        hit = h; hint = `Heard “${heardWord || c}”, read it as “${word}”. Check this.`;
        if (heardWord && heardWord !== meant) fixPair = { heard: heardWord, meant };
        break;
      }
    }
  }
  const kind = hit ? hit.kind : null;
  const person = hit ? hit.person : cleanName(c); // a bare name, e.g. "... and Bilal 300"
  return { kind, person, amount: a.amount, date: d.date, note: n.note, raw: text.trim(), hasVerb: Boolean(kind), bare: c, hint, fixPair };
}

const SPLIT = /\s*(?:[;!?]|\.(?=\s|$)|,\s+(?:and\s+)?|\s+and\s+(?:then\s+|also\s+)?|\s+also\s+|\s+then\s+|\s+plus\s+)\s*/i;

export interface ParseOptions {
  today?: string;
  knownPeople?: string[];
}

export function parseUtterance(text: string, { today, knownPeople = [] }: ParseOptions = {}): Draft[] {
  const day = today || iso(new Date());
  const parts = String(text || "").split(SPLIT).map(p => p.trim()).filter(Boolean);
  const drafts: Draft[] = [];
  let lastDate: string | null = null;
  for (const part of parts) {
    const p = parseClause(part, day);
    const prev = drafts[drafts.length - 1];
    if (!p.hasVerb && p.amount == null) {
      // "for petrol and snacks" -> "snacks" belongs to the previous note
      if (prev && p.bare) { prev.note = prev.note ? `${prev.note} and ${p.bare}` : p.bare; prev.raw = `${prev.raw ?? ""} and ${part}`; continue; }
      if (!p.bare) continue;
    }
    const kind = !p.hasVerb && prev ? prev.kind : p.kind; // "Ali owes me 500 and Bilal 300"
    if (p.date) lastDate = p.date;
    drafts.push({ kind, person: matchKnown(p.person, knownPeople), amount: p.amount, date: p.date || lastDate || day, note: p.note, raw: p.raw, hint: p.hint || "", fixPair: p.fixPair || null });
  }
  // A stray fragment with no action and no amount ("Bilal." on its own) is noise when the
  // sentence also contains a real entry.
  const useful = drafts.some(d => d.kind && Number(d.amount) > 0);
  const kept = useful ? drafts.filter(d => d.kind || Number(d.amount) > 0) : drafts;
  return kept.map(d => ({ ...d, issues: issuesFor(d) }));
}

export function issuesFor(d: Pick<Draft, "kind" | "person" | "amount">): string[] {
  const out: string[] = [];
  if (!d.kind) out.push("Choose what happened");
  if (!d.person) out.push("Add a name");
  if (!(Number(d.amount) > 0)) out.push("Add an amount");
  return out;
}

// How much a set of drafts looks like a real, complete ledger entry.
export function scoreDrafts(drafts: Draft[], knownPeople: string[] = []): number {
  if (!drafts.length) return -10;
  const known = new Set(knownPeople.map(k => k.toLowerCase()));
  let score = 0;
  for (const d of drafts) {
    if (d.kind) score += d.hint ? 2 : 3;
    if (Number(d.amount) > 0) score += 3;
    if (d.person) score += 1;
    if (d.person && known.has(d.person.toLowerCase())) score += 2;
    if (d.person && d.person.split(" ").length > 2) score -= 2; // "Hello How Are You" isn't a name
    score -= 2 * issuesFor(d).length;
  }
  return score / Math.sqrt(drafts.length);
}

// Speech engines return several guesses; keep the one that reads best as an entry.
// Ties go to the engine's own first guess.
export function pickBestTranscript(candidates: string[], opts: ParseOptions = {}) {
  let best: { text: string; drafts: Draft[]; score: number } | null = null;
  for (const text of candidates) {
    const t = String(text || "").trim();
    if (!t) continue;
    const drafts = parseUtterance(t, opts);
    const score = scoreDrafts(drafts, opts.knownPeople);
    if (!best || score > best.score + 0.01) best = { text: t, drafts, score };
  }
  return best;
}

// The user's own word list: "when you hear X, I said Y". Whole words/phrases, case-insensitive,
// longest first so "oh is" wins over "oh". Returns the fixed text and what was changed.
export function applyDictionary(text: string, pairs: WordPair[] = []): { text: string; applied: WordPair[] } {
  let out = String(text || "");
  const applied: WordPair[] = [];
  const sorted = pairs
    .filter(p => p && typeof p.heard === "string" && p.heard.trim())
    .sort((a, b) => b.heard.length - a.heard.length);
  for (const { heard, meant } of sorted) {
    const esc = heard.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(`(^|[^\\p{L}\\p{N}'])(${esc})(?=$|[^\\p{L}\\p{N}'])`, "giu");
    let hit = false;
    out = out.replace(re, (_m: string, pre: string) => { hit = true; return pre + (meant || ""); });
    if (hit) applied.push({ heard: heard.trim(), meant: meant || "" });
  }
  return { text: out.replace(/\s{2,}/g, " ").trim(), applied };
}
