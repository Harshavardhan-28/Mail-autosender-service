import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { cancelMessage, resolveMessage, RESOLVE_ACTIONS, scheduleBulk, scheduleContact, syncFollowup, validateSendAt, planStagger, planWindowStagger, listOverdue, rescheduleOverdue, MAX_DAYS_AHEAD } from "../../domain/schedule.js";
import { setContactResume } from "../../domain/resumes.js";
import { serializeContact } from "../../domain/contacts.js";
import { getSendWindow } from "../../domain/sendWindow.js";
import { getTemplate, putTemplate, templateSchema } from "../../domain/template.js";

// Normalised to lower case so the same id in two spellings is recognised as a duplicate.
const uuid = z.uuid().transform((v) => v.toLowerCase());
const MAX_STAGGER_MINUTES = 24 * 60;

const bulkBody = z.strictObject({
  contactIds: z.array(uuid).min(1).max(500),
  sendAt: z.string(),
  staggerMinutes: z.number().int().min(0).max(MAX_STAGGER_MINUTES).optional(),
  resumeId: uuid.nullable().optional(),
});
const rescheduleBody = z.strictObject({
  sendAt: z.string().optional(),
  staggerMinutes: z.number().int().min(0).max(MAX_STAGGER_MINUTES).optional(),
  messageIds: z.array(uuid).min(1).max(500).optional(),
});
const resolveBody = z.strictObject({ action: z.enum(RESOLVE_ACTIONS) });
const oneBody = z.strictObject({ sendAt: z.string(), resumeId: uuid.nullable().optional() });
const resumeBody = z.strictObject({ resumeId: uuid.nullable() });
const followupBody = z.strictObject({
  enabled: z.boolean(),
  delayDays: z.number().int().min(1).max(60).optional(),
  date: z.string().optional(),
});

const param = (req, label) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) throw new HttpError(400, `Invalid ${label} id`);
  return id.data;
};
const body = (schema, req) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ? `Invalid request: ${r.error.issues[0].path.join(".") || "body"}` : "Invalid request");
  return r.data;
};

// Mounted at /api. Handles only its own paths; everything else falls through.
export function schedulingRouter({ pool, config = {}, now = () => new Date() }) {
  const router = Router();
  // Real mode with no legacy RESUME_PATH: a mail must never go out because nobody picked a resume.
  const requireResume = !config.dryRun && !config.resumePath;
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.post("/batches/:id/schedule", wrap(async (req, res) => {
    const batchId = param(req, "batch");
    const b = body(bulkBody, req);
    if (new Set(b.contactIds).size !== b.contactIds.length) throw new HttpError(400, "contactIds must be unique");
    const sendAt = validateSendAt(b.sendAt, now());
    const stagger = b.staggerMinutes ?? 0;
    // stagger > 0: slot every N minutes, packed into the saved send window. stagger 0: sendAt untouched.
    const window = stagger > 0 ? await getSendWindow(pool) : null;
    const planned = window ? planWindowStagger(sendAt, b.contactIds.length, stagger, window) : planWindowStagger(sendAt, b.contactIds.length, 0, null);
    const last = planned.times.at(-1);
    if (last.getTime() > now().getTime() + MAX_DAYS_AHEAD * 86_400_000) {
      throw new HttpError(400, `Staggered times must all be within ${MAX_DAYS_AHEAD} days`);
    }
    const messages = await scheduleBulk(pool, { batchId, contactIds: b.contactIds, sendAt, staggerMinutes: stagger, times: planned.times, resumeId: b.resumeId, requireResume });
    res.status(201).json({ messages, plan: { start: planned.start.toISOString(), slots: planned.slots, perSlot: planned.perSlot, staggerMinutes: stagger, window } });
  }));

  router.get("/messages/overdue", wrap(async (_req, res) => {
    res.json(await listOverdue(pool, now()));
  }));

  router.post("/messages/reschedule-overdue", wrap(async (req, res) => {
    const b = body(rescheduleBody, req);
    const at = now();
    const sendAt = b.sendAt === undefined ? undefined : validateSendAt(b.sendAt, at);
    const window = await getSendWindow(pool);
    res.json(await rescheduleOverdue(pool, { window, now: at, sendAt, staggerMinutes: b.staggerMinutes ?? 5, messageIds: b.messageIds && [...new Set(b.messageIds)] }));
  }));

  router.put("/contacts/:id/schedule", wrap(async (req, res) => {
    const id = param(req, "contact");
    const b = body(oneBody, req);
    const sendAt = validateSendAt(b.sendAt, now());
    res.json({ message: await scheduleContact(pool, id, sendAt, { resumeId: b.resumeId, requireResume }) });
  }));

  router.put("/contacts/:id/resume", wrap(async (req, res) => {
    const id = param(req, "contact");
    const b = body(resumeBody, req);
    res.json({ contact: serializeContact(await setContactResume(pool, id, b.resumeId, { requireResume })) });
  }));

  router.put("/contacts/:id/followup", wrap(async (req, res) => {
    const id = param(req, "contact");
    const b = body(followupBody, req);
    if (b.date !== undefined && b.delayDays !== undefined) throw new HttpError(400, "Send either date or delayDays, not both");
    const at = now();
    const window = b.date === undefined ? undefined : await getSendWindow(pool);
    res.json(await syncFollowup(pool, id, { ...b, window, now: at }));
  }));

  router.delete("/messages/:id", wrap(async (req, res) => {
    res.json(await cancelMessage(pool, param(req, "message")));
  }));

  router.post("/messages/:id/resolve", wrap(async (req, res) => {
    const id = param(req, "message");
    res.json(await resolveMessage(pool, id, body(resolveBody, req).action, now()));
  }));

  router.get("/template/followup", wrap(async (_req, res) => {
    res.json({ template: await getTemplate(pool) });
  }));

  router.put("/template/followup", wrap(async (req, res) => {
    res.json({ template: await putTemplate(pool, body(templateSchema, req)) });
  }));

  return router;
}
