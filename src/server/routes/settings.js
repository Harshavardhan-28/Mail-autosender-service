import { Router } from "express";
import { HttpError } from "../errors.js";
import { getSendWindow, putSendWindow, sendWindowSchema } from "../../domain/sendWindow.js";
import { attachmentNameSchema, getAttachmentName, putAttachmentName, resetAttachmentName } from "../../domain/attachmentName.js";

// Mounted at /api, behind requireAuth + requireCsrf.
export function settingsRouter({ pool, config }) {
  const router = Router();
  const enforced = config.sendWindowEnforced === true;
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  // `enforced` tells the UI whether the window actually gates sending (production) or is informational (local dev).
  router.get("/settings/send-window", wrap(async (_req, res) => {
    res.json({ enforced, window: await getSendWindow(pool) });
  }));

  router.put("/settings/send-window", wrap(async (req, res) => {
    const parsed = sendWindowSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, `Invalid send window: ${parsed.error.issues[0]?.message ?? "check the values"}`);
    res.json({ enforced, window: await putSendWindow(pool, parsed.data) });
  }));

  // The file name every resume attachment is sent under.
  router.get("/settings/attachment-name", wrap(async (_req, res) => {
    res.json(await getAttachmentName(pool, config));
  }));

  router.put("/settings/attachment-name", wrap(async (req, res) => {
    if (req.body?.reset === true) return res.json(await resetAttachmentName(pool, config));
    const parsed = attachmentNameSchema.safeParse(req.body?.name);
    if (!parsed.success) throw new HttpError(400, `Invalid file name: ${parsed.error.issues[0]?.message ?? "check the value"}`);
    res.json(await putAttachmentName(pool, parsed.data));
  }));

  return router;
}
