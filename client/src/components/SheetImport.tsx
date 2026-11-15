// "Import from Google Sheets": allow Google Drive access (once an hour at most), pick one spreadsheet in
// Google's own Picker, review the rows, then import them as ledger entries.
import { useEffect, useState } from "react";
import { KINDS } from "../../../shared/ledger";
import type { ImportPreview } from "../../../shared/types";
import { api, ApiError, fmt } from "../api";

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

interface PickerConfig { accessToken: string; apiKey: string; appId: string }
type Msg = { text: string; err: boolean };
const NONE: Msg = { text: "", err: false };

// Sends the browser to Google to allow Drive access; Google sends it back to /?import=sheets.
const askGoogleForAccess = () => window.location.assign("/api/oauth/google/start?mode=drive");

// Google's Picker script is loaded only when someone imports.
let pickerScript: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  pickerScript ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onload = () => window.gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("picker")) });
    s.onerror = () => reject(new Error("script"));
    document.head.appendChild(s);
  }).catch(e => { pickerScript = null; throw e; });
  return pickerScript;
}

/** Opens Google's file picker showing spreadsheets. Resolves with the picked file's ID, or null if closed. */
function pickSpreadsheet(cfg: PickerConfig): Promise<string | null> {
  const g = window.google.picker;
  return new Promise(resolve => {
    const picker = new g.PickerBuilder()
      // Only real Google Sheets: Excel files stored in Drive can't be read by the Sheets API.
      .addView(new g.DocsView(g.ViewId.SPREADSHEETS).setMimeTypes("application/vnd.google-apps.spreadsheet"))
      .setOAuthToken(cfg.accessToken)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId) // the Cloud project number: makes the per-file grant apply to this app
      .setTitle("Pick a spreadsheet to import")
      .setCallback((data: any) => {
        if (data[g.Response.ACTION] === g.Action.PICKED) resolve(data[g.Response.DOCUMENTS]?.[0]?.[g.Document.ID] ?? null);
        else if (data[g.Response.ACTION] === g.Action.CANCEL) resolve(null);
      })
      .build();
    picker.setVisible(true);
  });
}

export default function SheetImport({ autoStart, onImported }: { autoStart: boolean; onImported: () => void }) {
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(NONE);
  const [fileId, setFileId] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    api<{ configured: boolean; connected: boolean }>("/api/google/status")
      .then(s => { setStatus(s); if (autoStart && s.configured) pick(); })
      .catch(() => setStatus(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const failed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) return askGoogleForAccess();
    setMsg({ text: (e as Error).message, err: true });
  };

  async function pick() {
    setMsg(NONE);
    setBusy(true);
    try {
      const cfg = await api<PickerConfig>("/api/google/picker-config");
      setStatus(s => s && { ...s, connected: true });
      try { await loadPicker(); }
      catch { setMsg({ text: "Couldn't load Google's file picker. Check your connection, or allow apis.google.com if an ad blocker is on.", err: true }); return; }
      const id = await pickSpreadsheet(cfg);
      if (id) await load(id);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  }

  async function load(id: string) {
    const p = await api<ImportPreview>("/api/import/sheets/preview", { method: "POST", json: { fileId: id } });
    setFileId(id);
    setPreview(p);
    setSelected(new Set(p.rows.filter(r => r.entry && !r.duplicate).map(r => r.line)));
  }

  async function importRows() {
    setBusy(true);
    setMsg(NONE);
    try {
      const { imported } = await api<{ imported: number }>("/api/import/sheets/commit", { method: "POST", json: { fileId, lines: [...selected] } });
      setPreview(null);
      setMsg({ text: `Imported ${imported} ${imported === 1 ? "entry" : "entries"} from Google Sheets.`, err: false });
      onImported();
    } catch (e) {
      failed(e);
    }
    setBusy(false);
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api("/api/google/disconnect", { method: "POST" });
      setStatus(s => s && { ...s, connected: false });
      setPreview(null);
      setMsg({ text: "Google Drive is disconnected. The ledger can no longer open your sheets.", err: false });
    } catch (e) {
      failed(e);
    }
    setBusy(false);
  }

  function toggle(line: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line); else next.add(line);
      return next;
    });
  }

  if (!status?.configured) return null;

  const rows = preview?.rows || [];
  const ready = rows.filter(r => r.entry && !r.duplicate).length;
  const dupes = rows.filter(r => r.duplicate).length;
  const bad = rows.filter(r => r.error).length;

  return (
    <section className="panel" aria-labelledby="sheets-h">
      <h2 id="sheets-h">Import from Google Sheets</h2>
      {!preview ? (
        <>
          <p className="hint">
            Pick one spreadsheet from your Google Drive. The ledger can open only the files you pick. The first row needs the
            columns Date, Person, What happened and Amount (Note is optional). A CSV downloaded from this ledger and opened in
            Google Sheets works as it is.
          </p>
          <div className="sheet-actions">
            <button type="button" className="primary" onClick={pick} disabled={busy}>{busy ? "Opening…" : "Pick a spreadsheet"}</button>
            {status.connected && <button type="button" className="mini" onClick={disconnect} disabled={busy}>Disconnect Google Drive</button>}
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            <b>{preview.title}</b> · tab “{preview.sheetName}”: {ready} ready to import
            {dupes ? `, ${dupes} already in your ledger` : ""}{bad ? `, ${bad} with problems` : ""}.
          </p>
          <div className="sheet-table">
            <table>
              <thead>
                <tr><th scope="col"><span className="sr">Import</span></th><th scope="col">Row</th><th scope="col">Date</th><th scope="col">Person</th><th scope="col">What happened</th><th scope="col">Amount</th><th scope="col">Note</th></tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.line} className={r.error ? "bad" : r.duplicate ? "dup" : ""}>
                    <td>
                      {r.entry && !r.duplicate && (
                        <input type="checkbox" id={`row-${r.line}`} aria-label={`Import row ${r.line}`} checked={selected.has(r.line)} onChange={() => toggle(r.line)} />
                      )}
                    </td>
                    <td className="num">{r.line}</td>
                    {r.entry ? (
                      <>
                        <td className="num">{r.entry.date}</td>
                        <td>{r.entry.person}</td>
                        <td>{KINDS[r.entry.kind].label}</td>
                        <td className="num">{fmt(r.entry.amount)}</td>
                        <td>{r.duplicate ? "Already in your ledger" : r.entry.note}</td>
                      </>
                    ) : (
                      <td colSpan={5}>{r.error}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sheet-actions">
            <button type="button" className="primary" onClick={importRows} disabled={busy || !selected.size}>
              {busy ? "Importing…" : `Import ${selected.size} ${selected.size === 1 ? "entry" : "entries"}`}
            </button>
            <button type="button" onClick={pick} disabled={busy}>Pick another sheet</button>
            <button type="button" onClick={() => { setPreview(null); setMsg(NONE); }} disabled={busy}>Cancel</button>
          </div>
        </>
      )}
      <p className={`msg${msg.err ? " err" : ""}`} aria-live="polite">{msg.text}</p>
    </section>
  );
}
