import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { planWindowStagger, OVERDUE_MINUTES } from "../../src/domain/schedule.js";
import { DEFAULT_SEND_WINDOW, zonedInstant, windowBoundsFor, nextWindowOpen, isInSendWindow } from "../../src/domain/sendWindow.js";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

const IST = DEFAULT_SEND_WINDOW;
const iso = (d) => d.toISOString();
// 09:00 IST on 2026-10-14 = 03:30Z
const at = (hhmmIst, day = "2026-10-14") => new Date(`${day}T${hhmmIst}:00+05:30`);
const perSlotCounts = (times) => {
  const m = new Map();
  for (const t of times) m.set(t.getTime(), (m.get(t.getTime()) ?? 0) + 1);
  return [...m.values()];
};

test("zonedInstant / windowBoundsFor / nextWindowOpen: IST", () => {
  assert.equal(iso(zonedInstant("Asia/Kolkata", 2026, 10, 14, 9, 0)), "2026-10-14T03:30:00.000Z");
  const b = windowBoundsFor(IST, new Date("2026-10-14T05:00:00Z"));
  assert.deepEqual([iso(b.open), iso(b.close)], ["2026-10-14T03:30:00.000Z", "2026-10-14T04:30:00.000Z"]);
  // local day boundary: 2026-10-13T20:00Z is 01:30 IST on the 14th
  assert.equal(iso(windowBoundsFor(IST, new Date("2026-10-13T20:00:00Z")).open), "2026-10-14T03:30:00.000Z");
  assert.equal(iso(nextWindowOpen(IST, new Date("2026-10-14T03:40:00Z"))), "2026-10-14T03:40:00.000Z", "inside: unchanged");
  assert.equal(iso(nextWindowOpen(IST, new Date("2026-10-14T03:00:00Z"))), "2026-10-14T03:30:00.000Z", "before: today's open");
  assert.equal(iso(nextWindowOpen(IST, new Date("2026-10-14T04:30:00Z"))), "2026-10-15T03:30:00.000Z", "at close: tomorrow");
  assert.equal(iso(nextWindowOpen(IST, new Date("2026-10-14T10:00:00Z"))), "2026-10-15T03:30:00.000Z", "after: tomorrow");
});

test("zonedInstant / windowBoundsFor are DST-correct (America/New_York)", () => {
  const NY = { start: "09:00", end: "10:00", tz: "America/New_York" };
  assert.equal(iso(zonedInstant(NY.tz, 2026, 3, 7, 9, 0)), "2026-03-07T14:00:00.000Z", "EST");
  assert.equal(iso(zonedInstant(NY.tz, 2026, 3, 8, 9, 0)), "2026-03-08T13:00:00.000Z", "EDT after spring forward");
  assert.equal(iso(zonedInstant(NY.tz, 2026, 11, 1, 9, 0)), "2026-11-01T14:00:00.000Z", "EST after fall back");
  const b = windowBoundsFor(NY, new Date("2026-03-08T15:00:00Z"));
  assert.deepEqual([iso(b.open), iso(b.close)], ["2026-03-08T13:00:00.000Z", "2026-03-08T14:00:00.000Z"]);
  // Saturday after-window rolls to Sunday's (post-DST) open
  assert.equal(iso(nextWindowOpen(NY, new Date("2026-03-07T20:00:00Z"))), "2026-03-08T13:00:00.000Z");
});

test("planWindowStagger: 24 emails, 5 min, 09:00 -> 12 slots x 2", () => {
  const p = planWindowStagger(at("09:00"), 24, 5, IST);
  assert.equal(p.slots, 12);
  assert.equal(p.perSlot, 2);
  assert.equal(p.times.length, 24);
  assert.equal(iso(p.start), iso(at("09:00")));
  assert.equal(iso(p.times[0]), iso(at("09:00")));
  assert.equal(iso(p.times[1]), iso(at("09:00")));
  assert.equal(iso(p.times[2]), iso(at("09:05")));
  assert.equal(iso(p.times[23]), iso(at("09:55")));
  assert.deepEqual(perSlotCounts(p.times), Array(12).fill(2));
  assert.ok(p.times.every((t) => isInSendWindow(IST, t)));
});

test("planWindowStagger: 100 emails -> 9 per slot, last slot shorter, all inside window", () => {
  const p = planWindowStagger(at("09:00"), 100, 5, IST);
  assert.equal(p.slots, 12);
  assert.equal(p.perSlot, 9);
  const counts = perSlotCounts(p.times);
  assert.deepEqual(counts.slice(0, 11), Array(11).fill(9));
  assert.equal(counts[11], 1);
  assert.ok(p.times.every((t) => isInSendWindow(IST, t)));
});

