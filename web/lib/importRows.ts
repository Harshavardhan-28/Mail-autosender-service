// Client mirror of validateRows in src/import/parseCsv.js, so edits can be checked as you type.
// The server stays the authority: it re-validates everything on commit.
import type { ImportRow } from "./types";
import { MAX_ROWS } from "./upload";

export const MAX_FIELD = 300;
export const MAX_TEXT = 20000;

export type FieldKey = "company" | "role" | "person" | "email" | "subject" | "mailText" | "followupText";
export type RowProblems = Partial<Record<FieldKey, string>>;

const FIELDS: { key: FieldKey; name: string; required: boolean; singleLine: boolean }[] = [
  { key: "company", name: "Company", required: true, singleLine: true },
  { key: "role", name: "Role", required: true, singleLine: true },
  { key: "person", name: "Person", required: true, singleLine: true },
  { key: "email", name: "Email", required: true, singleLine: true },
  { key: "subject", name: "Subject", required: true, singleLine: true },
  { key: "mailText", name: "Mail Text", required: true, singleLine: false },
  { key: "followupText", name: "Follow-up Text", required: false, singleLine: false },
];

// Identical to EMAIL_RE in src/import/parseCsv.js.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CONTROL = /[\r\n\u0000-\u001f]/;

/** One entry per row (same order): the first problem found for each field, empty when the row is fine. */
export function validateImportRows(rows: ImportRow[]): RowProblems[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const problems: RowProblems = {};
    for (const f of FIELDS) {
      const v = String(r[f.key] ?? "").replace(/\r\n?/g, "\n").trim();
      if (f.required && v === "") problems[f.key] = `${f.name} is required`;
      else if (f.singleLine && CONTROL.test(v)) problems[f.key] = `${f.name} must be a single line without control characters`;
      else if (v.length > (f.singleLine ? MAX_FIELD : MAX_TEXT)) problems[f.key] = `${f.name} is too long`;
    }
    if (!problems.email) {
      const email = r.email.trim();
      if (email.length > 254 || !EMAIL_RE.test(email)) problems.email = "Email is not a valid address";
      else if (seen.has(email.toLowerCase())) problems.email = "Duplicate email in this list";
    }
    // Like the server, only a fully valid row claims its email.
    if (Object.keys(problems).length === 0) seen.add(r.email.trim().toLowerCase());
    return problems;
  });
}

/** Saving needs between 1 and MAX_ROWS rows and no problem anywhere. */
export function importRowsReady(rows: ImportRow[], problems: RowProblems[]): boolean {
  return rows.length >= 1 && rows.length <= MAX_ROWS && problems.every((p) => Object.keys(p).length === 0);
}
