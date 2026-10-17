import { HttpError } from "../server/errors.js";
import { inTx, serializeContact } from "./contacts.js";
import { nextWindowOpen, windowBoundsFor, zonedInstant } from "./sendWindow.js";
import { assertLiveResume, noResumeError, resolveResume } from "./resumes.js";

export const MAX_DAYS_AHEAD = 90;
export const OVERDUE_MINUTES = 60;
const DAY_MS = 86_400_000;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function serializeMessage(r) {
  return {
    id: r.id,
    contactId: r.contact_id,
    kind: r.kind,
    state: r.state,
    scheduledFor: r.scheduled_for,
    sentAt: r.sent_at,
    attempts: r.attempts,
    error: r.error,
    dryRun: r.dry_run,
    resumeId: r.resume_id ?? null,
    createdAt: r.created_at,
  };
}

const bad = (msg) => new HttpError(400, msg);

// sendAt must be an ISO-8601 instant WITH an offset (or Z), strictly in the future, <= 90 days out.
export function validateSendAt(value, now = new Date()) {
  if (typeof value !== "string") throw bad("sendAt must be an ISO date-time string");
  const m = ISO_INSTANT.exec(value);
  if (!m) throw bad("sendAt must be an ISO date-time with a timezone, e.g. 2026-10-20T09:00:00Z");
  const [, y, mo, d, h, mi, s = "0"] = m;
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (probe.getUTCFullYear() !== +y || probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) {
    throw bad("sendAt is not a valid date");
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw bad("sendAt is not a valid date");
  if (at.getTime() <= now.getTime()) throw bad("sendAt must be in the future");
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) throw bad(`sendAt must be within ${MAX_DAYS_AHEAD} days`);
  return at;
}

// count send times starting at `start`, `staggerMinutes` apart, in order.
export function planStagger(start, count, staggerMinutes = 0) {
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * staggerMinutes * 60_000));
}

// Stagger as "one slot every N minutes, packed into the send window": the start moves to the next window opening
// (if outside it), slots = how many N-minute steps fit before the window closes, and the emails are spread evenly
// over them (ceil(count / slots) per slot, in order). Stagger 0 = everything at `start`, untouched.
export function planWindowStagger(start, count, staggerMinutes, window) {
  if (!(staggerMinutes > 0)) return { times: Array.from({ length: count }, () => new Date(start.getTime())), start, slots: 1, perSlot: count };
  const from = nextWindowOpen(window, start);
  const step = staggerMinutes * 60_000;
  const { close } = windowBoundsFor(window, from);
  const slots = Math.max(1, Math.floor((close.getTime() - from.getTime()) / step));
  const perSlot = Math.max(1, Math.ceil(count / slots));
  const times = Array.from({ length: count }, (_, i) => new Date(from.getTime() + Math.floor(i / perSlot) * step));
  return { times, start: from, slots, perSlot };
}

export class RefusedError extends HttpError {
  constructor(refused) {
    super(409, "Some contacts cannot be scheduled", { refused });
  }
}

const BLOCKING_STATUS = new Set(["replied", "bounced", "opted_out", "failed"]);

// Why a locked contact row (with .suppressed / .other_status) may not be (re)scheduled, or null.
export function refusalReason(row, { allowScheduled = false, allowSent = false } = {}) {
  if (BLOCKING_STATUS.has(row.status)) return row.status;
  if (row.suppressed) return "suppressed";
  if (row.other_status) return `other_batch_${row.other_status}`;
  if (row.status === "sent" && !allowSent) return "already_sent";
  if (row.status === "scheduled" && !allowScheduled) return "already_scheduled";
  return null;
}

