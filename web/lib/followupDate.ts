// Follow-up dates are calendar days in the send window's time zone (IST), bounded like the server.
import { ApiError } from "./api";
import { refusalText } from "./refusals";

export const FOLLOWUP_MAX_DAYS = 90; // same cap the server enforces
const DEFAULT_DAYS = 7;
const SEND_TZ = "Asia/Kolkata";
export const FOLLOWUP_RANGE_ERROR = `Pick a date within the next ${FOLLOWUP_MAX_DAYS} days`;

const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: SEND_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (v: string | Date) => istDay.format(new Date(v));

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Today..today+90 in IST, plus the default pick (a week out). */
export function followupDateRange(now: Date = new Date()) {
  const min = istDate(now);
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
