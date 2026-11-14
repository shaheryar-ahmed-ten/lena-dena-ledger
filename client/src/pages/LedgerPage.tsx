// The signed-in user's ledger: totals, voice entry, manual form, people, entries, sign-in methods.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { KINDS, balances, personKey } from "../../../shared/ledger";
import type { Entry, EntryInput, Kind, Provider } from "../../../shared/types";
import { api, fmt, today } from "../api";
import VoiceEntry from "../components/VoiceEntry";

const shortDate = (iso: string) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const s = new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return y !== new Date().getFullYear() ? `${s} ${y}` : s;
};
const tone = (n: number) => (n > 0.5 ? "get" : n < -0.5 ? "pay" : "even");

function Line({ e }: { e: Entry }) {
  const p = <b>{e.person}</b>;
  if (e.kind === "lent") return <>You lent {p}</>;
  if (e.kind === "borrowed") return <>You borrowed from {p}</>;
  if (e.kind === "received") return <>{p} paid you back</>;
  return <>You paid {p} back</>;
}

interface FormState { kind: Kind; person: string; amount: string; date: string; note: string }
const blankForm = (): FormState => ({ kind: "lent", person: "", amount: "", date: today(), note: "" });
type Msg = { text: string; err: boolean };
const NONE: Msg = { text: "", err: false };