// Locks the contacts (sorted, to avoid deadlocks) and returns them with the suppression and
// cross-batch flags computed under the lock. Cross-batch: the same email (case-insensitive)
// exists as replied/bounced/opted_out in ANY other contact row.
export async function lockContactsForScheduling(db, ids) {
  await db.query("SELECT id FROM contacts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
  const { rows } = await db.query(
    `SELECT c.*,
            EXISTS (SELECT 1 FROM suppressions s WHERE s.email = lower(c.email)) AS suppressed,
            (SELECT c2.status FROM contacts c2
              WHERE lower(c2.email) = lower(c.email) AND c2.id <> c.id
                AND c2.status IN ('replied','bounced','opted_out')
              ORDER BY c2.status LIMIT 1) AS other_status
       FROM contacts c WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

const refusal = (row, reason) => ({ contactId: row.id, email: row.email, reason });

function mapUnique(err) {
  if (err?.code === "23505") return new HttpError(409, "A message is already scheduled for this contact");
  return err;
}

// All-or-nothing: if any contact is refused, nothing is scheduled and the 409 body names every
// refused contact with a reason.
// `resumeId`: undefined = leave the batch choice alone, null = clear it, uuid = set it. `requireResume`: refuse when
// a contact would go out with no resume at all (real mode without a legacy RESUME_PATH).
export async function scheduleBulk(pool, { batchId, contactIds, sendAt, staggerMinutes = 0, times: plannedTimes, resumeId, requireResume = false }) {
  const b = await pool.query("SELECT id FROM batches WHERE id = $1", [batchId]);
  if (!b.rowCount) throw new HttpError(404, "Batch not found");
  const times = plannedTimes ?? planStagger(sendAt, contactIds.length, staggerMinutes);
  try {
    return await inTx(pool, async (db) => {
      const rows = await lockContactsForScheduling(db, contactIds);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const refused = [];
      for (const id of contactIds) {
        const row = byId.get(id);
        if (!row || row.batch_id !== batchId) {
          refused.push({ contactId: id, email: row && row.batch_id !== batchId ? row.email : null, reason: "not_in_batch" });
          continue;
        }
        const reason = refusalReason(row);
        if (reason) refused.push(refusal(row, reason));
      }
      if (refused.length) throw new RefusedError(refused);
      if (resumeId !== undefined) {
        if (resumeId) await assertLiveResume(db, resumeId);
        await db.query("UPDATE batches SET resume_id = $2 WHERE id = $1", [batchId, resumeId]);
      }
      const out = [];
      for (const [i, id] of contactIds.entries()) {
        const resume = await resolveResume(db, id);
        if (!resume && requireResume) throw noResumeError();
        const m = await db.query(
          `INSERT INTO messages(contact_id, kind, state, scheduled_for, resume_id, resume_generation) VALUES ($1, 'initial', 'scheduled', $2, $3, $4) RETURNING *`,
          [id, times[i], resume?.id ?? null, resume?.generation ?? null],
        );
        await db.query("UPDATE contacts SET status = 'scheduled' WHERE id = $1", [id]);
        await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'scheduled', $2)", [
          id,
          JSON.stringify({ messageId: m.rows[0].id, scheduledFor: times[i].toISOString() }),
        ]);
        out.push(serializeMessage(m.rows[0]));
      }
      return out;
    });
  } catch (err) {
    throw mapUnique(err);
  }
}

// Schedule, or reschedule an unsent initial, for one contact.
// `resumeId` (undefined = keep what is snapshotted; null/uuid = set the contact's override and re-snapshot).
export async function scheduleContact(pool, contactId, sendAt, { resumeId, requireResume = false } = {}) {
  try {
    return await inTx(pool, async (db) => {
      const rows = await lockContactsForScheduling(db, [contactId]);
      if (!rows.length) throw new HttpError(404, "Contact not found");
      const row = rows[0];
      const reason = refusalReason(row, { allowScheduled: true });
      if (reason) throw new RefusedError([refusal(row, reason)]);
      const live = await db.query(
        "SELECT * FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state <> 'cancelled' FOR UPDATE",
        [contactId],
      );
      if (resumeId !== undefined) {
        if (resumeId) await assertLiveResume(db, resumeId);
        await db.query("UPDATE contacts SET resume_id = $2 WHERE id = $1", [contactId, resumeId]);
      }
      let msg;
      if (!live.rowCount) {
        const resume = await resolveResume(db, contactId);
        if (!resume && requireResume) throw noResumeError();
        msg = (
          await db.query(
            `INSERT INTO messages(contact_id, kind, state, scheduled_for, resume_id, resume_generation) VALUES ($1, 'initial', 'scheduled', $2, $3, $4) RETURNING *`,
            [contactId, sendAt, resume?.id ?? null, resume?.generation ?? null],
          )
        ).rows[0];
      } else if (live.rows[0].state === "scheduled") {
        if (resumeId !== undefined) {
          const resume = await resolveResume(db, contactId);
          if (!resume && requireResume) throw noResumeError();
          msg = (
            await db.query("UPDATE messages SET scheduled_for = $2, resume_id = $3, resume_generation = $4 WHERE id = $1 RETURNING *", [live.rows[0].id, sendAt, resume?.id ?? null, resume?.generation ?? null])
          ).rows[0];
        } else {
          msg = (await db.query("UPDATE messages SET scheduled_for = $2 WHERE id = $1 RETURNING *", [live.rows[0].id, sendAt])).rows[0];
        }
      } else {
        throw new HttpError(409, `Message is already ${live.rows[0].state} and cannot be rescheduled`);
      }
      await db.query("UPDATE contacts SET status = 'scheduled' WHERE id = $1", [contactId]);
      await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, $2, $3)", [
        contactId,
        live.rowCount ? "rescheduled" : "scheduled",
        JSON.stringify({ messageId: msg.id, scheduledFor: sendAt.toISOString() }),
      ]);
      return serializeMessage(msg);
    });
  } catch (err) {
    throw mapUnique(err);
  }
}

// Cancels a still-`scheduled` message. A message the worker already claimed cannot be cancelled here.
export async function cancelMessage(pool, messageId) {
  return inTx(pool, async (db) => {
    const found = await db.query("SELECT contact_id FROM messages WHERE id = $1", [messageId]);
    if (!found.rowCount) throw new HttpError(404, "Message not found");
    const contactId = found.rows[0].contact_id;
    await db.query("SELECT id FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
    const upd = await db.query(
      "UPDATE messages SET state = 'cancelled' WHERE id = $1 AND state = 'scheduled' RETURNING *",
      [messageId],
    );
    if (!upd.rowCount) throw new HttpError(409, "Only a scheduled message can be cancelled");
    const msg = upd.rows[0];
    if (msg.kind === "initial") {
      await db.query("UPDATE contacts SET status = 'uploaded' WHERE id = $1 AND status = 'scheduled'", [contactId]);
    } else {
      await db.query("UPDATE contacts SET followup_requested = false WHERE id = $1", [contactId]);
    }
    await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'message_cancelled', $2)", [
      contactId,
      JSON.stringify({ messageId, kind: msg.kind, source: "manual" }),
    ]);
    const c = await db.query("SELECT * FROM contacts WHERE id = $1", [contactId]);
    return { message: serializeMessage(msg), contact: serializeContact(c.rows[0]) };
  });
}

// A `needs_review` message is one whose delivery is unknown (ambiguous SMTP failure, or a send
// that was in flight for >10 minutes). The operator checks the Sent folder and decides:
//   mark_sent  it did go out   -> message sent; initial -> contact sent (+ follow-up if ticked)
//   requeue    it did not      -> scheduled again now with a fresh retry budget; the stored Message-ID is kept so threading and reply
//                                detection stay consistent. Duplicate delivery is NOT prevented: if it did go out, the
//                                recipient may get the email twice
//   cancel     drop it         -> cancelled; initial -> contact back to uploaded, follow-up -> flag cleared
export const RESOLVE_ACTIONS = ["mark_sent", "requeue", "cancel"];
const BLOCKED_CONTACT = new Set(["replied", "opted_out", "bounced", "failed"]);

export async function resolveMessage(pool, messageId, action, now = new Date()) {
  return inTx(pool, async (db) => {
    const found = await db.query("SELECT contact_id FROM messages WHERE id = $1", [messageId]);
    if (!found.rowCount) throw new HttpError(404, "Message not found");
    const contactId = found.rows[0].contact_id;
    // Same lock order as the worker (contact, then message).
    const cRes = await db.query("SELECT * FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
    const mRes = await db.query("SELECT * FROM messages WHERE id = $1 FOR UPDATE", [messageId]);
    const contact = cRes.rows[0];
    const msg = mRes.rows[0];
    if (msg.state !== "needs_review") throw new HttpError(409, "Only a message that needs review can be resolved");

    let updated;
    if (action === "mark_sent") {
      updated = (await db.query("UPDATE messages SET state = 'sent', sent_at = $2, error = NULL WHERE id = $1 RETURNING *", [messageId, now])).rows[0];
      if (msg.kind === "initial") {
        await db.query("UPDATE contacts SET status = 'sent', error = NULL WHERE id = $1 AND status = 'scheduled'", [contactId]);
        await db.query(
          `INSERT INTO messages(contact_id, kind, state, scheduled_for, resume_id, resume_generation)
           SELECT c.id, 'followup', 'scheduled', $2, $3, $4 FROM contacts c
            WHERE c.id = $1 AND c.followup_requested AND c.status = 'sent'
              AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = lower(c.email))
           ON CONFLICT (contact_id, kind) WHERE state <> 'cancelled' DO NOTHING`,
          [contactId, followupDueAt(now, contact.followup_delay_days, contact.followup_at), msg.resume_id, msg.resume_generation],
        );
      }
    } else if (action === "requeue") {
      if (BLOCKED_CONTACT.has(contact.status)) throw new HttpError(409, `Contact is ${contact.status}; the message cannot be sent again`);
      const sup = await db.query("SELECT 1 FROM suppressions WHERE email = lower($1)", [contact.email]);
      if (sup.rowCount) throw new HttpError(409, "Email is suppressed; the message cannot be sent again");
      updated = (
        await db.query("UPDATE messages SET state = 'scheduled', scheduled_for = $2, claimed_at = NULL, attempts = 0, error = NULL WHERE id = $1 RETURNING *", [messageId, now])
      ).rows[0];
    } else {
      updated = (await db.query("UPDATE messages SET state = 'cancelled' WHERE id = $1 RETURNING *", [messageId])).rows[0];
      if (msg.kind === "initial") {
        await db.query("UPDATE contacts SET status = 'uploaded' WHERE id = $1 AND status = 'scheduled'", [contactId]);
      } else {
        await db.query("UPDATE contacts SET followup_requested = false WHERE id = $1", [contactId]);
      }
    }
    await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'needs_review_resolved', $2)", [
      contactId,
      JSON.stringify({ messageId, kind: msg.kind, action, source: "manual" }),
    ]);
    const c = await db.query("SELECT * FROM contacts WHERE id = $1", [contactId]);
    return { message: serializeMessage(updated), contact: serializeContact(c.rows[0]) };
  });
}

// A picked calendar date -> the send-window opening on that day in the window's tz. Today (in that tz) or later, <= 90 days out.
// Today after its opening has passed -> the next moment sending is allowed (now inside the window, else the next opening).
export function followupInstant(dateStr, window, now = new Date()) {
  const m = typeof dateStr === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr) : null;
  if (!m) throw bad("date must be YYYY-MM-DD");
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw bad("date is not a valid date");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: window.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (dateStr < today) throw bad("date must be today or later");
  const [sh, sm] = window.start.split(":").map(Number);
  const opening = zonedInstant(window.tz, y, mo, d, sh, sm);
  const at = opening.getTime() < now.getTime() ? nextWindowOpen(window, now) : opening;
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) throw bad(`date must be within ${MAX_DAYS_AHEAD} days`);
  return at;
}

// A picked instant wins when it is at least a day after the first send; otherwise (none picked, or a date on/before
// the send day) the follow-up goes at sent_at + delay, so it never lands minutes after the initial.
export const followupDueAt = (sentAt, delayDays, followupAt = null) => {
  const sent = new Date(sentAt).getTime();
  const picked = followupAt ? new Date(followupAt).getTime() : null;
  return new Date(picked !== null && picked >= sent + DAY_MS ? picked : sent + delayDays * DAY_MS);
};

// Follow-up checkbox. See the API section of the plan.
// `date` (YYYY-MM-DD, needs `window`) sets followup_at; `delayDays` sets the delay and clears followup_at.
export async function syncFollowup(pool, contactId, { enabled, delayDays, date, window, now = new Date() }) {
  if (date !== undefined && delayDays !== undefined) throw bad("Send either date or delayDays, not both");
  const pickedAt = date === undefined ? undefined : followupInstant(date, window, now);
  try {
    return await inTx(pool, async (db) => {
      const rows = await lockContactsForScheduling(db, [contactId]);
      if (!rows.length) throw new HttpError(404, "Contact not found");
      const row = rows[0];
      if (enabled) {
        const reason = refusalReason(row, { allowScheduled: true, allowSent: true });
        if (reason) throw new RefusedError([refusal(row, reason)]);
      }
      const delay = delayDays ?? row.followup_delay_days;
      const upd = await db.query(
        `UPDATE contacts SET followup_requested = $2, followup_delay_days = $3,
                followup_at = CASE WHEN $4::boolean THEN $5::timestamptz WHEN $6::boolean THEN NULL ELSE followup_at END
          WHERE id = $1 RETURNING *`,
        [contactId, enabled, delay, pickedAt !== undefined, pickedAt ?? null, delayDays !== undefined],
      );
      const followupAt = upd.rows[0].followup_at;
      let followup = null;
      const live = await db.query(
        "SELECT * FROM messages WHERE contact_id = $1 AND kind = 'followup' AND state <> 'cancelled' FOR UPDATE",
        [contactId],
      );
      if (!enabled) {
        const cancelled = await db.query(
          "UPDATE messages SET state = 'cancelled' WHERE contact_id = $1 AND kind = 'followup' AND state = 'scheduled' RETURNING id",
          [contactId],
        );
        await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'followup_disabled', $2)", [
          contactId,
          JSON.stringify({ cancelledMessages: cancelled.rowCount }),
        ]);
      } else {
        if (row.status === "sent") {
          const init = await db.query(
            "SELECT sent_at, resume_id, resume_generation FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state = 'sent' ORDER BY sent_at DESC LIMIT 1",
            [contactId],
          );
          if (init.rowCount) {
            const due = followupDueAt(init.rows[0].sent_at, delay, followupAt);
            if (!live.rowCount) {
              followup = (
                await db.query(
                  "INSERT INTO messages(contact_id, kind, state, scheduled_for, resume_id, resume_generation) VALUES ($1, 'followup', 'scheduled', $2, $3, $4) RETURNING *",
                  [contactId, due, init.rows[0].resume_id, init.rows[0].resume_generation],
                )
              ).rows[0];
            } else if (live.rows[0].state === "scheduled") {
              followup = (await db.query("UPDATE messages SET scheduled_for = $2 WHERE id = $1 RETURNING *", [live.rows[0].id, due])).rows[0];
            } else {
              followup = live.rows[0];
            }
          }
        } else if (live.rowCount) {
          followup = live.rows[0];
        }
        await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'followup_enabled', $2)", [
          contactId,
          JSON.stringify({ delayDays: delay, followupAt }),
        ]);
      }
      return { contact: serializeContact(upd.rows[0]), followup: followup ? serializeMessage(followup) : null };
    });
  } catch (err) {
    throw mapUnique(err);
  }
}

// Applies syncFollowup to every contact of a batch (optionally one company, exact case-insensitive).
// A contact syncFollowup refuses (replied, bounced, suppressed, ...) is skipped; anything else fails the request.
export async function setFollowupBulk(pool, { batchId, company, enabled, date, window, now = new Date() }) {
  if (enabled && date === undefined) throw bad("date is required to enable follow-ups");
  if (!enabled && date !== undefined) throw bad("date is only allowed when enabling follow-ups");
  if (enabled) followupInstant(date, window, now); // reject a bad date before any write
  if (!(await pool.query("SELECT 1 FROM batches WHERE id = $1", [batchId])).rowCount) throw new HttpError(404, "Batch not found");
  const { rows } = await pool.query(
    "SELECT id FROM contacts WHERE batch_id = $1 AND ($2::text IS NULL OR lower(btrim(company)) = lower($2)) ORDER BY created_at, id",
    [batchId, company ?? null],
  );
  let updated = 0;
  let skipped = 0;
  for (const { id } of rows) {
    try {
      await syncFollowup(pool, id, { enabled, date, window, now });
      updated++;
    } catch (err) {
      if (!(err instanceof RefusedError)) throw err;
      skipped++;
    }
  }
  return { updated, skipped, total: rows.length };
}

// Scheduled messages whose time passed more than OVERDUE_MINUTES ago (window closed, pacing/cap did not fit them).
export async function listOverdue(pool, now = new Date()) {
  const cutoff = new Date(now.getTime() - OVERDUE_MINUTES * 60_000);
  const [{ rows: cnt }, { rows }] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM messages WHERE state = 'scheduled' AND scheduled_for <= $1", [cutoff]),
    pool.query(
      `SELECT m.id, m.contact_id, m.kind, m.scheduled_for, c.email, c.person, b.name AS batch_name
         FROM messages m JOIN contacts c ON c.id = m.contact_id JOIN batches b ON b.id = c.batch_id
        WHERE m.state = 'scheduled' AND m.scheduled_for <= $1
        ORDER BY m.scheduled_for, m.created_at, m.id LIMIT 500`,
      [cutoff],
    ),
  ]);
  return {
    count: cnt[0].n,
    overdueMinutes: OVERDUE_MINUTES,
    messages: rows.map((r) => ({
      id: r.id, contactId: r.contact_id, email: r.email, person: r.person, kind: r.kind, scheduledFor: r.scheduled_for, batchName: r.batch_name,
    })),
  };
}

// Moves overdue scheduled messages to `start` (or the next window opening), packed by planWindowStagger.
// `messageIds` undefined = every overdue message. Anything no longer scheduled/overdue once locked is skipped.
export async function rescheduleOverdue(pool, { window, now, sendAt, staggerMinutes, messageIds }) {
  const cutoff = new Date(now.getTime() - OVERDUE_MINUTES * 60_000);
  return inTx(pool, async (db) => {
    // Lock in id order (deadlock-safe); the WHERE is re-evaluated against the locked row version.
    const { rows } = await db.query(
      `SELECT * FROM messages
        WHERE state = 'scheduled' AND scheduled_for <= $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
        ORDER BY id FOR UPDATE`,
      [cutoff, messageIds ?? null],
    );
    if (!rows.length) return { rescheduled: 0, messages: [], plan: null };
    rows.sort((a, b) => a.scheduled_for - b.scheduled_for || a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    const plan = planWindowStagger(sendAt ?? nextWindowOpen(window, now), rows.length, staggerMinutes, window);
    const last = plan.times.at(-1);
    if (last.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) throw bad(`Rescheduled times must all be within ${MAX_DAYS_AHEAD} days`);
    const out = [];
    for (const [i, r] of rows.entries()) {
      const upd = await db.query("UPDATE messages SET scheduled_for = $2 WHERE id = $1 RETURNING *", [r.id, plan.times[i]]);
      await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'rescheduled', $2)", [
        r.contact_id,
        JSON.stringify({ messageId: r.id, scheduledFor: plan.times[i].toISOString(), source: "overdue" }),
      ]);
      out.push(serializeMessage(upd.rows[0]));
    }
    return { rescheduled: out.length, messages: out, plan: { start: plan.start.toISOString(), slots: plan.slots, perSlot: plan.perSlot, staggerMinutes, window } };
  });
}
