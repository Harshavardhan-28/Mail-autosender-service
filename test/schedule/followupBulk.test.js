import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

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
const opening = (ymd) => new Date(`${ymd}T09:00:00+05:30`).getTime();
const put = (body) => c.raw("PUT", "/api/followups/bulk", { body });
const contact = async (id) => (await t.pool.query("select * from contacts where id=$1", [id])).rows[0];
const followups = async (id) => (await t.pool.query("select * from messages where contact_id=$1 and kind='followup' and state<>'cancelled'", [id])).rows;
let n = 0;

async function sentBatch(spec) {
  const emails = spec.map((_, i) => `fb${++n}_${i}@example.com`);
  const overrides = Object.fromEntries(emails.map((e, i) => [e, spec[i]]));
  const { batchId, contacts } = await seedBatch(t.pool, emails, { overrides });
  for (const k of contacts) {
    if (k.status === "uploaded") await t.pool.query("update contacts set status='sent' where id=$1", [k.id]);
    await addMessage(t.pool, k.id, { kind: "initial", state: "sent", sentAt: new Date(Date.now() - 2 * D), messageId: "<m@x>" });
  }
  return { batchId, ids: contacts.map((k) => k.id) };
}

test("bulk follow-up requires auth and CSRF", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  assert.equal((await t.client().raw("PUT", "/api/followups/bulk", { body: {} })).status, 401);
  const noCsrf = t.client();
  await noCsrf.login();
  assert.equal((await noCsrf.raw("PUT", "/api/followups/bulk", { body: { batchId: id, enabled: false }, csrf: false })).status, 403);
});

test("whole batch: every contact gets the date and a scheduled follow-up", async () => {
  const { batchId, ids } = await sentBatch([{ company: "A" }, { company: "B" }]);
  const day = istDay(5);
  const r = await put({ batchId, enabled: true, date: day });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { updated: 2, skipped: 0, total: 2 });
  for (const id of ids) {
    assert.equal((await contact(id)).followup_at.getTime(), opening(day));
    const f = await followups(id);
    assert.equal(f.length, 1);
    assert.equal(f[0].scheduled_for.getTime(), opening(day));
  }
});

test("company filter touches only that company, case-insensitively", async () => {
  const { batchId, ids } = await sentBatch([{ company: "Acme Corp" }, { company: "Other" }, { company: "acme corp" }]);
  const r = await put({ batchId, company: "  ACME CORP ", enabled: true, date: istDay(3) });
  assert.deepEqual(r.json, { updated: 2, skipped: 0, total: 2 });
  assert.equal((await followups(ids[0])).length, 1);
  assert.equal((await followups(ids[1])).length, 0);
  assert.equal((await contact(ids[1])).followup_requested, false);
  assert.equal((await followups(ids[2])).length, 1);
});

test("disabling cancels scheduled follow-ups for the batch", async () => {
  const { batchId, ids } = await sentBatch([{}, {}]);
  await put({ batchId, enabled: true, date: istDay(4) });
  const r = await put({ batchId, enabled: false });
  assert.deepEqual(r.json, { updated: 2, skipped: 0, total: 2 });
  for (const id of ids) {
    assert.equal((await contact(id)).followup_requested, false);
    assert.equal((await followups(id)).length, 0);
  }
});

test("replied/bounced contacts are skipped, not fatal", async () => {
  const { batchId, ids } = await sentBatch([{}, { status: "replied" }, { status: "bounced" }]);
  const r = await put({ batchId, enabled: true, date: istDay(2) });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { updated: 1, skipped: 2, total: 3 });
  assert.equal((await followups(ids[0])).length, 1);
  assert.equal((await followups(ids[1])).length, 0);
  assert.equal((await contact(ids[1])).followup_requested, false);
});

test("bad or past date is a 400 with no writes; enabled needs date; disabled forbids date", async () => {
  const { batchId, ids } = await sentBatch([{}]);
  for (const body of [
    { batchId, enabled: true, date: istDay(-1) },
    { batchId, enabled: true, date: "2026-02-30" },
    { batchId, enabled: true, date: istDay(120) },
    { batchId, enabled: true },
    { batchId, enabled: false, date: istDay(2) },
    { batchId, enabled: true, date: istDay(2), delayDays: 3 },
    { batchId: "nope", enabled: false },
  ]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await contact(ids[0])).followup_requested, false);
  assert.equal((await contact(ids[0])).followup_at, null);
});

test("unsent contacts: the date is stored with no follow-up message yet", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, [`fb${++n}_u@example.com`]);
  const id = contacts[0].id;
  const day = istDay(6);
  const r = await put({ batchId, enabled: true, date: day });
  assert.deepEqual(r.json, { updated: 1, skipped: 0, total: 1 });
  const row = await contact(id);
  assert.equal(row.followup_requested, true);
  assert.equal(row.followup_at.getTime(), opening(day));
  assert.equal((await followups(id)).length, 0);
});

test("re-applying with a new date moves the existing scheduled follow-up (no duplicate row)", async () => {
  const { batchId, ids } = await sentBatch([{}]);
  await put({ batchId, enabled: true, date: istDay(3) });
  const [first] = await followups(ids[0]);
  const later = istDay(8);
  const r = await put({ batchId, enabled: true, date: later });
  assert.deepEqual(r.json, { updated: 1, skipped: 0, total: 1 });
  const f = await followups(ids[0]);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, first.id);
  assert.equal(f[0].scheduled_for.getTime(), opening(later));
  assert.equal((await contact(ids[0])).followup_at.getTime(), opening(later));
});

test("company filter ignores surrounding whitespace stored on the contact", async () => {
  const { batchId, ids } = await sentBatch([{ company: "  Spaced Co " }, { company: "Spaced Co" }, { company: "Other" }]);
  const r = await put({ batchId, company: "spaced co", enabled: true, date: istDay(3) });
  assert.deepEqual(r.json, { updated: 2, skipped: 0, total: 2 });
  assert.equal((await followups(ids[2])).length, 0);
});

test("unknown batch is 404", async () => {
  assert.equal((await put({ batchId: "00000000-0000-4000-8000-000000000000", enabled: false })).status, 404);
});
