import { describe, expect, it } from "vitest";
import { nextWindowOpen, planWindowStagger, windowBoundsFor, zonedInstant, describeWindowPlan } from "./sendWindowPlan";

// Vectors copied from test/schedule/windowStagger.test.js (the server is the authority).
const IST = { start: "09:00", end: "10:00", tz: "Asia/Kolkata" };
const NY = { start: "09:00", end: "10:00", tz: "America/New_York" };
const iso = (d: Date) => d.toISOString();
const at = (hhmm: string, day = "2026-10-14") => new Date(`${day}T${hhmm}:00+05:30`);
const perSlot = (times: Date[]) => {
  const m = new Map<number, number>();
  for (const t of times) m.set(t.getTime(), (m.get(t.getTime()) ?? 0) + 1);
  return [...m.values()];
};

describe("zonedInstant / windowBoundsFor / nextWindowOpen", () => {
  it("IST", () => {
    expect(iso(zonedInstant("Asia/Kolkata", 2026, 10, 14, 9, 0))).toBe("2026-10-14T03:30:00.000Z");
    const b = windowBoundsFor(IST, new Date("2026-10-14T05:00:00Z"));
    expect([iso(b.open), iso(b.close)]).toEqual(["2026-10-14T03:30:00.000Z", "2026-10-14T04:30:00.000Z"]);
    expect(iso(windowBoundsFor(IST, new Date("2026-10-13T20:00:00Z")).open)).toBe("2026-10-14T03:30:00.000Z");
  });
  it("nextWindowOpen: inside, before, at close, after", () => {
    expect(iso(nextWindowOpen(IST, new Date("2026-10-14T03:40:00Z")))).toBe("2026-10-14T03:40:00.000Z");
    expect(iso(nextWindowOpen(IST, new Date("2026-10-14T03:00:00Z")))).toBe("2026-10-14T03:30:00.000Z");
    expect(iso(nextWindowOpen(IST, new Date("2026-10-14T04:30:00Z")))).toBe("2026-10-15T03:30:00.000Z");
    expect(iso(nextWindowOpen(IST, new Date("2026-10-14T10:00:00Z")))).toBe("2026-10-15T03:30:00.000Z");
  });
  it("is DST-correct (America/New_York)", () => {
    expect(iso(zonedInstant(NY.tz, 2026, 3, 7, 9, 0))).toBe("2026-03-07T14:00:00.000Z");
    expect(iso(zonedInstant(NY.tz, 2026, 3, 8, 9, 0))).toBe("2026-03-08T13:00:00.000Z");
    expect(iso(zonedInstant(NY.tz, 2026, 11, 1, 9, 0))).toBe("2026-11-01T14:00:00.000Z");
    const b = windowBoundsFor(NY, new Date("2026-03-08T15:00:00Z"));
    expect([iso(b.open), iso(b.close)]).toEqual(["2026-03-08T13:00:00.000Z", "2026-03-08T14:00:00.000Z"]);
    expect(iso(nextWindowOpen(NY, new Date("2026-03-07T20:00:00Z")))).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("planWindowStagger", () => {
  it("24 emails, 5 min, 09:00 -> 12 slots x 2", () => {
    const p = planWindowStagger(at("09:00"), 24, 5, IST);
    expect([p.slots, p.perSlot, p.times.length]).toEqual([12, 2, 24]);
    expect(iso(p.start)).toBe(iso(at("09:00")));
    expect(iso(p.times[1]!)).toBe(iso(at("09:00")));
    expect(iso(p.times[2]!)).toBe(iso(at("09:05")));
    expect(iso(p.times[23]!)).toBe(iso(at("09:55")));
    expect(perSlot(p.times)).toEqual(Array(12).fill(2));
  });
  it("100 emails -> 9 per slot, last slot shorter", () => {
    const p = planWindowStagger(at("09:00"), 100, 5, IST);
    expect([p.slots, p.perSlot]).toEqual([12, 9]);
    const c = perSlot(p.times);
    expect(c.slice(0, 11)).toEqual(Array(11).fill(9));
    expect(c[11]).toBe(1);
  });
  it("start inside the window shrinks the slots", () => {
    const p = planWindowStagger(at("09:30"), 12, 5, IST);
    expect([p.slots, p.perSlot]).toEqual([6, 2]);
    expect(iso(p.times.at(-1)!)).toBe(iso(at("09:55")));
  });
  it("before the window -> same-day open; after -> next-day open", () => {
    expect(iso(planWindowStagger(at("07:00"), 4, 5, IST).start)).toBe(iso(at("09:00")));
    const next = planWindowStagger(at("12:00"), 4, 5, IST);
    expect(iso(next.start)).toBe(iso(at("09:00", "2026-10-15")));
    expect(next.slots).toBe(12);
  });
  it("stagger 0 leaves everything at start; stagger > window is one slot", () => {
    const zero = planWindowStagger(at("12:00"), 5, 0, IST);
    expect([zero.slots, zero.perSlot]).toEqual([1, 5]);
    expect(zero.times.every((t) => t.getTime() === at("12:00").getTime())).toBe(true);
    const big = planWindowStagger(at("09:00"), 5, 90, IST);
    expect(big.slots).toBe(1);
    expect(big.times.every((t) => t.getTime() === at("09:00").getTime())).toBe(true);
    expect(planWindowStagger(at("09:00"), 0, 5, IST).times).toEqual([]);
  });
});

describe("describeWindowPlan", () => {
  it("summarises slots and the time span in the window zone", () => {
    const p = planWindowStagger(at("09:00"), 24, 5, IST);
    expect(describeWindowPlan(p, 24, IST)).toBe("24 emails in 12 slots, 2 per slot, 09:00-09:55 Asia/Kolkata");
  });
  it("singular and single-slot forms", () => {
    const p = planWindowStagger(at("09:00"), 1, 5, IST);
    expect(describeWindowPlan(p, 1, IST)).toBe("1 email in 1 slot, 1 per slot, 09:00-09:00 Asia/Kolkata");
  });
});
