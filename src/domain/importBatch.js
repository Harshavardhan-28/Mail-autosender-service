import { deleteContactsTx } from "./contacts.js";

// Contacts that never went out can be replaced by a re-import.
const REPLACEABLE = ["uploaded", "scheduled", "failed"];

// Existing contacts per lowercased email, newest first. With `lock`, the matches are locked FOR UPDATE (sorted by id).
export async function findMatches(db, emails, { lock = false } = {}) {
  const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (lock) await db.query("SELECT id FROM contacts WHERE lower(email) = ANY($1::text[]) ORDER BY id FOR UPDATE", [lowered]);
  const { rows } = await db.query(
    `SELECT c.id, c.batch_id, b.name AS batch_name, c.status, c.company, c.role, c.person, c.subject, lower(c.email) AS email
       FROM contacts c JOIN batches b ON b.id = c.batch_id
      WHERE lower(c.email) = ANY($1::text[]) ORDER BY c.created_at DESC, c.id`,
    [lowered],
  );
  const byEmail = new Map();
  for (const r of rows) {
    const list = byEmail.get(r.email) ?? [];
    list.push(r);
    byEmail.set(r.email, list);
  }
  return byEmail;
}

// -> [{ row, email, replaceable, matches: [...] }] for the rows whose email already exists.
export function buildConflicts(rows, matchesByEmail) {
  return rows
    .filter((r) => matchesByEmail.has(r.email.toLowerCase()))
    .map((r) => {
      const matches = matchesByEmail.get(r.email.toLowerCase());
      return {
        row: r.row,
        email: r.email,
        replaceable: matches.every((m) => REPLACEABLE.includes(m.status)),
        matches: matches.map((m) => ({
          contactId: m.id,
          batchId: m.batch_id,
          batchName: m.batch_name,
          status: m.status,
          company: m.company,
          role: m.role,
          person: m.person,
          subject: m.subject,
        })),
      };
    });
}

// Creates the batch, its contacts (in order) and the audit events. Runs inside the caller's tx.
export async function insertBatch(db, { name, filename, userId, rows, rejected }) {
  const b = await db.query("INSERT INTO batches(name, original_filename, created_by) VALUES ($1, $2, $3) RETURNING *", [name, filename, userId]);
  const batch = b.rows[0];
  const col = (k) => rows.map((r) => r[k]);
  const inserted = await db.query(
    `INSERT INTO contacts(batch_id, company, role, person, email, subject, mail_text, followup_text, created_at)
     SELECT $1::uuid, u.company, u.role, u.person, u.email, u.subject, u.mail_text, u.followup_text, clock_timestamp() FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) WITH ORDINALITY AS u(company, role, person, email, subject, mail_text, followup_text, ord)
     ORDER BY u.ord
     RETURNING *`,
    [batch.id, col("company"), col("role"), col("person"), col("email"), col("subject"), col("mailText"), col("followupText")],
  );
  await db.query("INSERT INTO events(contact_id, type, meta) SELECT id, 'imported', jsonb_build_object('batchId', $1::text) FROM unnest($2::uuid[]) AS id", [
    batch.id,
    inserted.rows.map((r) => r.id),
  ]);
  await db.query("INSERT INTO events(type, meta) VALUES ('batch_created', $1)", [
    JSON.stringify({ batchId: batch.id, imported: inserted.rowCount, rejected }),
  ]);
  return { batch, contacts: inserted.rows };
}

// Applies per-email resolutions to the locked conflicts. -> { toInsert, warnings, skipped, replaced } or a refusal.
// `refusal` is { status, body } for the route to send; nothing has been written when it is set.
export async function resolveConflicts(db, rows, matchesByEmail, resolutions) {
  const conflicts = buildConflicts(rows, matchesByEmail);
  const decision = (email) => resolutions[email.toLowerCase()];
  if (conflicts.some((c) => !decision(c.email))) {
    return { refusal: { status: 409, body: { error: "Duplicate emails need a decision", code: "needs_resolution", conflicts } } };
  }
  const bad = conflicts.find((c) => decision(c.email) === "replace" && !c.replaceable);
  if (bad) {
    return { refusal: { status: 409, body: { error: `${bad.email} was already emailed and cannot be replaced`, code: "not_replaceable" } } };
  }
  const toInsert = [];
  const warnings = [];
  let skipped = 0;
  let replaced = 0;
  const byRow = new Map(conflicts.map((c) => [c.row, c]));
  for (const r of rows) {
    const conflict = byRow.get(r.row);
    const choice = conflict && decision(r.email);
    if (choice === "skip") {
      skipped++;
      continue;
    }
    if (choice === "replace") {
      const old = matchesByEmail.get(r.email.toLowerCase());
      for (const m of old) {
        await db.query("INSERT INTO events(type, meta) VALUES ('contact_replaced', $1)", [
          JSON.stringify({ email: r.email, oldContactId: m.id, oldBatchId: m.batch_id, oldStatus: m.status }),
        ]);
      }
      await deleteContactsTx(db, old.map((m) => m.id), { force: true, audit: false });
      replaced++;
    } else if (choice === "keep") {
      const st = conflict.matches[0].status;
      warnings.push({ row: r.row, message: `Email is already in another batch (status: ${st})`, existingStatus: st });
    }
    toInsert.push(r);
  }
  return { toInsert, warnings, skipped, replaced };
}
