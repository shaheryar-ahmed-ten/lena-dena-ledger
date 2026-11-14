// "Say it": speak or type a sentence, review the drafts it turns into, correct them, then save.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { KINDS } from "../../../shared/ledger";
import { applyDictionary, issuesFor, matchKnown, parseUtterance, pickBestTranscript } from "../../../shared/parse";
import type { Draft, EntryInput, Kind, WordPair } from "../../../shared/types";
import { api, ApiError, today } from "../api";
import { canRecord, startRecorder, type RecorderSession } from "../recorder";

type ReviewDraft = Draft & { issues: string[] };
type LangKey = "en" | "us" | "ur";
type Target = "new" | "fix";

const EXAMPLES = [
  "Bilal owes me 2,500 for the ground booking",
  "I borrowed 1,200 from Hamza yesterday for lunch",
  "Saad paid me back 800 and I owe Usman 300",
];
const AI_EXAMPLES = [
  "Ali still hasn't returned the 500 I gave him for the ball",
  "Maine Hamza se kal 1200 liye the lunch ke liye",
];
const FIX_EXAMPLES = ["Make Hamza's 1300", "It was yesterday", "Remove the second one", "Change the note to petrol"];

// Which accent model the browser listens with. Desi English is usually heard best by en-IN;
// some voices do better with en-US, so it's a choice. Urdu needs AI (the basic rules read English).
const LANGS: Record<LangKey, { code: string; stt: "en" | "ur"; label: string; browserOnly?: boolean; needsAi?: boolean }> = {
  en: { code: "en-IN", stt: "en", label: "English (Pakistan/India)" },
  us: { code: "en-US", stt: "en", label: "English (US)", browserOnly: true },
  ur: { code: "ur-PK", stt: "ur", label: "اردو Urdu", needsAi: true },
};

// Speech engines return up to N guesses per phrase. Build whole-sentence candidates:
// the top guess, then the top guess with one phrase swapped for each of its alternatives.
function candidatesFrom(results: { alts: string[] }[]): string[] {
  const finals = results.filter(r => r.alts.length);
  const top = finals.map(r => r.alts[0]).join(" ").trim();
  const out: string[] = [top];
  finals.forEach((r, i) => r.alts.slice(1).forEach(alt => {
    out.push(finals.map((x, j) => (j === i ? alt : x.alts[0])).join(" ").trim());
  }));
  return [...new Set(out.filter(Boolean))].slice(0, 6);
}

const MIC_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it for this site in your browser settings, or type instead.",
  "service-not-allowed": "Microphone access is blocked. Allow it for this site in your browser settings, or type instead.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  "audio-capture": "No microphone was found. Check that one is connected, or type instead.",
  "language-not-supported": "This browser can't listen in that language. Switch to English or type instead.",
  network: "Voice input needs an internet connection. Type instead.",
};

const withIssues = (list: Draft[]): ReviewDraft[] => list.map(d => ({ ...d, issues: issuesFor(d) }));

function MicIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>;
}

interface Props {
  knownPeople: string[];
  onSave: (list: EntryInput[]) => Promise<{ saved: number; error?: string }>;
}

