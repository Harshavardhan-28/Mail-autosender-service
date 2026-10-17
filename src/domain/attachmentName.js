import { z } from "zod";

// One file name for every resume attachment, whatever the resume is called in the library
// (e.g. "Backend engineer" goes out as Harshavardhan_Khamkar_Resume.pdf). Stored without the
// extension; attachments are always PDFs.
export const ATTACHMENT_NAME_KEY = "attachment_name";

export function defaultAttachmentName(fromName) {
  const base = String(fromName ?? "").trim().replace(/[^\p{L}\p{M}\p{N}-]+/gu, "_").replace(/^_+|_+$/g, "");
  return base ? `${base}_Resume` : "Resume";
}

// Letters (with combining marks, for Indic scripts and accents), digits, spaces and . _ - ( ) only:
// no path separators, quotes or control characters.
export const attachmentNameSchema = z
  .string()
  .transform((v) => v.trim().replace(/\.pdf$/i, "").trim())
  .pipe(z.string().min(1, "Enter a file name").max(100, "At most 100 characters").regex(/^[\p{L}\p{M}\p{N} ._()-]+$/u, "Use letters, digits, spaces and . _ - ( ) only"));

// source: "saved" (set on the Resumes page), "sender_name" (default from FROM_NAME), "fallback" (no FROM_NAME: plain "Resume").
const toResult = (name, source) => ({ name, fileName: `${name}.pdf`, isDefault: source !== "saved", source });
const defaultResult = (config) => toResult(defaultAttachmentName(config.fromName), config.fromName?.trim() ? "sender_name" : "fallback");

export async function getAttachmentName(db, config = {}) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [ATTACHMENT_NAME_KEY]);
  const saved = attachmentNameSchema.safeParse(rows[0]?.value?.name);
  return saved.success ? toResult(saved.data, "saved") : defaultResult(config);
}

export async function putAttachmentName(db, name) {
  await db.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [ATTACHMENT_NAME_KEY, JSON.stringify({ name })],
  );
  return toResult(name, "saved");
}

export async function resetAttachmentName(db, config = {}) {
  await db.query("DELETE FROM settings WHERE key = $1", [ATTACHMENT_NAME_KEY]);
  return defaultResult(config);
}
