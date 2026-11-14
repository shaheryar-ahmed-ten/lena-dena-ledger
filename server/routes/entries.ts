// The signed-in user's ledger entries, plus CSV export.
import crypto from "node:crypto";
import { Router } from "express";
import { KINDS, personKey, validateEntry } from "../../shared/ledger";
import type { Entry } from "../../shared/types";
import { deleteEntry, getEntry, hasDatabase, listEntries, saveEntry } from "../lib/store";
import { me, requireUser } from "../middleware";

const router = Router();
router.use(["/entries", "/export"], requireUser);

router.get("/entries", async (req, res) => {
  res.json({ entries: await listEntries(me(req).id), hasDatabase });
});

router.post("/entries", async (req, res) => {
  const { value, error } = validateEntry(req.body);
  if (error || !value) return void res.status(400).json({ error });
  const uid = me(req).id;
  // Reuse the spelling already on file for this person ("bilal" -> "Bilal").
  const match = (await listEntries(uid)).find(e => personKey(e.person) === personKey(value.person));
  const entry: Entry = { id: crypto.randomUUID(), ...value, person: match ? match.person : value.person, createdAt: new Date().toISOString() };
  await saveEntry(uid, entry);
  res.status(201).json({ entry });
});

router.patch("/entries/:id", async (req, res) => {
  const uid = me(req).id;
  const existing = await getEntry(uid, req.params.id);
  if (!existing) return void res.status(404).json({ error: "That entry no longer exists." });
  const { value, error } = validateEntry({ ...existing, ...req.body });
  if (error || !value) return void res.status(400).json({ error });
  const entry: Entry = { ...existing, ...value, updatedAt: new Date().toISOString() };
  await saveEntry(uid, entry);
  res.json({ entry });
});

router.delete("/entries/:id", async (req, res) => {
  await deleteEntry(me(req).id, req.params.id);
  res.json({ ok: true });
});

const cell = (v: unknown) => {
  let s = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheet apps from running it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get("/export", async (req, res) => {
  const entries = (await listEntries(me(req).id)).sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const rows: unknown[][] = [["Date", "Person", "What happened", "Amount (Rs)", "Effect on balance (Rs)", "Note"]];
  for (const e of entries) rows.push([e.date, e.person, KINDS[e.kind]?.label || e.kind, e.amount, (KINDS[e.kind]?.sign || 0) * e.amount, e.note]);
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send("﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n"));
});

export default router;
