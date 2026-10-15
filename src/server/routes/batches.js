import { readFileSync } from "node:fs";
import express, { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { parseCsv, validateRows, CsvFileError, MAX_ROWS } from "../../import/parseCsv.js";
import { renderInitialPreview } from "../../domain/render.js";
import { describeAttachments } from "../../domain/resumes.js";
import { deleteBatch, inTx, serializeBatch, serializeContact } from "../../domain/contacts.js";
import { buildConflicts, findMatches, insertBatch, resolveConflicts } from "../../domain/importBatch.js";

const MAX_UPLOAD_BYTES = 1024 * 1024;
const uuid = z.uuid();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 1024 },
  fileFilter(_req, file, cb) {
    if (!/\.csv$/i.test(file.originalname)) return cb(new HttpError(400, "Only .csv files are accepted"));
    cb(null, true);
  },
}).single("file");

function receiveUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "File too large (limit 1MB)"));
      return next(new HttpError(400, "Invalid upload"));
    }
    next(new HttpError(400, "Invalid upload"));
  });
}

const bodySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .max(120)
    .regex(/^[^\p{Cc}]*$/u, "name must not contain control characters")
    .optional(),
});

const text = (max) => z.string().max(max);
const commitBody = z.strictObject({
  name: z
    .string()
    .trim()
    .max(120)
    .regex(/^[^\p{Cc}]*$/u, "name must not contain control characters")
    .optional(),
  filename: z.string().max(200).optional(),
  rows: z
    .array(
      z.strictObject({
        row: z.number().int().min(1).max(1_000_000).optional(),
        company: text(1000),
        role: text(1000),
        person: text(1000),
        email: text(1000),
        subject: text(1000),
        mailText: text(100_000),
        followupText: text(100_000).nullable(),
      }),
    )
    .min(1)
    .max(MAX_ROWS),
  resolutions: z.record(z.string().max(254), z.enum(["skip", "replace", "keep"])).optional(),
});

