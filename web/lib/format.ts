// Display helpers. Everything renders in the browser's local time zone.

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DAY = { weekday: "short", day: "numeric", month: "short" } as const;
const dayPart = new Intl.DateTimeFormat(undefined, DAY);
const timePart = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const short = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

/** Compact date-time for dense lists (no weekday). */
export function formatShort(v: string | Date): string {
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? "—" : short.format(d);
}

export function formatDay(v: string | Date): string {
  return dayPart.format(toDate(v));
}

const calendarDay = new Intl.DateTimeFormat(undefined, { ...DAY, timeZone: "UTC" });

/** "Fri, 24 Oct" for a bare calendar date (YYYY-MM-DD), the same day wherever the browser is. */
export function formatCalendarDay(iso: string): string {
  return calendarDay.format(new Date(`${iso}T00:00:00Z`));
}

export function formatTime(v: string | Date): string {
  return timePart.format(toDate(v));
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function percent(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Not scheduled",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  replied: "Replied",
  bounced: "Bounced",
  opted_out: "Opted out",
  failed: "Failed",
  cancelled: "Cancelled",
  needs_review: "Needs review",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

const EVENT_LABEL: Record<string, string> = {
  imported: "Imported",
  batch_created: "Batch uploaded",
  scheduled: "Scheduled",
  rescheduled: "Rescheduled",
  message_cancelled: "Send cancelled",
  followup_enabled: "Follow-up on",
  followup_disabled: "Follow-up off",
  replied: "Reply received",
  opted_out: "Opted out",
  template_updated: "Follow-up template saved",
  sent: "Sent",
  failed: "Send failed",
  bounced: "Bounced",
  needs_review: "Needs review",
  needs_review_resolved: "Review settled",
  send_failed: "Send failed",
  send_held: "Send held",
  send_skipped: "Send skipped",
};

const RESOLVE_WORD: Record<string, string> = { mark_sent: "marked as sent", requeue: "sent again", cancel: "dropped" };
const REASON_WORD: Record<string, string> = {
  stale_sending: "the send was interrupted",
  ambiguous_send_failure: "delivery could not be confirmed",
};

/** One short line of context for a timeline entry, or null. */
export function eventDetail(type: string, meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  const when = typeof meta.scheduledFor === "string" ? formatShort(meta.scheduledFor) : null;
  if ((type === "scheduled" || type === "rescheduled") && when) return `For ${when}`;
  if (type === "needs_review_resolved" && typeof meta.action === "string") return `Outcome: ${RESOLVE_WORD[meta.action] ?? meta.action}`;
  if (type === "sent" && meta.dryRun === true) return "Dry run: nothing was delivered";
  if (typeof meta.reason === "string") return REASON_WORD[meta.reason] ?? meta.reason.replace(/_/g, " ");
  if (type === "send_failed" && typeof meta.attempts === "number") return `After ${plural(meta.attempts, "attempt")}`;
  if (type === "replied" && meta.source === "manual") return "Marked by hand";
  return null;
}

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/_/g, " ");
}

const absolute = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "10 Oct, 09:12 IST": a full timestamp with its zone, for exact reading. */
export function formatAbsolute(v: string | Date): string {
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? "—" : absolute.format(d);
}

/** "in 2 hours", "tomorrow", "3 days ago". Falls back to nothing beyond a week, where the absolute time says more. */
export function formatRelative(v: string | Date, now: Date = new Date()): string | null {
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return null;
  const secs = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(secs);
  if (abs < 60) return secs >= 0 ? "in a moment" : "just now";
  if (abs < 3600) return relative.format(Math.round(secs / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(secs / 3600), "hour");
  if (abs < 7 * 86_400) {
    // Calendar days, so "tomorrow" means the next date rather than 24 hours from now.
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
    return relative.format(days, "day");
  }
  return null;
}
