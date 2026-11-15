// "Import from Google Sheets": status, Picker settings, preview, import, and disconnect.
// Google Drive access is asked for separately from sign-in (GET /api/oauth/google/start?mode=drive).
import crypto from "node:crypto";
import { Router, type Response } from "express";
import { personKey } from "../../shared/ledger";
import type { Entry, ImportPreview } from "../../shared/types";
import { decryptSecret } from "../lib/auth";
import { getProvider } from "../lib/oauth";
import { GoogleApiError, previewRows, readFirstSheet } from "../lib/sheets";
import { deleteDriveToken, getDriveToken, listEntries, saveEntry } from "../lib/store";
import { me, requireUser } from "../middleware";

const router = Router();
router.use(["/google", "/import/sheets"], requireUser);

// The Picker needs a browser API key and the Cloud project number (on top of the sign-in client ID).
const pickerSettings = () => ({ apiKey: process.env.GOOGLE_API_KEY?.trim(), appId: process.env.GOOGLE_PROJECT_NUMBER?.trim() });
const configured = () => Boolean(getProvider("google") && pickerSettings().apiKey && pickerSettings().appId);

/** The user's Google Drive access token, if one was granted and has at least a minute left. */
async function driveAccess(uid: string): Promise<string | null> {
  const stored = await getDriveToken(uid);
  if (!stored || stored.expiresAt < Date.now() + 60_000) return null;
  return decryptSecret(stored.token);
}

const needAccess = (res: Response) => void res.status(409).json({ connect: true, error: "Allow Google Drive access to pick a sheet." });
const validFileId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{10,200}$/.test(v);

/** Turns Google's errors into something the user can act on. */
async function googleFailed(res: Response, uid: string, e: unknown) {
  if (e instanceof GoogleApiError) {
    if (e.status === 401) { await deleteDriveToken(uid); return needAccess(res); }
    if (e.status === 400) {
      // e.g. an Excel file stored in Drive: the Sheets API only reads Google Sheets.
      return void res.status(400).json({ error: "That file isn't a Google Sheet. Open it in Google Sheets, choose File → Save as Google Sheets, then pick the new copy." });
    }
    if (e.status === 403 || e.status === 404) {
      return void res.status(400).json({ error: "The ledger can't open that spreadsheet. Pick it again from Google Drive (only sheets you pick are shared)." });
    }
    console.error("Google Sheets error:", e.status, e.message);
    return void res.status(502).json({ error: "Google Sheets didn't answer properly. Try again." });
  }
  throw e;
}

router.get("/google/status", async (req, res) => {
  res.json({ configured: configured(), connected: Boolean(await driveAccess(me(req).id)) });
});

// Everything the browser needs to open the Google Picker. The access token is short-lived and only covers
// files the user picks (drive.file); the Picker is built by Google to be given one.
router.get("/google/picker-config", async (req, res) => {
  if (!configured()) return void res.status(503).json({ error: "Importing from Google Sheets isn't set up on this server." });
  const uid = me(req).id;
  const accessToken = await driveAccess(uid);
  if (!accessToken) return needAccess(res);
  const stored = await getDriveToken(uid);
  res.json({ accessToken, ...pickerSettings(), expiresAt: stored?.expiresAt });
});

router.post("/import/sheets/preview", async (req, res) => {
  const uid = me(req).id;
  const fileId = req.body?.fileId;
  if (!validFileId(fileId)) return void res.status(400).json({ error: "Pick a spreadsheet first." });
  const accessToken = await driveAccess(uid);
  if (!accessToken) return needAccess(res);
  try {
    const sheet = await readFirstSheet(fileId, accessToken);
    const { rows, error } = previewRows(sheet.values, await listEntries(uid));
    if (error) return void res.status(400).json({ error });
    const preview: ImportPreview = { title: sheet.title, sheetName: sheet.sheetName, rows };
    res.json(preview);
  } catch (e) {
    await googleFailed(res, uid, e);
  }
});

// Saves the chosen rows. The sheet is read again here, so only rows Google returns are saved:
// nothing the browser sends is trusted except which row numbers to include.
router.post("/import/sheets/commit", async (req, res) => {
  const uid = me(req).id;
  const fileId = req.body?.fileId;
  const lines = new Set((Array.isArray(req.body?.lines) ? req.body.lines : []).map(Number).filter(Number.isInteger));
  if (!validFileId(fileId)) return void res.status(400).json({ error: "Pick a spreadsheet first." });
  if (!lines.size) return void res.status(400).json({ error: "Tick at least one row to import." });
  const accessToken = await driveAccess(uid);
  if (!accessToken) return needAccess(res);
  try {
    const sheet = await readFirstSheet(fileId, accessToken);
    const existing = await listEntries(uid);
    const { rows, error } = previewRows(sheet.values, existing);
    if (error) return void res.status(400).json({ error });

    // Reuse the spelling already on file for each person ("bilal" -> "Bilal"), as when adding by hand.
    const names = new Map(existing.map(e => [personKey(e.person), e.person]));
    let imported = 0;
    for (const row of rows) {
      if (!lines.has(row.line) || !row.entry || row.duplicate) continue;
      const person = names.get(personKey(row.entry.person)) || row.entry.person;
      names.set(personKey(person), person);
      const entry: Entry = { id: crypto.randomUUID(), ...row.entry, person, createdAt: new Date().toISOString() };
      await saveEntry(uid, entry);
      imported++;
    }
    res.json({ imported, skipped: lines.size - imported });
  } catch (e) {
    await googleFailed(res, uid, e);
  }
});

// Ends Google Drive access now: Google forgets the grant and the stored token is deleted.
router.post("/google/disconnect", async (req, res) => {
  const uid = me(req).id;
  const stored = await getDriveToken(uid);
  const token = stored && (await decryptSecret(stored.token));
  if (token) {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }).catch(e => console.error("Google revoke failed:", (e as Error).message));
  }
  await deleteDriveToken(uid);
  res.json({ ok: true });
});

export default router;
