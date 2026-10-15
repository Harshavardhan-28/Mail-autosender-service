import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { MAIL_STATES, getMail, listMails } from "../../domain/mails.js";

const uuid = z.uuid();

const listQuery = z.strictObject({
  state: z.enum(MAIL_STATES).default("all"),
  kind: z.enum(["initial", "followup"]).optional(),
  q: z.string().trim().max(200).optional(),
  batchId: uuid.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// Mounted at /api. One row per live (non-cancelled) message: what went out and what will.
export function mailsRouter({ pool, config = {}, now = () => new Date() }) {
  const router = Router();

  router.get("/mails", async (req, res, next) => {
    try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw new HttpError(400, "Invalid query parameters");
      res.json(await listMails(pool, parsed.data, now()));
    } catch (err) {
      next(err);
    }
  });

  router.get("/mails/:id", async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) throw new HttpError(400, "Invalid mail id");
      res.json({ mail: await getMail(pool, id.data, { config, now: now() }) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
