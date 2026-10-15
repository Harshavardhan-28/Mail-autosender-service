import { HttpError } from "../server/errors.js";

export const CONTACT_STATUSES = ["uploaded", "scheduled", "sent", "replied", "bounced", "opted_out", "failed"];

export function serializeContact(r) {
  return {
    id: r.id,
    batchId: r.batch_id,
    company: r.company,
    role: r.role,
    person: r.person,
    email: r.email,
    subject: r.subject,
    mailText: r.mail_text,
    followupText: r.followup_text,
    status: r.status,
    followupRequested: r.followup_requested,
    followupDelayDays: r.followup_delay_days,
    resumeId: r.resume_id ?? null,
    repliedAt: r.replied_at,
    error: r.error,
    createdAt: r.created_at,
  };
}

export function serializeBatch(r) {
  return { id: r.id, name: r.name, originalFilename: r.original_filename, resumeId: r.resume_id ?? null, createdAt: r.created_at };
}

async function inTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Cancels pending (scheduled) messages only; an in-flight 'sending' row is left to the worker.
const CANCEL_PENDING = `UPDATE messages SET state = 'cancelled' WHERE contact_id = ANY($1::uuid[]) AND state = 'scheduled' RETURNING contact_id`;

export async function markReplied(pool, id, { source = "manual", meta = {} } = {}) {
  return inTx(pool, async (db) => {
    const cur = await db.query("SELECT status FROM contacts WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rowCount) throw new HttpError(404, "Contact not found");
    if (cur.rows[0].status === "opted_out") throw new HttpError(409, "Contact has opted out");
    if (cur.rows[0].status === "replied") {
      // Idempotent: nothing to rewrite, no second event.
      const same = await db.query("SELECT * FROM contacts WHERE id = $1", [id]);
      return serializeContact(same.rows[0]);
    }
    const { rows } = await db.query(
      `UPDATE contacts SET status = 'replied', replied_at = COALESCE(replied_at, now()), followup_requested = false WHERE id = $1 RETURNING *`,
      [id],
    );
    const cancelled = await db.query(CANCEL_PENDING, [[id]]);
    await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'replied', $2)", [
      id,
      JSON.stringify({ ...meta, source, cancelledMessages: cancelled.rowCount }),
    ]);
    return serializeContact(rows[0]);
  });
}

// Suppresses the address, then stops every not-yet-final contact that shares it.
export async function optOut(pool, id) {
  return inTx(pool, async (db) => {
    const cur = await db.query("SELECT lower(email) AS email FROM contacts WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rowCount) throw new HttpError(404, "Contact not found");
    const email = cur.rows[0].email;
    await db.query(
      "INSERT INTO suppressions(email, reason) VALUES ($1, 'opt_out') ON CONFLICT (email) DO NOTHING",
      [email],
    );
    const affected = await db.query(
      `UPDATE contacts SET status = 'opted_out'
        WHERE (lower(email) = $1 AND status NOT IN ('opted_out', 'replied', 'bounced'))
           OR (id = $2 AND status <> 'opted_out')
        RETURNING id`,
      [email, id],
    );
    const ids = affected.rows.map((r) => r.id);
    const cancelled = await db.query(CANCEL_PENDING, [ids]);
    for (const cid of ids) {
      await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'opted_out', $2)", [
        cid,
        JSON.stringify({ source: "manual", cancelledMessages: cancelled.rows.filter((r) => r.contact_id === cid).length }),
      ]);
    }
    const { rows } = await db.query("SELECT * FROM contacts WHERE id = $1", [id]);
    return serializeContact(rows[0]);
  });
}

export { inTx };

// Contacts that already went out (or may have) need an explicit `force` to delete.
const PROTECTED_STATUSES = ["sent", "replied"];

// Locks the targets (sorted by id), enforces protection, audits and deletes them. Runs inside the caller's tx.
// Messages disappear via ON DELETE CASCADE (that is the cancel); events keep their rows with contact_id NULL.
export async function deleteContactsTx(db, ids, { force = false, audit = true } = {}) {
  const found = await db.query(
    `SELECT c.id, c.batch_id, c.email, c.status,
            EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.state IN ('sent', 'needs_review')) AS has_sent
       FROM contacts c WHERE c.id = ANY($1::uuid[]) ORDER BY c.id FOR UPDATE OF c`,
    [ids],
  );
  const protectedCount = found.rows.filter((r) => PROTECTED_STATUSES.includes(r.status) || r.has_sent).length;
  if (protectedCount && !force) {
    throw new HttpError(409, "Some contacts were already emailed; confirm to delete them anyway", { code: "needs_force", protectedCount });
  }
  for (const r of audit ? found.rows : []) {
    await db.query("INSERT INTO events(type, meta) VALUES ('contact_deleted', $1)", [
      JSON.stringify({ email: r.email, batchId: r.batch_id, status: r.status }),
    ]);
  }
  await db.query("DELETE FROM contacts WHERE id = ANY($1::uuid[])", [found.rows.map((r) => r.id)]);
  return found.rows;
}

export async function deleteContacts(pool, ids, { force = false } = {}) {
  return inTx(pool, async (db) => {
    const removed = await deleteContactsTx(db, ids, { force });
    if (!removed.length) throw new HttpError(404, ids.length === 1 ? "Contact not found" : "No matching contacts found");
    return { deleted: removed.length };
  });
}

export async function deleteBatch(pool, batchId, { force = false } = {}) {
  return inTx(pool, async (db) => {
    const b = await db.query("SELECT * FROM batches WHERE id = $1 FOR UPDATE", [batchId]);
    if (!b.rowCount) throw new HttpError(404, "Batch not found");
    const ids = (await db.query("SELECT id FROM contacts WHERE batch_id = $1 ORDER BY id", [batchId])).rows.map((r) => r.id);
    const removed = await deleteContactsTx(db, ids, { force });
    await db.query("DELETE FROM batches WHERE id = $1", [batchId]);
    await db.query("INSERT INTO events(type, meta) VALUES ('batch_deleted', $1)", [
      JSON.stringify({ batchId, name: b.rows[0].name, contacts: removed.length }),
    ]);
    return { deleted: removed.length, batchId };
  });
}
