import { describe, expect, it } from "vitest";
import { parseLocalDateTime, planSchedule, toLocalInputValue } from "./schedule";

// Local wall-clock times (as an <input type="datetime-local"> yields them).
const now = new Date(2030, 0, 10, 8, 0); // 10 Jan 2030 08:00 local
const base = { selectedIds: ["a", "b", "c"], sendAt: "2030-01-11T09:00", staggerMinutes: "", overrides: {}, now };

describe("parseLocalDateTime", () => {
  it("parses datetime-local values as local time", () => {
    expect(parseLocalDateTime("2030-01-11T09:30")?.getTime()).toBe(new Date(2030, 0, 11, 9, 30).getTime());
  });
  it("rejects malformed and impossible values", () => {
    for (const v of ["", "tomorrow", "2030-02-30T09:00", "2030-01-11 09:00", "2030-01-11T25:00"]) {
      expect(parseLocalDateTime(v), v).toBeNull();
    }
  });
  it("round-trips with toLocalInputValue", () => {
    expect(toLocalInputValue(new Date(2030, 4, 6, 7, 8))).toBe("2030-05-06T07:08");
  });
});

describe("planSchedule", () => {
  it("accepts a future time and sends an ISO instant with timezone", () => {
    const r = planSchedule(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk).toEqual({ contactIds: ["a", "b", "c"], sendAt: new Date(2030, 0, 11, 9, 0).toISOString(), staggerMinutes: 0 });
    expect(r.plan.bulk!.sendAt).toMatch(/Z$/);
    expect(r.plan.overrides).toEqual([]);
  });

  it("rejects a past date", () => {
    const r = planSchedule({ ...base, sendAt: "2030-01-10T07:59" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.sendAt).toMatch(/future/i);
  });

  it("rejects the current minute (must be strictly in the future)", () => {
    const r = planSchedule({ ...base, sendAt: "2030-01-10T08:00" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing or malformed time", () => {
    expect(planSchedule({ ...base, sendAt: "" }).ok).toBe(false);
    expect(planSchedule({ ...base, sendAt: "nope" }).ok).toBe(false);
  });

  it("rejects more than 90 days ahead", () => {
    const r = planSchedule({ ...base, sendAt: "2030-04-11T09:00" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.sendAt).toMatch(/90 days/);
  });

  it("requires at least one selected contact", () => {
    const r = planSchedule({ ...base, selectedIds: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.form).toMatch(/select/i);
  });

  it("staggers contacts in table order", () => {
    const r = planSchedule({ ...base, staggerMinutes: "15" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk!.staggerMinutes).toBe(15);
    const t = (h: number, m: number) => new Date(2030, 0, 11, h, m).getTime();
    expect([r.plan.times.a!.getTime(), r.plan.times.b!.getTime(), r.plan.times.c!.getTime()]).toEqual([t(9, 0), t(9, 15), t(9, 30)]);
  });

  it("rejects an invalid stagger", () => {
    for (const s of ["-1", "2.5", "abc", "1441"]) {
      const r = planSchedule({ ...base, staggerMinutes: s });
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.errors.stagger).toBeTruthy();
    }
  });

  it("rejects a stagger that pushes the last send past 90 days", () => {
    const r = planSchedule({ ...base, sendAt: "2030-04-09T23:00", staggerMinutes: "1440" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.stagger).toMatch(/90 days/);
  });

  it("per-row override takes the row out of the bulk call and keeps the stagger for the rest", () => {
    const r = planSchedule({ ...base, staggerMinutes: "10", overrides: { b: "2030-01-12T10:00" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk!.contactIds).toEqual(["a", "c"]);
    expect(r.plan.overrides).toEqual([{ contactId: "b", sendAt: new Date(2030, 0, 12, 10, 0).toISOString() }]);
    expect(r.plan.times.c!.getTime()).toBe(new Date(2030, 0, 11, 9, 10).getTime());
    expect(r.plan.times.b!.getTime()).toBe(new Date(2030, 0, 12, 10, 0).getTime());
  });

  it("rejects a past per-row override and names the row", () => {
    const r = planSchedule({ ...base, overrides: { c: "2030-01-09T09:00" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.overrides.c).toMatch(/future/i);
    expect(r.errors.sendAt).toBeUndefined();
  });

  it("ignores overrides on unselected rows and needs no bulk time when every row is overridden", () => {
    const r = planSchedule({ ...base, selectedIds: ["a"], sendAt: "", overrides: { a: "2030-01-11T09:00", z: "garbage" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk).toBeNull();
    expect(r.plan.overrides).toHaveLength(1);
  });

  it("treats an empty override as no override", () => {
    const r = planSchedule({ ...base, overrides: { a: "" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.bulk!.contactIds).toEqual(["a", "b", "c"]);
  });
});

describe("planSchedule with a send window (mirrors the server's window-bunched stagger)", () => {
  // Window 09:00-10:00 in the machine's zone would make the vectors zone-dependent, so use a fixed zone.
  const win = { start: "09:00", end: "10:00", tz: "Asia/Kolkata" };
  const ids = Array.from({ length: 24 }, (_, i) => `c${i}`);
  const nowUtc = new Date("2030-01-10T00:00:00Z");
  // datetime-local is the machine's wall clock; derive the value from a known instant so the test is zone-proof.
  const local = (d: Date) => toLocalInputValue(d);
  const sendAt = local(new Date("2030-01-11T03:30:00Z")); // 09:00 IST the next day

  it("bunches into slots inside the window", () => {
    const r = planSchedule({ selectedIds: ids, sendAt, staggerMinutes: "5", overrides: {}, now: nowUtc, window: win });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = ids.map((id) => r.plan.times[id]!.toISOString());
    expect(t[0]).toBe("2030-01-11T03:30:00.000Z");
    expect(t[1]).toBe("2030-01-11T03:30:00.000Z");
    expect(t[2]).toBe("2030-01-11T03:35:00.000Z");
    expect(t[23]).toBe("2030-01-11T04:25:00.000Z");
    expect(r.plan.windowPlan).toMatchObject({ count: 24 });
    expect(r.plan.windowPlan!.plan.slots).toBe(12);
  });

  it("moves a start outside the window to the next window open", () => {
    const late = local(new Date("2030-01-11T08:00:00Z")); // 13:30 IST
    const r = planSchedule({ selectedIds: ["a", "b"], sendAt: late, staggerMinutes: "5", overrides: {}, now: nowUtc, window: win });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.times.a!.toISOString()).toBe("2030-01-12T03:30:00.000Z");
  });

  it("keeps the old arithmetic when stagger is 0 or the window is unknown", () => {
    const zero = planSchedule({ selectedIds: ids.slice(0, 2), sendAt, staggerMinutes: "0", overrides: {}, now: nowUtc, window: win });
    if (zero.ok) expect(zero.plan.windowPlan).toBeUndefined();
    const unknown = planSchedule({ selectedIds: ["a", "b"], sendAt, staggerMinutes: "10", overrides: {}, now: nowUtc, window: null });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.plan.windowPlan).toBeUndefined();
      expect(unknown.plan.times.b!.getTime() - unknown.plan.times.a!.getTime()).toBe(600_000);
    }
  });

  it("checks the 90-day limit against the last planned time", () => {
    const edge = local(new Date("2030-04-09T03:30:00Z"));
    const r = planSchedule({ selectedIds: ["a"], sendAt: edge, staggerMinutes: "5", overrides: {}, now: new Date("2030-01-10T03:00:00Z"), window: win });
    // 09:00 IST on 2030-04-09 is within 90 days; its next-day open after a 10:00 start would not be.
    expect(r.ok).toBe(true);
    const past = local(new Date("2030-04-09T05:00:00Z")); // after the window closes -> moves to 04-10 open, > 90 days from now
    const r2 = planSchedule({ selectedIds: ["a"], sendAt: past, staggerMinutes: "5", overrides: {}, now: new Date("2030-01-10T03:00:00Z"), window: win });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.stagger).toMatch(/90 days/);
  });
});
