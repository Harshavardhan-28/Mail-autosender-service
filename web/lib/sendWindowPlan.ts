// Port of the window arithmetic in src/domain/sendWindow.js and planWindowStagger in src/domain/schedule.js, so the
// preview shows the same times the server will store. The server stays the authority.
import type { SendWindow } from "./types";
import { plural } from "./format";

const parts = (fmt: Intl.DateTimeFormat, d: Date) => {
  const p = fmt.formatToParts(d);
  return (type: string) => Number(p.find((x) => x.type === type)!.value);
};

// Offset of `tz` from UTC at `instant`, in ms (local wall clock read as UTC, minus the real instant, to the second).
function tzOffsetMs(tz: string, instant: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const get = parts(fmt, instant);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` reads y-m-d hh:mm (offset re-read twice, so a DST change is handled). */
export function zonedInstant(tz: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

type Ymd = { y: number; m: number; d: number };

function localYmd(tz: string, instant: Date): Ymd {
  const get = parts(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }), instant);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const hm = (s: string) => s.split(":").map(Number) as [number, number];

function boundsOn(w: SendWindow, { y, m, d }: Ymd) {
  const [sh, sm] = hm(w.start);
  const [eh, em] = hm(w.end);
  return { open: zonedInstant(w.tz, y, m, d, sh, sm), close: zonedInstant(w.tz, y, m, d, eh, em) };
}

/** Open/close instants of the window on the local day (in w.tz) that contains `instant`; close is exclusive. */
export function windowBoundsFor(w: SendWindow, instant: Date) {
  return boundsOn(w, localYmd(w.tz, instant));
}

/** First instant >= `instant` at which sending is allowed. */
export function nextWindowOpen(w: SendWindow, instant: Date): Date {
  const day = localYmd(w.tz, instant);
  const { open, close } = boundsOn(w, day);
  if (instant.getTime() < open.getTime()) return open;
  if (instant.getTime() < close.getTime()) return instant;
  const next = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
  return boundsOn(w, { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }).open;
}

export interface WindowPlan {
  times: Date[];
  start: Date;
  slots: number;
  perSlot: number;
}

/**
 * Stagger as "one slot every N minutes, packed into the send window": the start moves to the next window opening,
 * slots = how many N-minute steps fit before the window closes, emails spread evenly (ceil(count / slots) per slot).
 * Stagger 0 = everything at `start`, untouched.
 */
export function planWindowStagger(start: Date, count: number, staggerMinutes: number, w: SendWindow): WindowPlan {
  if (!(staggerMinutes > 0)) return { times: Array.from({ length: count }, () => new Date(start.getTime())), start, slots: 1, perSlot: count };
  const from = nextWindowOpen(w, start);
  const step = staggerMinutes * 60_000;
  const { close } = windowBoundsFor(w, from);
  const slots = Math.max(1, Math.floor((close.getTime() - from.getTime()) / step));
  const perSlot = Math.max(1, Math.ceil(count / slots));
  const times = Array.from({ length: count }, (_, i) => new Date(from.getTime() + Math.floor(i / perSlot) * step));
  return { times, start: from, slots, perSlot };
}

const clock = (tz: string, d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(d);

/** e.g. "24 emails in 12 slots, 2 per slot, 09:00-09:55 Asia/Kolkata" (times read in the window's own zone). */
export function describeWindowPlan(plan: WindowPlan, count: number, w: SendWindow): string {
  const first = plan.times[0] ?? plan.start;
  const last = plan.times.at(-1) ?? plan.start;
  // Slots actually used (a short list does not fill every slot the window has room for).
  const used = Math.max(1, Math.min(plan.slots, Math.ceil(count / plan.perSlot)));
  return `${plural(count, "email")} in ${plural(used, "slot")}, ${plan.perSlot} per slot, ${clock(w.tz, first)}-${clock(w.tz, last)} ${w.tz}`;
}
