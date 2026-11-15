// Reading a Google Sheet the user picked, and turning its rows into ledger entries.
// Access comes from the drive.file permission: Google only lets the app open sheets the user picked.
import { KINDS, isKind, personKey, validateEntry } from "../../shared/ledger";
import type { Entry, ImportRow, Kind } from "../../shared/types";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const MAX_IMPORT_ROWS = 1000;

/** A failed Google API call; `status` is Google's HTTP status (401 = token expired, 403/404 = not picked). */
export class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function getJson(url: string, accessToken: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleApiError(res.status, body?.error?.message || `Google Sheets request failed (${res.status})`);
  return body;
}

/** The spreadsheet's name and every row of its first tab, as raw cell values. */
export async function readFirstSheet(fileId: string, accessToken: string): Promise<{ title: string; sheetName: string; values: unknown[][] }> {
  const id = encodeURIComponent(fileId);
  const meta = await getJson(`${SHEETS_API}/${id}?fields=properties.title,sheets.properties.title`, accessToken);
  const sheetName: string = meta?.sheets?.[0]?.properties?.title || "Sheet1";
  const range = encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'`);
  // Unformatted values give real numbers; dates come back as day numbers, converted below.
  const data = await getJson(`${SHEETS_API}/${id}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, accessToken);
  return { title: meta?.properties?.title || "Spreadsheet", sheetName, values: Array.isArray(data?.values) ? data.values : [] };
}

// ---- turning rows into entries ----

type Field = "date" | "person" | "kind" | "amount" | "effect" | "note";
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Header names that are recognised (case doesn't matter). The app's own CSV export uses the first of each.
const HEADERS: Record<Field, string[]> = {
  date: ["date"],
  person: ["person", "name"],
  kind: ["what happened", "type", "kind"],
  amount: ["amount (rs)", "amount"],
  effect: ["effect on balance (rs)", "effect on balance"],
  note: ["note", "notes", "description"],
};
const REQUIRED: Field[] = ["date", "person", "kind", "amount"];

function findColumns(header: unknown[]): Partial<Record<Field, number>> {
  const cols: Partial<Record<Field, number>> = {};
  header.forEach((cell, i) => {
    const h = norm(cell);
    for (const f of Object.keys(HEADERS) as Field[]) if (cols[f] === undefined && HEADERS[f].includes(h)) cols[f] = i;
  });
  return cols;
}

/** A Sheets day number (days since 30 Dec 1899) or a written date → YYYY-MM-DD, or "" if it isn't a date. */
export function toIsoDate(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return date.toISOString().slice(0, 10);
}

/** "I lent money", "Lent", "lent"… → a kind. "Repaid" needs the balance column to tell which way. */
export function toKind(v: unknown, effect: unknown): Kind | { error: string } {
  const s = norm(v);
  if (isKind(s)) return s;
  for (const k of Object.keys(KINDS) as Kind[]) {
    if (norm(KINDS[k].label) === s) return k;
  }
  if (s === "lent") return "lent";
  if (s === "borrowed") return "borrowed";
  if (s === "repaid") {
    const sign = Math.sign(Number(effect));
    if (sign < 0) return "received";
    if (sign > 0) return "paid";
    return { error: `"Repaid" could mean either way. Write "They paid me back" or "I paid them back".` };
  }
  return { error: `Unknown type "${String(v ?? "")}". Use "I lent money", "I borrowed money", "They paid me back" or "I paid them back".` };
}

function toAmount(v: unknown): number {
  if (typeof v === "number") return v;
  const cleaned = String(v ?? "").replace(/rs\.?|,|\s/gi, "");
  return cleaned ? Number(cleaned) : NaN;
}

const entryKey = (e: { date: string; person: string; kind: string; amount: number; note?: string }) =>
  [e.date, personKey(e.person), e.kind, Math.round(e.amount), norm(e.note)].join("|");

/**
 * Validates every row with the same rules as a normal entry and marks rows that are already in the ledger.
 * Duplicates are counted, so two identical rows in the sheet against one in the ledger leave one to import.
 */
export function previewRows(values: unknown[][], existing: Entry[]): { rows: ImportRow[]; error?: string } {
  const headerIndex = values.findIndex(r => Array.isArray(r) && r.some(c => norm(c)));
  if (headerIndex < 0) return { rows: [], error: "That sheet is empty." };
  const cols = findColumns(values[headerIndex]);
  const missing = REQUIRED.filter(f => cols[f] === undefined);
  if (missing.length) {
    return { rows: [], error: `The first row of the sheet needs these column names: Date, Person, What happened, Amount. Missing: ${missing.map(f => HEADERS[f][0]).join(", ")}.` };
  }
  const data = values.slice(headerIndex + 1);
  const dataRows = data.filter(r => Array.isArray(r) && r.some(c => norm(c)));
  if (dataRows.length > MAX_IMPORT_ROWS) return { rows: [], error: `That sheet has ${dataRows.length} rows. Import up to ${MAX_IMPORT_ROWS} at a time.` };

  const inLedger = new Map<string, number>();
  for (const e of existing) inLedger.set(entryKey(e), (inLedger.get(entryKey(e)) || 0) + 1);

  const rows: ImportRow[] = [];
  data.forEach((r, i) => {
    const row = Array.isArray(r) ? r : [];
    if (!row.some(c => norm(c))) return; // blank line
    const line = headerIndex + 2 + i; // the row number shown in Google Sheets
    const cell = (f: Field) => (cols[f] === undefined ? "" : row[cols[f]!]);
    const kind = toKind(cell("kind"), cell("effect"));
    if (typeof kind === "object") return void rows.push({ line, error: kind.error });
    const date = toIsoDate(cell("date"));
    if (!date) return void rows.push({ line, error: `"${String(cell("date") ?? "")}" isn't a date. Use YYYY-MM-DD or DD/MM/YYYY.` });
    const { value, error } = validateEntry({ person: cell("person"), amount: toAmount(cell("amount")), kind, note: cell("note"), date });
    if (error || !value) return void rows.push({ line, error });
    const key = entryKey(value);
    const seen = inLedger.get(key) || 0;
    if (seen > 0) {
      inLedger.set(key, seen - 1);
      return void rows.push({ line, entry: value, duplicate: true });
    }
    rows.push({ line, entry: value });
  });
  return { rows };
}