export default function VoiceEntry({ knownPeople, onSave }: Props) {
  const [browserSR, setBrowserSR] = useState(false);
  const [whisper, setWhisper] = useState(false); // accurate speech (Whisper) available on the server
  const [whisperDown, setWhisperDown] = useState(false); // failed this visit: use the browser engine instead
  const [recSecs, setRecSecs] = useState(0);
  const [ai, setAi] = useState<boolean | null>(null); // null = checking, false = off, true = on
  const [lang, setLang] = useState<LangKey>("en");
  const [listening, setListening] = useState<Target | null>(null); // null | "new" | "fix"
  const [text, setText] = useState("");
  const [fix, setFix] = useState("");
  const [interim, setInterim] = useState("");
  const [alts, setAlts] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ReviewDraft[] | null>(null);
  const [source, setSource] = useState<"ai" | "rules" | null>(null); // "ai" | "rules"
  const [thinking, setThinking] = useState(false);
  const [msg, setMsg] = useState({ text: "", err: false });
  const [saving, setSaving] = useState(false);
  const [dict, setDict] = useState<WordPair[]>([]);           // the user's word list: [{ heard, meant }]
  const [applied, setApplied] = useState<WordPair[]>([]);     // word-list fixes used on the current sentence
  const [newHeard, setNewHeard] = useState("");
  const [newMeant, setNewMeant] = useState("");
  const recRef = useRef<SpeechRecognition | null>(null);
  const recorderRef = useRef<RecorderSession | null>(null);
  const finalRef = useRef<{ alts: string[] }[]>([]);

  useEffect(() => {
    setBrowserSR(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
    try { const l = localStorage.getItem("ledger-voice-lang"); if (l && l in LANGS) setLang(l as LangKey); } catch { /* storage blocked */ }
    api<{ pairs: WordPair[] }>("/api/dictionary").then(d => setDict(d.pairs || [])).catch(() => {});
    api<{ enabled: boolean; whisper: boolean }>("/api/parse").then(d => {
      setAi(Boolean(d.enabled));
      setWhisper(Boolean(d.whisper) && canRecord());
    }).catch(() => setAi(false));
    return () => { recRef.current?.abort(); recorderRef.current?.cancel(); };
  }, []);

  const useWhisper = whisper && !whisperDown;
  const supported = useWhisper || browserSR;
  const langOptions = (Object.entries(LANGS) as [LangKey, (typeof LANGS)[LangKey]][]).filter(([, v]) => (!v.needsAi || ai) && !(v.browserOnly && useWhisper));

  function chooseLang(l: LangKey) {
    setLang(l);
    try { localStorage.setItem("ledger-voice-lang", l); } catch { /* storage blocked */ }
  }

  async function askAi(body: { text: string; alternatives?: string[]; drafts?: Draft[] }): Promise<Draft[]> {
    const data = await api<{ entries: Draft[] }>("/api/parse", { method: "POST", json: { ...body, today: today(), knownPeople } });
    return data.entries.map(e => ({ ...e, person: matchKnown(e.person, knownPeople) }));
  }

  function rulesParse(s: string): Draft[] {
    return parseUtterance(s, { today: today(), knownPeople }).map(({ issues: _i, raw: _r, ...d }) => d);
  }

  // Pick the guess that reads most like a ledger entry, and keep the others as one-tap options.
  function reviewHeard(candidates: string[]) {
    const fixedToOriginal = new Map(candidates.map(c => [applyDictionary(c, dict).text, c]));
    const best = pickBestTranscript([...fixedToOriginal.keys()], { today: today(), knownPeople });
    review((best && fixedToOriginal.get(best.text)) || candidates[0], candidates);
  }

  async function saveDict(pairs: WordPair[], okText: string): Promise<boolean> {
    const before = dict;
    setDict(pairs);
    try {
      const data = await api<{ pairs: WordPair[] }>("/api/dictionary", { method: "PUT", json: { pairs } });
      setDict(data.pairs);
      if (okText) setMsg({ text: okText, err: false });
      return true;
    } catch {
      setDict(before);
      setMsg({ text: "Couldn't update your word list. Try again.", err: true });
      return false;
    }
  }

  function addPair(heard: string, meant: string, draftIndex?: number) {
    const h = heard.trim(), m = meant.trim();
    if (!h) return;
    const rest = dict.filter(p => p.heard.toLowerCase() !== h.toLowerCase());
    saveDict([{ heard: h, meant: m }, ...rest], `Added to your word list: “${h}” will be read as “${m}”.`).then(ok => {
      if (ok && draftIndex != null) setDrafts(list => list && list.map((d, j) => (j === draftIndex ? { ...d, hint: "", fixPair: null } : d)));
    });
  }

  function removePair(heard: string) {
    saveDict(dict.filter(p => p.heard !== heard), `Removed “${heard}” from your word list.`);
  }

  function announce(list: Draft[], prefix = "") {
    const bad = list.some(d => issuesFor(d).length);
    setMsg({
      text: prefix + (!list.length ? "Nothing to save. Say it again or add an entry by hand."
        : bad ? "Check the highlighted fields, then save."
        : `Found ${list.length} ${list.length === 1 ? "entry" : "entries"}. Check ${list.length === 1 ? "it" : "them"}, then save.`),
      err: false,
    });
  }

  // `candidates` are the speech engine's other guesses for the same words (empty when typed).
  async function review(sentence: string, candidates: string[] = []) {
    const s = sentence.trim();
    if (!s) return setMsg({ text: "Say or type what happened first.", err: true });
    setText(s);
    setAlts(candidates.filter(c => c !== s));
    // Apply the user's word list first ("holds" -> "owes"), then understand the fixed sentence.
    const fixed = applyDictionary(s, dict);
    setApplied(fixed.applied);
    const others = candidates.filter(c => c !== s).map(c => applyDictionary(c, dict).text);
    setThinking(true); setMsg({ text: "", err: false });
    let list: Draft[] | undefined;
    let src: "ai" | "rules" = "rules";
    let prefix = "";
    if (ai) {
      try { list = await askAi({ text: fixed.text, alternatives: others }); src = "ai"; }
      catch (e) { prefix = `${(e as Error).message} Used basic understanding instead. `; }
    }
    if (!list) list = rulesParse(fixed.text);
    setThinking(false);
    setSource(src);
    setDrafts(withIssues(list));
    announce(list, prefix);
  }

  async function applyFix(instruction: string) {
    const s = instruction.trim();
    if (!s || !drafts) return;
    setThinking(true); setMsg({ text: "", err: false });
    try {
      const list = await askAi({ text: s, drafts: drafts.map(({ issues: _i, ...d }) => d) });
      setDrafts(withIssues(list));
      setFix("");
      announce(list, "Updated. ");
    } catch (e) {
      setMsg({ text: `${(e as Error).message} You can still edit the fields directly.`, err: true });
    }
    setThinking(false);
  }

  function startListening(target: Target) {
    if (useWhisper) return startRecording(target);
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    // Urdu only makes sense when AI is on: the basic parser reads English.
    rec.lang = (LANGS[lang].needsAi && !ai ? LANGS.en : LANGS[lang]).code;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    finalRef.current = [];
    setInterim("");
    if (target === "new") { setText(""); setDrafts(null); }
    else setFix("");
    setMsg({ text: "", err: false });
    const put = target === "new" ? setText : setFix;
    rec.onresult = ev => {
      const finals: { alts: string[] }[] = [];
      let mid = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) {
          const guesses: string[] = [];
          for (let k = 0; k < r.length; k++) if (r[k]?.transcript) guesses.push(r[k].transcript.trim());
          finals.push({ alts: guesses });
        } else mid += r[0].transcript;
      }
      finalRef.current = finals;
      put(finals.map(f => f.alts[0]).join(" ").trim());
      setInterim(mid);
    };
    rec.onerror = ev => {
      if (ev.error === "aborted") return;
      setMsg({ text: MIC_ERRORS[ev.error] || "Voice input stopped. Try again, or type instead.", err: true });
    };
    rec.onend = () => {
      setListening(null);
      setInterim("");
      const candidates = candidatesFrom(finalRef.current);
      if (!candidates.length) return;
      if (target === "new") reviewHeard(candidates); else applyFix(candidates[0]);
    };
    recRef.current = rec;
    try { rec.start(); setListening(target); }
    catch { setMsg({ text: "Couldn't start the microphone. Try again.", err: true }); }
  }

  // Accurate mode: record the whole sentence, then let Whisper transcribe it with our vocabulary.
  async function startRecording(target: Target) {
    if (target === "new") { setText(""); setDrafts(null); setAlts([]); } else setFix("");
    setMsg({ text: "", err: false }); setRecSecs(0);
    let session: RecorderSession;
    try {
      session = await startRecorder({ onTick: setRecSecs });
    } catch (e) {
      const name = (e as DOMException)?.name;
      const blocked = name === "NotAllowedError" || name === "SecurityError";
      setMsg({ text: blocked ? MIC_ERRORS["not-allowed"] : name === "NotFoundError" ? MIC_ERRORS["audio-capture"] : "Couldn't start the microphone. Try again, or type instead.", err: true });
      return;
    }
    recorderRef.current = session;
    setListening(target);
    const result = await session.done;
    recorderRef.current = null;
    setListening(null);
    if (!result) return; // cancelled
    if (!result.spoke || result.seconds < 0.6) { setMsg({ text: MIC_ERRORS["no-speech"], err: true }); return; }

    setThinking(true);
    setMsg({ text: "Listening back…", err: false });
    const form = new FormData();
    form.append("audio", result.blob, "speech");
    form.append("lang", LANGS[lang].stt);
    form.append("names", JSON.stringify(knownPeople));
    let heard = "";
    try {
      // FormData sends the recording as multipart/form-data; the browser sets the boundary header itself.
      const data = await api<{ text: string }>("/api/transcribe", { method: "POST", body: form });
      heard = data.text || "";
    } catch (e) {
      setThinking(false);
      if (e instanceof ApiError && e.status === 401) return;
      if (browserSR) setWhisperDown(true);
      setMsg({ text: `${(e as Error).message}${browserSR ? " Tap Speak to try the browser's own speech instead." : ""} You can also type it.`, err: true });
      return;
    }
    setThinking(false);
    if (!heard) { setMsg({ text: MIC_ERRORS["no-speech"], err: true }); return; }
    if (target === "new") reviewHeard([heard]);
    else { setFix(heard); applyFix(heard); }
  }

  function stopListening() {
    if (recorderRef.current) recorderRef.current.stop();
    else recRef.current?.stop();
  }

  function update<K extends keyof Draft>(i: number, key: K, value: Draft[K]) {
    setDrafts(list => list && list.map((d, j) => {
      if (j !== i) return d;
      const next = { ...d, [key]: value, ...(key === "kind" || key === "person" ? { hint: "" } : {}) };
      return { ...next, issues: issuesFor(next) };
    }));
  }

  function removeDraft(i: number) {
    setDrafts(list => {
      const next = (list || []).filter((_, j) => j !== i);
      return next.length ? next : null;
    });
  }

  function reset() { recRef.current?.abort(); recorderRef.current?.cancel(); setListening(null); setDrafts(null); setText(""); setFix(""); setInterim(""); setAlts([]); setApplied([]); setMsg({ text: "", err: false }); }

  async function saveAll() {
    if (!drafts?.length || drafts.some(d => d.issues.length)) return;
    setSaving(true);
    const result = await onSave(drafts.map(d => ({
      kind: d.kind as Kind, person: d.person.trim(), amount: Math.round(Number(d.amount)), date: d.date, note: (d.note || "").trim(),
    })));
    setSaving(false);
    if (result.saved === drafts.length) {
      setMsg({ text: `Saved ${result.saved} ${result.saved === 1 ? "entry" : "entries"}.`, err: false });
      setDrafts(null); setText(""); setFix("");
    } else {
      setDrafts(drafts.slice(result.saved));
      setMsg({ text: `Saved ${result.saved}, but ${drafts.length - result.saved} didn't save: ${result.error}`, err: true });
    }
  }

  const busy = thinking || saving;
  const blocked = !drafts || drafts.some(d => d.issues.length) || busy || Boolean(listening);
  const live = (v: string, who: Target) => (listening === who ? `${v} ${interim}`.trim() : v);

  return (
    <section className="panel voice" aria-labelledby="voice-h">
      <div className="voice-head">
        <div>
          <h2 id="voice-h">Say it {ai && <span className="badge">AI</span>}{useWhisper && <span className="badge" title="Speech is transcribed by Whisper">Accurate speech</span>}</h2>
          <p className="hint">
            {ai ? "Say what happened in English or Urdu. AI turns it into entries; you check them before anything is saved."
              : "Tell it what happened in plain English. You'll check each entry before it's saved."}
          </p>
        </div>
        {supported && !drafts && (
          <button type="button" className={`mic${listening === "new" ? " on" : ""}`} disabled={busy || listening === "fix"}
            onClick={listening === "new" ? stopListening : () => startListening("new")}
            aria-pressed={listening === "new"} aria-label={listening === "new" ? "Stop listening" : "Start speaking"}>
            <MicIcon /><span>{listening === "new" ? "Stop" : "Speak"}</span>
          </button>
        )}
      </div>

      {supported && !drafts && langOptions.length > 1 && (
        <div className="langs" role="radiogroup" aria-label="Microphone language">
          {langOptions.map(([k, v]) => (
            <label key={k}><input type="radio" name="voice-lang" id={`lang-${k}`} checked={lang === k || (useWhisper && lang === "us" && k === "en")} onChange={() => chooseLang(k)} disabled={Boolean(listening)} /><span>{v.label}</span></label>
          ))}
        </div>
      )}

      {!drafts && (
        <form className="say" onSubmit={(e: FormEvent) => { e.preventDefault(); review(text); }}>
          <label htmlFor="say-text" className="sr">What happened</label>
          <input id="say-text" type="text" value={live(text, "new")} onChange={e => setText(e.target.value)}
            placeholder={listening ? (useWhisper ? `Listening… ${Math.floor(recSecs)}s. Stops when you pause, or tap Stop` : "Listening…") : supported ? "Tap Speak, or type: Bilal owes me 2500 for petrol" : "Type: Bilal owes me 2500 for petrol"}
            readOnly={Boolean(listening)} autoComplete="off" />
          <button type="submit" disabled={Boolean(listening) || !text.trim() || busy}>{thinking ? "Thinking…" : "Review"}</button>
        </form>
      )}

      {!drafts && !text && !listening && !thinking && (
        <ul className="examples" aria-label="Examples">
          {[...EXAMPLES, ...(ai ? AI_EXAMPLES : [])].map(x => <li key={x}><button type="button" className="chip" onClick={() => { setText(x); review(x); }}>“{x}”</button></li>)}
        </ul>
      )}
      {!supported && <p className="hint">Voice input works in Chrome, Edge and Safari. In this browser, type the sentence instead.</p>}

      {drafts && (
        <div className="review">
          <p className="heard"><span className="label">Heard</span> “{text}” <span className={`src ${source}`}>{source === "ai" ? "Understood by AI" : "Basic understanding"}</span></p>
          {applied.length > 0 && (
            <p className="hint">Fixed with your word list: {applied.map(a => `“${a.heard}” → “${a.meant}”`).join(", ")}</p>
          )}
          {alts.length > 0 && (
            <div className="alts">
              <span className="field-label">Not what you said? Other ways I heard it:</span>
              <ul className="examples">
                {alts.map(a => <li key={a}><button type="button" className="chip" disabled={busy} onClick={() => review(a, [text, ...alts])}>“{a}”</button></li>)}
              </ul>
            </div>
          )}
          <ul className="drafts">
            {drafts.map((d, i) => (
              <li key={i} className={`draft${d.issues.length ? " bad" : ""}`}>
                <div className="draft-grid">
                  <div className="field"><label htmlFor={`d${i}-kind`}>What happened</label>
                    <select id={`d${i}-kind`} value={d.kind || ""} onChange={e => update(i, "kind", (e.target.value || null) as Kind | null)} aria-invalid={!d.kind}>
                      <option value="">Choose…</option>
                      {(Object.keys(KINDS) as Kind[]).map(k => <option key={k} value={k}>{KINDS[k].label}</option>)}
                    </select></div>
                  <div className="field"><label htmlFor={`d${i}-person`}>Person</label>
                    <input id={`d${i}-person`} type="text" list="people-list" value={d.person} maxLength={60} onChange={e => update(i, "person", e.target.value)} aria-invalid={!d.person} /></div>
                  <div className="field"><label htmlFor={`d${i}-amount`}>Amount (Rs)</label>
                    <input id={`d${i}-amount`} type="number" min="1" step="1" inputMode="numeric" value={d.amount ?? ""} onChange={e => update(i, "amount", e.target.value)} aria-invalid={!(Number(d.amount) > 0)} /></div>
                  <div className="field"><label htmlFor={`d${i}-date`}>Date</label>
                    <input id={`d${i}-date`} type="date" value={d.date} onChange={e => update(i, "date", e.target.value)} /></div>
                  <div className="field d-note"><label htmlFor={`d${i}-note`}>Note</label>
                    <input id={`d${i}-note`} type="text" value={d.note} maxLength={200} onChange={e => update(i, "note", e.target.value)} /></div>
                </div>
                <div className="draft-foot">
                  <span className={d.issues.length ? "msg err" : "msg"}>{drafts.length > 1 && <b className="num">#{i + 1} </b>}{d.issues.length ? d.issues.join(" · ") : summary(d)}
                    {d.hint && !d.issues.length && <span className="guess">{d.hint}</span>}
                    {d.fixPair && (
                      <button type="button" className="mini learn" onClick={() => d.fixPair && addPair(d.fixPair.heard, d.fixPair.meant, i)}>
                        Always read “{d.fixPair.heard}” as “{d.fixPair.meant}”
                      </button>
                    )}</span>
                  <button type="button" className="mini" onClick={() => removeDraft(i)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>

          {ai && (
            <form className="fix" onSubmit={e => { e.preventDefault(); applyFix(fix); }}>
              <label htmlFor="fix-text" className="field-label">Something wrong? Say or type the correction</label>
              <div className="say">
                {supported && (
                  <button type="button" className={`mic small${listening === "fix" ? " on" : ""}`} disabled={busy}
                    onClick={listening === "fix" ? stopListening : () => startListening("fix")}
                    aria-pressed={listening === "fix"} aria-label={listening === "fix" ? "Stop listening" : "Speak a correction"}>
                    <MicIcon /><span>{listening === "fix" ? "Stop" : "Speak"}</span>
                  </button>
                )}
                <input id="fix-text" type="text" value={live(fix, "fix")} onChange={e => setFix(e.target.value)} readOnly={Boolean(listening)}
                  placeholder={`e.g. “${FIX_EXAMPLES[0]}” or “${FIX_EXAMPLES[2]}”`} autoComplete="off" />
                <button type="submit" disabled={!fix.trim() || busy || Boolean(listening)}>{thinking ? "Fixing…" : "Apply"}</button>
              </div>
            </form>
          )}
          {ai === false && <p className="hint">Fix anything above by editing the fields. Turn on AI to correct by voice.</p>}

          <div className="review-actions">
            <button type="button" className="primary" onClick={saveAll} disabled={blocked}>
              {saving ? "Saving…" : `Save ${drafts.length} ${drafts.length === 1 ? "entry" : "entries"}`}
            </button>
            {supported && <button type="button" onClick={() => { reset(); startListening("new"); }} disabled={busy}>Start over</button>}
            <button type="button" onClick={reset} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}
      <p className={`msg${msg.err ? " err" : ""}`} aria-live="polite">{thinking && !msg.text ? "Thinking…" : msg.text}</p>

      <details className="wordlist">
        <summary>Word list{dict.length ? ` (${dict.length})` : ""}: fix words the mic keeps mishearing</summary>
        <p className="hint">When the mic hears the word on the left, the app reads it as the word on the right. Names work too, e.g. “Bill all” → “Bilal”.</p>
        <form className="pair-form" onSubmit={e => { e.preventDefault(); addPair(newHeard, newMeant); setNewHeard(""); setNewMeant(""); }}>
          <div className="field"><label htmlFor="wl-heard">It hears</label>
            <input id="wl-heard" type="text" value={newHeard} maxLength={40} placeholder="holds" onChange={e => setNewHeard(e.target.value)} /></div>
          <div className="field"><label htmlFor="wl-meant">I said</label>
            <input id="wl-meant" type="text" value={newMeant} maxLength={40} placeholder="owes" onChange={e => setNewMeant(e.target.value)} /></div>
          <button type="submit" disabled={!newHeard.trim() || !newMeant.trim()}>Add</button>
        </form>
        {dict.length > 0 ? (
          <ul className="pairs">
            {dict.map(p => (
              <li key={p.heard}><span>“{p.heard}” → “{p.meant}”</span>
                <button type="button" className="mini" onClick={() => removePair(p.heard)}>Remove</button></li>
            ))}
          </ul>
        ) : <p className="hint">No words yet. Add one here, or tap “Always read …” when the app flags a misheard word.</p>}
      </details>
    </section>
  );
}

function summary(d: Draft): string {
  const amt = "Rs " + Math.round(Number(d.amount)).toLocaleString("en-US");
  const who = d.person.trim();
  if (!d.kind) return "";
  const lines: Record<Kind, string> = {
    lent: `${who} will owe you ${amt} more`,
    borrowed: `You will owe ${who} ${amt} more`,
    received: `${who} will owe you ${amt} less`,
    paid: `You will owe ${who} ${amt} less`,
  };
  return lines[d.kind];
}