test("planWindowStagger: start inside the window shrinks the slots", () => {
  const p = planWindowStagger(at("09:30"), 12, 5, IST);
  assert.equal(p.slots, 6);
  assert.equal(p.perSlot, 2);
  assert.equal(iso(p.times.at(-1)), iso(at("09:55")));
});

test("planWindowStagger: start before the window moves to open; after the window moves to next day", () => {
  assert.equal(iso(planWindowStagger(at("07:00"), 4, 5, IST).start), iso(at("09:00")));
  const next = planWindowStagger(at("12:00"), 4, 5, IST);
  assert.equal(iso(next.start), iso(at("09:00", "2026-10-15")));
  assert.equal(next.slots, 12);
});

test("planWindowStagger: stagger 0 puts everything at start without shifting; stagger larger than window is one slot", () => {
  const zero = planWindowStagger(at("12:00"), 5, 0, IST);
  assert.equal(zero.slots, 1);
  assert.equal(zero.perSlot, 5);
  assert.ok(zero.times.every((t) => t.getTime() === at("12:00").getTime()));
  const big = planWindowStagger(at("09:00"), 5, 90, IST);
  assert.equal(big.slots, 1);
  assert.ok(big.times.every((t) => t.getTime() === at("09:00").getTime()));
  assert.deepEqual(planWindowStagger(at("09:00"), 0, 5, IST).times, []);
});

// ---- routes ----
let t, c;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

const H = 3600_000;
const D = 24 * H;
let n = 0;
const em = () => `w${++n}@example.com`;
const emails = (k) => Array.from({ length: k }, em);
const bulk = (batchId, body) => c.post(`/api/batches/${batchId}/schedule`, body);
const row = async (id) => (await t.pool.query("select * from messages where id=$1", [id])).rows[0];

// next future instant that is exactly 09:00 IST (>= 2 days out)
function futureNineIst() {
  const d = new Date(Date.now() + 2 * D);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
  return new Date(`${ymd}T09:00:00+05:30`);
}

test("schedule with stagger bunches times into the window and returns the plan", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, emails(24));
  const sendAt = futureNineIst();
  const r = await bulk(batchId, { contactIds: contacts.map((x) => x.id), sendAt: sendAt.toISOString(), staggerMinutes: 5 });
  assert.equal(r.status, 201, r.text);
  const times = r.json.messages.map((m) => new Date(m.scheduledFor).getTime());
  assert.deepEqual(times.slice(0, 3), [sendAt.getTime(), sendAt.getTime(), sendAt.getTime() + 300_000]);
  assert.equal(times[23], sendAt.getTime() + 55 * 60_000);
  assert.deepEqual(r.json.plan, { start: sendAt.toISOString(), slots: 12, perSlot: 2, staggerMinutes: 5, window: IST });
});

test("schedule with stagger and a sendAt outside the window moves to the next opening", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, emails(2));
  const noon = new Date(futureNineIst().getTime() + 3 * H);
  const r = await bulk(batchId, { contactIds: contacts.map((x) => x.id), sendAt: noon.toISOString(), staggerMinutes: 5 });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.plan.start, new Date(futureNineIst().getTime() + D).toISOString());
});

test("schedule without stagger keeps sendAt and reports a null window", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, emails(2));
  const sendAt = new Date(futureNineIst().getTime() + 3 * H);
  const r = await bulk(batchId, { contactIds: contacts.map((x) => x.id), sendAt: sendAt.toISOString() });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.messages.every((m) => new Date(m.scheduledFor).getTime() === sendAt.getTime()));
  assert.deepEqual(r.json.plan, { start: sendAt.toISOString(), slots: 1, perSlot: 2, staggerMinutes: 0, window: null });
});

// ---- overdue ----
const overdue = (batchName, k) => seedBatch(t.pool, emails(k), { name: batchName });
async function clearScheduled() {
  await t.pool.query("update messages set state='cancelled' where state='scheduled'");
}

test("overdue routes require auth and CSRF", async () => {
  const anon = t.client();
  const id = "00000000-0000-4000-8000-000000000000";
  assert.equal((await anon.get("/api/messages/overdue")).status, 401);
  assert.equal((await anon.raw("POST", "/api/messages/reschedule-overdue", { body: {} })).status, 401);
  const noCsrf = t.client();
  await noCsrf.login();
  assert.equal((await noCsrf.raw("POST", "/api/messages/reschedule-overdue", { body: {}, csrf: false })).status, 403);
  void id;
});

