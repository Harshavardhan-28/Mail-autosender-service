import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { followupDueAt, followupInstant } from "../../src/domain/schedule.js";
import { DEFAULT_SEND_WINDOW } from "../../src/domain/sendWindow.js";

let t, c;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

const D = 86_400_000;
const istDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * D));
const opening = (ymd) => new Date(`${ymd}T09:00:00+05:30`).getTime(); // default window opens 09:00 IST
const put = (p, body) => c.raw("PUT", p, { body });
const msgs = async (id) => (await t.pool.query("select * from messages where contact_id=$1 and kind='followup' order by created_at", [id])).rows;
let n = 0;
const em = () => `fd${++n}@example.com`;

async function sentContact(sentAt = new Date(Date.now() - 2 * D)) {
  const { contacts } = await seedBatch(t.pool, [em()]);
  const id = contacts[0].id;
  await t.pool.query("update contacts set status='sent' where id=$1", [id]);
  await addMessage(t.pool, id, { kind: "initial", state: "sent", sentAt, messageId: "<m@x>" });
  return id;
}

test("followupInstant: a date maps to the window opening on that local day", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  assert.equal(followupInstant("2026-10-20", DEFAULT_SEND_WINDOW, now).toISOString(), "2026-10-20T03:30:00.000Z");
  // today (in the window tz) is allowed, even after the window opened
  assert.equal(followupInstant("2026-10-17", DEFAULT_SEND_WINDOW, now).toISOString(), "2026-10-17T03:30:00.000Z");
});

test("followupInstant: rejects malformed, impossible, past and >90-day dates", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  for (const bad of ["2026-10-2", "20-10-2026", "2026-02-30", "2026-10-16", "2027-02-01", ""]) {
    assert.throws(() => followupInstant(bad, DEFAULT_SEND_WINDOW, now), { status: 400 }, bad);
  }
  // 18:00 UTC on the 16th is already the 17th in IST, so the 16th is past there
  assert.throws(() => followupInstant("2026-10-16", DEFAULT_SEND_WINDOW, new Date("2026-10-16T19:00:00Z")), { status: 400 });
});

test("followupDueAt: a picked instant wins but never precedes the first send", () => {
  const sent = new Date("2026-10-10T04:00:00Z");
  assert.equal(followupDueAt(sent, 7, new Date("2026-10-20T03:30:00Z")).toISOString(), "2026-10-20T03:30:00.000Z");
  assert.equal(followupDueAt(sent, 7, new Date("2026-10-01T03:30:00Z")).toISOString(), sent.toISOString());
  assert.equal(followupDueAt(sent, 7, null).getTime(), sent.getTime() + 7 * D);
});

test("PUT followup with a date after the first mail was sent schedules it at the window opening of that date", async () => {
  const id = await sentContact();
  const day = istDay(5);
  const r = await put(`/api/contacts/${id}/followup`, { enabled: true, date: day });
  assert.equal(r.status, 200, r.text);
  assert.equal(new Date(r.json.contact.followupAt).getTime(), opening(day));
  assert.equal(new Date(r.json.followup.scheduledFor).getTime(), opening(day));

  const later = istDay(9);
  const r2 = await put(`/api/contacts/${id}/followup`, { enabled: true, date: later });
  assert.equal(r2.json.followup.id, r.json.followup.id);
  assert.equal(new Date(r2.json.followup.scheduledFor).getTime(), opening(later));
  assert.equal((await msgs(id)).length, 1);
});

test("PUT followup: switching back to delayDays clears the date", async () => {
  const sentAt = new Date(Date.now() - D);
  const id = await sentContact(sentAt);
  await put(`/api/contacts/${id}/followup`, { enabled: true, date: istDay(5) });
  const r = await put(`/api/contacts/${id}/followup`, { enabled: true, delayDays: 3 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.contact.followupAt, null);
  assert.equal(new Date(r.json.followup.scheduledFor).getTime(), sentAt.getTime() + 3 * D);
});

test("PUT followup: bad date, past date, or date together with delayDays is 400", async () => {
  const id = await sentContact();
  for (const b of [{ enabled: true, date: "nope" }, { enabled: true, date: istDay(-2) }, { enabled: true, date: istDay(3), delayDays: 3 }]) {
    const r = await put(`/api/contacts/${id}/followup`, b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal((await msgs(id)).length, 0);
});

test("a date set before the first mail is sent is used when the worker sends it", async () => {
  const { contacts } = await seedBatch(t.pool, [em()]);
  const id = contacts[0].id;
  const day = istDay(6);
  const r = await put(`/api/contacts/${id}/followup`, { enabled: true, date: day });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.followup, null);
  const row = (await t.pool.query("select * from contacts where id=$1", [id])).rows[0];
  assert.equal(followupDueAt(new Date(), row.followup_delay_days, row.followup_at).getTime(), opening(day));
});
