import { HttpError } from "../server/errors.js";
import { describeAttachments } from "./resumes.js";
import { OVERDUE_MINUTES } from "./schedule.js";
import { renderMessagePreview } from "./render.js";
import { getTemplate } from "./template.js";
import { loadSignature } from "../worker/send.js";

export const MAIL_STATES = ["sent", "scheduled", "attention", "all"];
const STATE_GROUPS = { sent: ["sent"], scheduled: ["scheduled", "sending"], attention: ["needs_review", "failed"] };
const LIVE_STATES = Object.values(STATE_GROUPS).flat();

const ORDER = {
  sent: "m.sent_at DESC NULLS LAST, m.id",
  scheduled: "m.scheduled_for ASC, m.id",
  // Most recent activity: when it went out, else when it was due.
  other: "COALESCE(m.sent_at, m.scheduled_for) DESC, m.id",
};

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const rePrefixed = (s) => (/^\s*re:/i.test(s) ? s : `Re: ${s}`);

const select = (cutParam) => `
  SELECT m.id, m.kind, m.state, m.scheduled_for, m.sent_at, m.attempts, m.error, m.dry_run, m.message_id,
         (m.state = 'scheduled' AND m.scheduled_for <= $CUT) AS overdue,
         c.id AS c_id, c.person, c.company, c.role, c.email, c.status AS c_status, c.replied_at, c.subject,
         b.id AS b_id, b.name AS b_name
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    JOIN batches b ON b.id = c.batch_id`.replace("$CUT", cutParam);

export function serializeMail(r) {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    subject: r.kind === "followup" ? rePrefixed(r.subject) : r.subject,
    scheduledFor: r.scheduled_for,
    sentAt: r.sent_at,
    attempts: r.attempts,
    error: r.error,
    dryRun: r.dry_run,
    overdue: r.overdue,
    contact: { id: r.c_id, person: r.person, company: r.company, role: r.role, email: r.email, status: r.c_status, repliedAt: r.replied_at },
    batch: { id: r.b_id, name: r.b_name },
  };
}

const overdueCutoff = (now) => new Date(now.getTime() - OVERDUE_MINUTES * 60_000);

export async function listMails(pool, { state = "all", kind, q, batchId, company, page = 1, pageSize = 25 }, now = new Date()) {
  const params = [];
  const add = (v) => (params.push(v), `$${params.length}`);
  const where = [`m.state = ANY(${add(STATE_GROUPS[state] ?? LIVE_STATES)}::text[])`];
  if (kind) where.push(`m.kind = ${add(kind)}`);
  if (batchId) where.push(`c.batch_id = ${add(batchId)}`);
  if (company) where.push(`lower(c.company) = lower(${add(company)})`);
  if (q) {
    const p = add(`%${escapeLike(q)}%`);
    where.push(`(c.company ILIKE ${p} OR c.person ILIKE ${p} OR c.email ILIKE ${p} OR c.subject ILIKE ${p})`);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const [total, counts] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM messages m JOIN contacts c ON c.id = m.contact_id ${clause}`, params),
    pool.query(
      `SELECT count(*) FILTER (WHERE state = 'sent')::int AS sent,
              count(*) FILTER (WHERE state IN ('scheduled', 'sending'))::int AS scheduled,
              count(*) FILTER (WHERE state IN ('needs_review', 'failed'))::int AS attention
         FROM messages`,
    ),
  ]);
  const cut = add(overdueCutoff(now));
  const limit = add(pageSize);
  const offset = add((page - 1) * pageSize);
  const { rows } = await pool.query(`${select(cut)} ${clause} ORDER BY ${ORDER[state] ?? ORDER.other} LIMIT ${limit} OFFSET ${offset}`, params);
  return { mails: rows.map(serializeMail), total: total.rows[0].n, page, pageSize, counts: counts.rows[0] };
}

export async function getMail(pool, id, { config = {}, now = new Date() } = {}) {
  const found = await pool.query(`${select("$1")} WHERE m.id = $2 AND m.state <> 'cancelled'`, [overdueCutoff(now), id]);
  if (!found.rowCount) throw new HttpError(404, "Mail not found");
  const row = found.rows[0];
  const full = await pool.query(
    "SELECT c.*, m.resume_id AS m_resume_id FROM contacts c JOIN messages m ON m.contact_id = c.id WHERE m.id = $1",
    [id],
  );
  const contact = full.rows[0];
  const [template, attachments, related, initial, events] = await Promise.all([
    row.kind === "followup" ? getTemplate(pool) : null,
    describeAttachments(pool, [row.c_id], config),
    pool.query("SELECT id, kind, state FROM messages WHERE contact_id = $1 AND id <> $2 AND state <> 'cancelled'", [row.c_id, id]),
    row.kind === "followup"
      ? pool.query("SELECT id FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state <> 'cancelled'", [row.c_id])
      : null,
    pool.query(
      `SELECT type, at, meta FROM events
        WHERE contact_id = $1 AND (meta->>'messageId' = $2 OR type IN ('replied', 'opted_out'))
        ORDER BY at, id`,
      [row.c_id, id],
    ),
  ]);
  let signatureHtml = "";
  try {
    signatureHtml = loadSignature(config);
  } catch {
    // A preview never fails over an unreadable signature.
  }
  const preview = renderMessagePreview(row.kind, contact, template, signatureHtml);
  const other = related.rows[0];
  return {
    ...serializeMail(row),
    subject: preview.subject,
    body: preview.text,
    attachment: attachments.get(row.c_id) ?? null,
    messageId: row.message_id,
    threadedWith: initial?.rows[0]?.id ?? null,
    related: other ? { id: other.id, kind: other.kind, state: other.state } : null,
    timeline: events.rows.map((e) => ({ type: e.type, at: e.at, meta: e.meta })),
  };
}
