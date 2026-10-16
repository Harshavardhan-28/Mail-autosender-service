import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { describeAttachments } from "../../domain/resumes.js";
import { CONTACT_STATUSES, deleteContacts, markReplied, optOut, serializeContact } from "../../domain/contacts.js";

const uuid = z.uuid();

const listQuery = z.strictObject({
  status: z.enum(CONTACT_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  batchId: uuid.optional(),
  company: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const forceQuery = z.strictObject({ force: z.enum(["true", "false"]).optional() });
const bulkDeleteBody = z.strictObject({
  ids: z.array(uuid).min(1).max(500).refine((a) => new Set(a).size === a.length, "ids must be unique"),
  force: z.boolean().optional(),
});

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function contactsRouter({ pool, config = {} }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw new HttpError(400, "Invalid query parameters");
      const { status, q, batchId, company, page, pageSize } = parsed.data;
      const where = [];
      const params = [];
      const add = (v) => (params.push(v), `$${params.length}`);
      if (status) where.push(`status = ${add(status)}`);
      if (batchId) where.push(`batch_id = ${add(batchId)}`);
      if (company) where.push(`lower(company) = lower(${add(company)})`);
      if (q) {
        const p = add(`%${escapeLike(q)}%`);
        where.push(`(company ILIKE ${p} OR role ILIKE ${p} OR person ILIKE ${p} OR email ILIKE ${p} OR subject ILIKE ${p})`);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = await pool.query(`SELECT count(*)::int AS n FROM contacts ${clause}`, params);
      const limit = add(pageSize);
      const offset = add((page - 1) * pageSize);
      const { rows } = await pool.query(
        `SELECT * FROM contacts ${clause} ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      // Live (non-cancelled) messages per listed contact, so the UI can cancel/reschedule by id.
      const msgs = await pool.query(
        `SELECT id, contact_id, kind, state, scheduled_for, sent_at FROM messages
          WHERE contact_id = ANY($1::uuid[]) AND state <> 'cancelled' ORDER BY scheduled_for, id`,
        [rows.map((r) => r.id)],
      );
      const byContact = new Map();
      for (const m of msgs.rows) {
        const list = byContact.get(m.contact_id) ?? [];
        list.push({ id: m.id, kind: m.kind, state: m.state, scheduledFor: m.scheduled_for, sentAt: m.sent_at });
        byContact.set(m.contact_id, list);
      }
      const attachments = await describeAttachments(pool, rows.map((r) => r.id), config);
      res.json({
        contacts: rows.map((r) => ({ ...serializeContact(r), attachment: attachments.get(r.id) ?? null, messages: byContact.get(r.id) ?? [] })),
        total: total.rows[0].n,
        page,
        pageSize,
      });
    } catch (err) {
      next(err);
    }
  });

  const idParam = (req) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "Invalid contact id");
    return id.data;
  };

  router.delete("/:id", async (req, res, next) => {
    try {
      const id = idParam(req);
      const q = forceQuery.safeParse(req.query);
      if (!q.success) throw new HttpError(400, "Invalid query parameters");
      res.json(await deleteContacts(pool, [id], { force: q.data.force === "true" }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/delete", async (req, res, next) => {
    try {
      const body = bulkDeleteBody.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Invalid request body");
      res.json(await deleteContacts(pool, body.data.ids, { force: body.data.force === true }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/mark-replied", async (req, res, next) => {
    try {
      res.json({ contact: await markReplied(pool, idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/opt-out", async (req, res, next) => {
    try {
      res.json({ contact: await optOut(pool, idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const companiesQuery = z.strictObject({ batchId: uuid.optional() });

// Mounted at /api/companies (behind the global auth guard). Case-folded distinct companies with counts.
export function companiesRouter({ pool }) {
  const router = Router();
  router.get("/", async (req, res, next) => {
    try {
      const parsed = companiesQuery.safeParse(req.query);
      if (!parsed.success) throw new HttpError(400, "Invalid query parameters");
      const { batchId } = parsed.data;
      const { rows } = await pool.query(
        `SELECT min(company) AS company, count(*)::int AS count FROM contacts
          WHERE btrim(coalesce(company, '')) <> '' AND ($1::uuid IS NULL OR batch_id = $1::uuid)
          GROUP BY lower(company) ORDER BY lower(company), min(company)`,
        [batchId ?? null],
      );
      res.json({ companies: rows });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