// multer decodes filenames as latin1; recover UTF-8 then strip anything unsafe for display.
export function defaultBatchName(originalname) {
  let n = originalname;
  try {
    n = Buffer.from(originalname, "latin1").toString("utf8");
  } catch {}
  n = n
    .replace(/\.csv$/i, "")
    .replace(/[\p{Cc}<>"'`\\/]/gu, "")
    .trim()
    .slice(0, 120)
    .trim();
  return n || "Imported batch";
}

function loadSignature(config) {
  if (config?.signatureHtml) return config.signatureHtml;
  if (!config?.signaturePath) return "";
  try {
    return readFileSync(config.signaturePath, "utf8");
  } catch {
    return "";
  }
}

export function batchesRouter({ pool, config }) {
  const router = Router();
  const signatureHtml = loadSignature(config);
  const withPreview = (row, attachment = null) => ({ ...serializeContact(row), attachment, preview: renderInitialPreview({ subject: row.subject, mailText: row.mail_text }, signatureHtml) });

  router.post("/", receiveUpload, async (req, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, "A CSV file is required in the 'file' field");
      const parsedBody = bodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) throw new HttpError(400, parsedBody.error.issues[0]?.message ?? "Invalid fields");
      const name = parsedBody.data.name || defaultBatchName(req.file.originalname);
      const filename = defaultBatchName(req.file.originalname) + ".csv";

      const sup = await pool.query("SELECT email FROM suppressions");
      let parsed;
      try {
        parsed = parseCsv(req.file.buffer, { suppressed: new Set(sup.rows.map((r) => r.email)) });
      } catch (err) {
        if (err instanceof CsvFileError) throw new HttpError(400, err.message);
        throw err;
      }
      const { rows, errors } = parsed;
      if (rows.length === 0) {
        return res.status(422).json({ error: "No valid rows to import", errors });
      }

      const existing = await pool.query(
        `SELECT DISTINCT ON (lower(email)) lower(email) AS email, status FROM contacts
          WHERE lower(email) = ANY($1::text[]) ORDER BY lower(email), created_at DESC`,
        [rows.map((r) => r.email.toLowerCase())],
      );
      const existingStatus = new Map(existing.rows.map((r) => [r.email, r.status]));
      const rowByEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r.row]));
      const warnings = rows
        .filter((r) => existingStatus.has(r.email.toLowerCase()))
        .map((r) => {
          const st = existingStatus.get(r.email.toLowerCase());
          return { row: r.row, message: `Email is already in another batch (status: ${st})`, existingStatus: st };
        });

      const result = await inTx(pool, (db) => insertBatch(db, { name, filename, userId: req.session.userId, rows, rejected: errors.length }));
      const attachments = await describeAttachments(pool, result.contacts.map((c) => c.id), config);
      res.status(201).json({
        batch: serializeBatch(result.batch),
        // `row` = the contact's line in the uploaded file (emails are unique per batch).
        contacts: result.contacts.map((c) => ({ ...withPreview(c, attachments.get(c.id) ?? null), row: rowByEmail.get(c.email.toLowerCase()) ?? null })),
        errors,
        warnings,
      });
    } catch (err) {
      next(err);
    }
  });

  // Parses and validates the upload and reports duplicates; writes nothing.
  router.post("/preview", receiveUpload, async (req, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, "A CSV file is required in the 'file' field");
      const suggestedName = defaultBatchName(req.file.originalname);
      const sup = await pool.query("SELECT email FROM suppressions");
      let parsed;
      try {
        parsed = parseCsv(req.file.buffer, { suppressed: new Set(sup.rows.map((r) => r.email)) });
      } catch (err) {
        if (err instanceof CsvFileError) throw new HttpError(400, err.message);
        throw err;
      }
      const { rows, errors } = parsed;
      if (rows.length === 0) return res.status(422).json({ error: "No valid rows to import", errors });
      const conflicts = buildConflicts(rows, await findMatches(pool, rows.map((r) => r.email)));
      res.json({ filename: suggestedName + ".csv", suggestedName, rows, errors, conflicts });
    } catch (err) {
      next(err);
    }
  });

  // Creates the batch from (possibly edited) preview rows, applying a decision per duplicate email. All or nothing.
  // The global JSON parser skips this path (see app.js); 500 full-size rows exceed its 100kb limit.
  router.post("/commit", express.json({ limit: "8mb" }), async (req, res, next) => {
    try {
      const body = commitBody.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Invalid request body");
      const { rows: input, resolutions = {}, filename } = body.data;
      const name = body.data.name || (filename ? defaultBatchName(filename) : "Imported batch");

      const out = await inTx(pool, async (db) => {
        const sup = await db.query("SELECT email FROM suppressions");
        const { rows, errors } = validateRows(input, { suppressed: new Set(sup.rows.map((r) => r.email)) });
        if (errors.length) return { refusal: { status: 422, body: { error: "Some rows are invalid", errors } } };
        const matches = await findMatches(db, rows.map((r) => r.email), { lock: true });
        const resolved = await resolveConflicts(db, rows, matches, resolutions);
        if (resolved.refusal) return resolved;
        if (resolved.toInsert.length === 0) return { refusal: { status: 422, body: { error: "Nothing to import: every row was skipped" } } };
        const created = await insertBatch(db, {
          name,
          filename: filename ? defaultBatchName(filename) + ".csv" : null,
          userId: req.session.userId,
          rows: resolved.toInsert,
          rejected: 0,
        });
        return { ...resolved, ...created };
      });
      if (out.refusal) return res.status(out.refusal.status).json(out.refusal.body);

      const rowByEmail = new Map(out.toInsert.map((r) => [r.email.toLowerCase(), r.row]));
      const attachments = await describeAttachments(pool, out.contacts.map((c) => c.id), config);
      res.status(201).json({
        batch: serializeBatch(out.batch),
        contacts: out.contacts.map((c) => ({ ...withPreview(c, attachments.get(c.id) ?? null), row: rowByEmail.get(c.email.toLowerCase()) ?? null })),
        errors: [],
        warnings: out.warnings,
        skipped: out.skipped,
        replaced: out.replaced,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.*, (SELECT count(*)::int FROM contacts c WHERE c.batch_id = b.id) AS contact_count
           FROM batches b ORDER BY b.created_at DESC, b.id`,
      );
      const counts = await pool.query("SELECT batch_id, status, count(*)::int AS n FROM contacts GROUP BY batch_id, status");
      const byBatch = new Map();
      for (const r of counts.rows) byBatch.set(r.batch_id, { ...(byBatch.get(r.batch_id) ?? {}), [r.status]: r.n });
      res.json({
        batches: rows.map((r) => ({ ...serializeBatch(r), contactCount: r.contact_count, statusCounts: byBatch.get(r.id) ?? {} })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) throw new HttpError(400, "Invalid batch id");
      const b = await pool.query("SELECT * FROM batches WHERE id = $1", [id.data]);
      if (!b.rowCount) throw new HttpError(404, "Batch not found");
      const c = await pool.query("SELECT * FROM contacts WHERE batch_id = $1 ORDER BY created_at, id", [id.data]);
      const attachments = await describeAttachments(pool, c.rows.map((r) => r.id), config);
      res.json({ batch: serializeBatch(b.rows[0]), contacts: c.rows.map((r) => withPreview(r, attachments.get(r.id) ?? null)) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) throw new HttpError(400, "Invalid batch id");
      const q = z.strictObject({ force: z.enum(["true", "false"]).optional() }).safeParse(req.query);
      if (!q.success) throw new HttpError(400, "Invalid query parameters");
      res.json(await deleteBatch(pool, id.data, { force: q.data.force === "true" }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
