import { z } from "zod";

// Daily window in which REAL sends may be claimed (when SEND_WINDOW_ENFORCED). Stored in the settings
// table under `send_window`; the default applies while the row is absent or unreadable.
export const SEND_WINDOW_KEY = "send_window";
export const DEFAULT_SEND_WINDOW = Object.freeze({ start: "09:00", end: "10:00", tz: "Asia/Kolkata" });

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const validTz = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// start must be strictly before end on the same local day (no overnight windows).
export const sendWindowSchema = z
  .strictObject({
    start: z.string().regex(HHMM, "start must be HH:MM (24 h)"),
    end: z.string().regex(HHMM, "end must be HH:MM (24 h)"),
    tz: z.string().min(1).max(64).refine(validTz, "tz must be an IANA time zone, e.g. Asia/Kolkata"),
  })
  .refine((w) => minutesOf(w.start) < minutesOf(w.end), { message: "start must be before end", path: ["end"] });

// Local wall-clock minutes since midnight in `tz` (DST-aware through Intl).
function localMinutes(tz, now) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get("hour") % 24) * 60 + get("minute");
}

// start inclusive, end exclusive; seconds are ignored (minute granularity), so 09:59:59 is inside and 10:00:00 is not.
export function isInSendWindow(window, now = new Date()) {
  const m = localMinutes(window.tz, now);
  return m >= minutesOf(window.start) && m < minutesOf(window.end);
}

// Offset of `tz` from UTC at `instant`, in ms (local wall clock read as UTC, minus the real instant, to the second).
function tzOffsetMs(tz, instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The instant at which the wall clock in `tz` reads y-m-d hh:mm. The offset is re-read at the guess (twice), so a
// DST change between the naive guess and the real instant is accounted for.
export function zonedInstant(tz, y, m, d, hh, mm) {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

// Local calendar date (in tz) of an instant.
function localYmd(tz, instant) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const boundsOn = (window, { y, m, d }) => {
  const [sh, sm] = window.start.split(":").map(Number);
  const [eh, em] = window.end.split(":").map(Number);
  return { open: zonedInstant(window.tz, y, m, d, sh, sm), close: zonedInstant(window.tz, y, m, d, eh, em) };
};

// Open/close instants of the window on the local day (in window.tz) that contains `instant`; close is exclusive.
export function windowBoundsFor(window, instant) {
  return boundsOn(window, localYmd(window.tz, instant));
}

// First instant >= `instant` at which sending is allowed.
export function nextWindowOpen(window, instant) {
  const day = localYmd(window.tz, instant);
  const { open, close } = boundsOn(window, day);
  if (instant.getTime() < open.getTime()) return open;
  if (instant.getTime() < close.getTime()) return instant;
  const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
  return boundsOn(window, { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }).open;
}

export const windowLabel = (w) => `${w.start}–${w.end} ${w.tz}`;

export async function getSendWindow(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [SEND_WINDOW_KEY]);
  const parsed = sendWindowSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : { ...DEFAULT_SEND_WINDOW };
}

export async function putSendWindow(db, window) {
  await db.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SEND_WINDOW_KEY, JSON.stringify(window)],
  );
  await db.query("INSERT INTO events(type, meta) VALUES ('send_window_updated', $1::jsonb)", [JSON.stringify(window)]);
  return window;
}