export default function LedgerPage({ username }: { username: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasDb, setHasDb] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<FormState>(blankForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(NONE);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<{ count: number } | null>(null);
  const [legacyPass, setLegacyPass] = useState("");
  const [legacyMsg, setLegacyMsg] = useState<Msg>(NONE);
  const [signin, setSignin] = useState<{ providers: Provider[]; connected?: string[]; hasPassword?: boolean } | null>(null);
  const personRef = useRef<HTMLInputElement>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function load() {
    try {
      const data = await api<{ entries: Entry[]; hasDatabase: boolean }>("/api/entries");
      setEntries(data.entries);
      setHasDb(data.hasDatabase);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
    setLoaded(true);
  }

  useEffect(() => {
    load();
    api("/api/oauth/status").then(setSignin).catch(() => {});
    // Messages handed back after a Google sign-in round trip (?connected=, ?error=, ?welcome=).
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("connected")) setMsg({ text: "Google is now connected. You can use it to log in.", err: false });
    else if (qs.get("error")) setMsg({ text: qs.get("error") || "", err: true });
    else if (qs.get("welcome")) setMsg({ text: "Welcome! Your ledger is ready. Add your first entry below.", err: false });
    if (qs.toString()) window.history.replaceState(null, "", window.location.pathname);
    api<{ available: boolean; count: number }>("/api/import-legacy").then(d => { if (d.available) setLegacy({ count: d.count }); }).catch(() => {});
    const onFocus = () => load(); // pick up changes made on another device
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const bal = useMemo(() => balances(entries), [entries]);
  const people = useMemo(() => [...bal.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name)), [bal]);
  let get = 0, pay = 0, ng = 0, np = 0;
  for (const p of people) { if (p.net > 0.5) { get += p.net; ng++; } else if (p.net < -0.5) { pay -= p.net; np++; } }
  const net = get - pay;

  const focused = focus ? bal.get(focus) : undefined;
  const shown = useMemo(() => {
    let list = entries.slice();
    if (focus) list = list.filter(e => personKey(e.person) === focus);
    if (q) { const s = q.toLowerCase(); list = list.filter(e => e.person.toLowerCase().includes(s) || (e.note || "").toLowerCase().includes(s)); }
    return list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [entries, focus, q]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }));

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const person = form.person.trim().replace(/\s+/g, " ");
    const amount = Math.round(Number(form.amount));
    if (!person) return setMsg({ text: "Add the person's name.", err: true });
    if (!(amount > 0)) return setMsg({ text: "Enter an amount above zero.", err: true });
    const existing = bal.get(personKey(person));
    const body: EntryInput = { ...form, person: existing ? existing.name : person, amount };
    setBusy(true);
    try {
      if (editing) {
        const { entry } = await api<{ entry: Entry }>(`/api/entries/${editing}`, { method: "PATCH", json: body });
        setEntries(list => list.map(e => (e.id === entry.id ? entry : e)));
        setMsg({ text: "Entry updated.", err: false });
        setEditing(null);
      } else {
        const { entry } = await api<{ entry: Entry }>("/api/entries", { method: "POST", json: body });
        setEntries(list => [...list, entry]);
        setMsg({ text: `Added: ${KINDS[entry.kind].label.toLowerCase()} · ${fmt(entry.amount)} · ${entry.person}`, err: false });
      }
      setForm(f => ({ ...blankForm(), kind: f.kind, date: editing ? today() : f.date }));
      personRef.current?.focus();
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    }
    setBusy(false);
  }

  function startEdit(e: Entry) {
    setEditing(e.id);
    setForm({ kind: e.kind, person: e.person, amount: String(e.amount), date: e.date, note: e.note || "" });
    setMsg({ text: `Editing an entry for ${e.person}.`, err: false });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() { setEditing(null); setForm(blankForm()); setMsg(NONE); }

  async function remove(id: string) {
    if (armed !== id) {
      setArmed(id);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), 4000);
      return;
    }
    setArmed(null);
    const before = entries;
    setEntries(list => list.filter(e => e.id !== id));
    try { await api(`/api/entries/${id}`, { method: "DELETE" }); }
    catch (e) { setEntries(before); setMsg({ text: (e as Error).message, err: true }); }
  }

  async function settleUp() {
    if (!focused || Math.abs(focused.net) < 0.5) return;
    setBusy(true);
    try {
      const { entry } = await api<{ entry: Entry }>("/api/entries", {
        method: "POST",
        json: { person: focused.name, amount: Math.round(Math.abs(focused.net)), kind: focused.net > 0 ? "received" : "paid", note: "Settled up in full", date: today() },
      });
      setEntries(list => [...list, entry]);
      setMsg({ text: `Settled up with ${focused.name}.`, err: false });
    } catch (e) {
      setMsg({ text: (e as Error).message, err: true });
    }
    setBusy(false);
  }

  // Saves reviewed voice drafts one by one; stops at the first failure so the rest stay on screen.
  async function saveMany(list: EntryInput[]): Promise<{ saved: number; error?: string }> {
    let saved = 0;
    for (const body of list) {
      try {
        const { entry } = await api<{ entry: Entry }>("/api/entries", { method: "POST", json: body });
        setEntries(prev => [...prev, entry]);
        saved++;
      } catch (e) {
        return { saved, error: (e as Error).message };
      }
    }
    return { saved };
  }

  async function importLegacy(e: FormEvent) {
    e.preventDefault();
    setLegacyMsg(NONE);
    try {
      const { imported } = await api<{ imported: number }>("/api/import-legacy", { method: "POST", json: { passcode: legacyPass } });
      setLegacy(null);
      setMsg({ text: `Imported ${imported} ${imported === 1 ? "entry" : "entries"} from your old ledger.`, err: false });
      load();
    } catch (err) {
      setLegacyMsg({ text: (err as Error).message, err: true });
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Lena Dena Ledger</h1>
          <p className="sub">Who owes you, and who you owe. Amounts in Pakistani rupees.</p>
        </div>
        <div className="top-actions">
          <span className="who-am-i">Signed in as <b>{username}</b></span>
          {/* A plain link: the server answers with a file download. */}
          <a className="btn" href="/api/export">Download CSV</a>
          <button type="button" onClick={logout}>Log out</button>
        </div>
      </header>

      {!hasDb && <div className="banner">No database is connected, so entries will be lost. In Vercel, open this project → Storage → connect an Upstash Redis database, then redeploy.</div>}
      {loadError && <div className="banner">{loadError}</div>}
      {legacy && (
        <div className="import">
          <span>Your ledger from the earlier passcode version has <b>{legacy.count}</b> {legacy.count === 1 ? "entry" : "entries"}. Enter that old passcode to move {legacy.count === 1 ? "it" : "them"} into this account. This can only be done once, by one account.</span>
          <form onSubmit={importLegacy}>
            <label htmlFor="legacy-pass" className="sr">Old passcode</label>
            <input id="legacy-pass" type="password" placeholder="Old passcode" value={legacyPass} onChange={e => setLegacyPass(e.target.value)} autoComplete="off" />
            <button type="submit" className="primary" disabled={!legacyPass}>Import</button>
            <button type="button" onClick={() => setLegacy(null)}>Not now</button>
          </form>
          {legacyMsg.text && <p className="msg err">{legacyMsg.text}</p>}
        </div>
      )}

      <section className="summary" aria-label="Totals">
        <div className="tile"><span className="label">To receive</span><span className="num get">{fmt(get)}</span><small>{ng ? `${ng} ${ng === 1 ? "person owes" : "people owe"} you` : "Nobody owes you"}</small></div>
        <div className="tile"><span className="label">To pay</span><span className="num pay">{fmt(pay)}</span><small>{np ? `You owe ${np} ${np === 1 ? "person" : "people"}` : "You owe nobody"}</small></div>
        <div className="tile net"><span className="label">Net position</span><span className={`num ${tone(net) === "even" ? "" : tone(net)}`}>{net < -0.5 ? "− " : ""}{fmt(net)}</span><small>{net > 0.5 ? "In your favour" : net < -0.5 ? "You owe more than you're owed" : "All square"}</small></div>
      </section>

      <VoiceEntry knownPeople={people.map(p => p.name)} onSave={saveMany} />

      <section className="panel" aria-labelledby="add-h">
        <h2 id="add-h">{editing ? "Edit entry" : "Or add one by hand"}</h2>
        <form className="addform" onSubmit={submit} autoComplete="off">
          <div className="kinds" role="radiogroup" aria-label="What happened">
            {(Object.keys(KINDS) as Kind[]).map(k => (
              <label key={k}>
                <input type="radio" name="kind" id={`k-${k}`} value={k} checked={form.kind === k} onChange={() => set("kind", k)} />
                <span>{KINDS[k].label}</span>
              </label>
            ))}
          </div>
          <div className="field"><label htmlFor="f-person">Person</label>
            <input ref={personRef} id="f-person" type="text" list="people-list" placeholder="e.g. Bilal" maxLength={60} required value={form.person} onChange={e => set("person", e.target.value)} /></div>
          <div className="field"><label htmlFor="f-amount">Amount (Rs)</label>
            <input id="f-amount" type="number" min="1" step="1" inputMode="numeric" placeholder="2500" required value={form.amount} onChange={e => set("amount", e.target.value)} /></div>
          <div className="field"><label htmlFor="f-date">Date</label>
            <input id="f-date" type="date" required value={form.date} onChange={e => set("date", e.target.value)} /></div>
          <div className="field f-note"><label htmlFor="f-note">Note</label>
            <input id="f-note" type="text" placeholder="Ground booking share, dinner, petrol…" maxLength={200} value={form.note} onChange={e => set("note", e.target.value)} /></div>
          <div className="submit">
            <button className="primary" type="submit" disabled={busy}>{editing ? "Save" : "Add entry"}</button>
            {editing && <button type="button" onClick={cancelEdit}>Cancel</button>}
          </div>
          <datalist id="people-list">{people.map(p => <option key={p.key} value={p.name} />)}</datalist>
        </form>
        <p className={`msg${msg.err ? " err" : ""}`} aria-live="polite">{msg.text}</p>
      </section>

      <div className="cols">
        <section className="panel" aria-labelledby="people-h">
          <h2 id="people-h">People</h2>
          <ul className="people">
            {!people.length && <li className="empty">{loaded ? "People appear here once you add an entry." : "Loading…"}</li>}
            {people.map(p => {
              const t = tone(p.net);
              return (
                <li key={p.key}>
                  <button type="button" aria-pressed={focus === p.key} onClick={() => setFocus(f => (f === p.key ? null : p.key))}>
                    <span className="who"><b>{p.name}</b><small>{t === "get" ? "owes you" : t === "pay" ? "you owe" : "settled"} · {p.count} {p.count === 1 ? "entry" : "entries"}</small></span>
                    <span className={`num ${t}`}>{t === "even" ? "—" : fmt(p.net)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel" aria-labelledby="entries-h">
          <div className="toolbar">
            <h2 id="entries-h">Entries</h2>
            <input type="search" id="q" placeholder="Search notes or names" aria-label="Search entries" value={q} onChange={e => setQ(e.target.value.trim())} />
          </div>
          {focused && (
            <div className="focus">
              <span>
                {focused.net > 0.5 ? <><b>{focused.name}</b> owes you <b className="num get">{fmt(focused.net)}</b></>
                  : focused.net < -0.5 ? <>You owe <b>{focused.name}</b> <b className="num pay">{fmt(focused.net)}</b></>
                  : <>You and <b>{focused.name}</b> are square</>}
              </span>
              <span className="acts">
                {Math.abs(focused.net) >= 0.5 && (
                  <button type="button" onClick={settleUp} disabled={busy}>{focused.net > 0 ? `They paid ${fmt(focused.net)}` : `I paid ${fmt(focused.net)}`}</button>
                )}
                <button type="button" onClick={() => setFocus(null)}>Show everyone</button>
              </span>
            </div>
          )}
          <ul className="entries">
            {!shown.length && (
              <li className="empty">{!loaded ? "Loading your ledger…" : entries.length ? "No entries match." : "No entries yet. Add the first one above, e.g. “I lent money · Bilal · 2,500 · ground booking”."}</li>
            )}
            {shown.map(e => {
              const k = KINDS[e.kind] || KINDS.lent;
              const pill = e.kind === "lent" ? "lent" : e.kind === "borrowed" ? "borrowed" : "back";
              const amtTone = e.kind === "lent" ? "get" : e.kind === "borrowed" ? "pay" : "even";
              return (
                <li className="entry" key={e.id}>
                  <span className="date">{shortDate(e.date)}</span>
                  <div className="what"><Line e={e} />{e.note && <div className="note">{e.note}</div>}</div>
                  <div className="right">
                    <span className={`amt num ${amtTone}`}>{fmt(e.amount)}</span>
                    <span className="acts">
                      <span className={`pill ${pill}`}>{k.tag}</span>
                      <button type="button" className="mini" onClick={() => startEdit(e)}>Edit</button>
                      <button type="button" className={`mini${armed === e.id ? " arm" : ""}`} onClick={() => remove(e.id)}>{armed === e.id ? "Tap to confirm" : "Delete"}</button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {signin && signin.providers.length > 0 && (
        <section className="panel" aria-labelledby="signin-h">
          <h2 id="signin-h">Sign-in methods</h2>
          <p className="hint">Connect other accounts so you can log in with any of them. {signin.hasPassword ? `You can also use your username (${username}) and password.` : ""}</p>
          <ul className="methods">
            {signin.providers.map(p => (
              <li key={p.key}>
                <span>{p.name}</span>
                {signin.connected?.includes(p.key) ? <span className="pill lent">Connected</span>
                  : <a className="btn mini" href={`/api/oauth/${p.key}/start?mode=link`}>Connect</a>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