test("GET overdue lists scheduled messages older than 60 minutes, oldest first", async () => {
  await clearScheduled();
  assert.equal(OVERDUE_MINUTES, 60);
  const { contacts } = await overdue("Ov batch", 4);
  const old = await addMessage(t.pool, contacts[0].id, { scheduledFor: new Date(Date.now() - 5 * H) });
  const older = await addMessage(t.pool, contacts[1].id, { scheduledFor: new Date(Date.now() - 9 * H) });
  await addMessage(t.pool, contacts[2].id, { scheduledFor: new Date(Date.now() - 30 * 60_000) }); // not yet overdue
  await addMessage(t.pool, contacts[3].id, { state: "sent", scheduledFor: new Date(Date.now() - 9 * H) }); // not scheduled
  const r = await c.get("/api/messages/overdue");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.count, 2);
  assert.equal(r.json.overdueMinutes, 60);
  assert.deepEqual(r.json.messages.map((m) => m.id), [older.id, old.id]);
  assert.deepEqual(Object.keys(r.json.messages[0]).sort(), ["batchName", "contactId", "email", "id", "kind", "person", "scheduledFor"]);
  assert.equal(r.json.messages[0].batchName, "Ov batch");
  assert.equal(r.json.messages[0].email, contacts[1].email);
});

test("reschedule-overdue moves all overdue into upcoming window slots, in original order, with events", async () => {
  await clearScheduled();
  const { contacts } = await overdue("Re batch", 3);
  const m0 = await addMessage(t.pool, contacts[0].id, { scheduledFor: new Date(Date.now() - 2 * H) });
  const m1 = await addMessage(t.pool, contacts[1].id, { scheduledFor: new Date(Date.now() - 8 * H) });
  const m2 = await addMessage(t.pool, contacts[2].id, { scheduledFor: new Date(Date.now() - 5 * H) });
  const sendAt = futureNineIst();
  const r = await c.post("/api/messages/reschedule-overdue", { sendAt: sendAt.toISOString(), staggerMinutes: 5 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.rescheduled, 3);
  assert.equal(r.json.plan.slots, 12);
  assert.equal(r.json.plan.perSlot, 1);
  assert.equal(r.json.plan.start, sendAt.toISOString());
  const at = async (m) => (await row(m.id)).scheduled_for.getTime();
  assert.deepEqual([await at(m1), await at(m2), await at(m0)], [0, 300_000, 600_000].map((x) => sendAt.getTime() + x));
  assert.equal(r.json.messages.length, 3);
  const ev = await t.pool.query("select contact_id, meta from events where type='rescheduled' and contact_id = any($1)", [contacts.map((x) => x.id)]);
  assert.equal(ev.rowCount, 3);
  assert.ok(ev.rows.every((e) => e.meta.source === "overdue" && e.meta.messageId && e.meta.scheduledFor));
  assert.equal((await c.get("/api/messages/overdue")).json.count, 0);
});

test("reschedule-overdue with messageIds touches only those; ineligible ids are skipped silently", async () => {
  await clearScheduled();
  const { contacts } = await overdue("Sub batch", 4);
  const a = await addMessage(t.pool, contacts[0].id, { scheduledFor: new Date(Date.now() - 3 * H) });
  const b = await addMessage(t.pool, contacts[1].id, { scheduledFor: new Date(Date.now() - 3 * H) });
  const sent = await addMessage(t.pool, contacts[2].id, { state: "sent", scheduledFor: new Date(Date.now() - 3 * H) });
  const fresh = await addMessage(t.pool, contacts[3].id, { scheduledFor: new Date(Date.now() + H) });
  const r = await c.post("/api/messages/reschedule-overdue", { messageIds: [a.id, sent.id, fresh.id, "00000000-0000-4000-8000-000000000000"], staggerMinutes: 0 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.rescheduled, 1);
  assert.equal(r.json.messages[0].id, a.id);
  assert.ok((await row(a.id)).scheduled_for.getTime() > Date.now());
  assert.equal(r.json.plan.window.tz, "Asia/Kolkata");
  assert.equal((await row(b.id)).scheduled_for.getTime(), b.scheduled_for.getTime(), "unselected stays put");
  assert.equal((await row(sent.id)).state, "sent");
});

test("reschedule-overdue with nothing eligible returns 200 / zero / null plan; bad bodies are 400", async () => {
  await clearScheduled();
  const r = await c.post("/api/messages/reschedule-overdue", {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { rescheduled: 0, messages: [], plan: null });
  for (const body of [
    { extra: 1 },
    { sendAt: "tomorrow" },
    { sendAt: new Date(Date.now() - H).toISOString() },
    { staggerMinutes: -1 },
    { staggerMinutes: 1441 },
    { staggerMinutes: 1.5 },
    { messageIds: [] },
    { messageIds: ["nope"] },
  ]) {
    assert.equal((await c.post("/api/messages/reschedule-overdue", body)).status, 400, JSON.stringify(body));
  }
});
