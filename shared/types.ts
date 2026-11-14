// Shapes shared by the React client and the Express server.

export type Kind = "lent" | "borrowed" | "received" | "paid";

/** One saved ledger row. */
export interface Entry {
  id: string;
  person: string;
  amount: number; // whole rupees
  kind: Kind;
  note: string;
  date: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp
  updatedAt?: string;
}

/** What the client sends to create or edit an entry. */
export type EntryInput = Pick<Entry, "person" | "amount" | "kind" | "note" | "date">;

/** An entry being reviewed before saving (fields may still be missing). */
export interface Draft {
  kind: Kind | null;
  person: string;
  amount: number | string | null;
  date: string;
  note: string;
  raw?: string;
  hint?: string;
  fixPair?: WordPair | null;
  issues?: string[];
}

/** One word-list rule: when the mic hears `heard`, read it as `meant`. */
export interface WordPair {
  heard: string;
  meant: string;
}

export interface Provider {
  key: string;
  name: string;
}
