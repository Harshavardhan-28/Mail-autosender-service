// Follow-up dates are calendar days in the send window's time zone, bounded like the server.
import { ApiError } from "./api";
import { refusalText } from "./refusals";

export const FOLLOWUP_MAX_DAYS = 90; // same cap the server enforces
const DEFAULT_DAYS = 7;
/** The server's default send-window zone; used until the real window is known. */
export const DEFAULT_SEND_TZ = "Asia/Kolkata";
export const FOLLOWUP_RANGE_ERROR = `Pick a date within the next ${FOLLOWUP_MAX_DAYS} days`;
/** Why a bulk change skips a contact (every reason the server refuses a follow-up for). */
export const FOLLOWUP_SKIP_REASONS = "replied, bounced, opted out, failed or suppressed";

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const dayFormat = (tz: string) => {
  let f = dayFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(tz, f);
  }
  return f;
};

/** The calendar date (YYYY-MM-DD) of an instant in `tz` (the send window's zone). */
export const zonedDate = (v: string | Date, tz: string = DEFAULT_SEND_TZ) => dayFormat(tz).format(new Date(v));

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Today..today+90 in `tz`, plus the default pick (a week out). */
export function followupDateRange(now: Date = new Date(), tz: string = DEFAULT_SEND_TZ) {
  const min = zonedDate(now, tz);
  return { min, max: addDays(min, FOLLOWUP_MAX_DAYS), fallback: addDays(min, DEFAULT_DAYS) };
}

export const isFollowupDateInRange = (d: string, range: { min: string; max: string }) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= range.min && d <= range.max;

export function describeFollowupError(err: unknown): string {
  if (err instanceof ApiError) {
    const r = err.refused?.[0];
    if (r) return refusalText(r.reason);
    return err.message;
  }
  return "Could not update the follow-up";
}
