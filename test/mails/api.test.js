import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

let t, c, batchId, contacts, msgs;
const mins = (n) => new Date(Date.now() + n * 60_000);

before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
  ({ batchId, contacts } = await seedBatch(
    t.pool,
    ["a@m.example.com", "b@m.example.com", "c@m.example.com", "d@m.example.com", "e@m.example.com", "f@m.example.com"],
    {
      name: "Mail batch",
      overrides: {
        "a@m.example.com": { company: "Alpha", person: "Ann Lee", subject: "Hello Alpha", status: "sent", followup_requested: true },
        "b@m.example.com": { company: "Beta", person: "Bob Ray", status: "scheduled" },
        "c@m.example.com": { company: "Gamma", status: "scheduled" },
        "d@m.example.com": { company: "Delta", status: "scheduled" },
        "e@m.example.com": { company: "Eps_ilon", status: "sent" },
        "f@m.example.com": { company: "Zeta", status: "failed" },
      },
    },
  ));
  const sentAt1 = mins(-300);
  const sentAt2 = mins(-100);
  msgs = {
    sentA: await addMessage(t.pool, contacts[0].id, { state: "sent", sentAt: sentAt1, scheduledFor: sentAt1, messageId: "<a@x>", attempts: 1 }),
    fuA: await addMessage(t.pool, contacts[0].id, { kind: "followup", state: "scheduled", scheduledFor: mins(60 * 24 * 7) }),
    schedB: await addMessage(t.pool, contacts[1].id, { state: "scheduled", scheduledFor: mins(120) }),
    overdueC: await addMessage(t.pool, contacts[2].id, { state: "scheduled", scheduledFor: mins(-61) }),
    sendingD: await addMessage(t.pool, contacts[3].id, { state: "sending", scheduledFor: mins(-5) }),
    sentE: await addMessage(t.pool, contacts[4].id, { state: "sent", sentAt: sentAt2, scheduledFor: sentAt2, dryRun: true }),
    reviewF: await addMessage(t.pool, contacts[5].id, { state: "needs_review", scheduledFor: mins(-30) }),
  };
  await addMessage(t.pool, contacts[5].id, { kind: "followup", state: "cancelled" });
  await t.pool.query("UPDATE messages SET error = 'boom' WHERE id = $1", [msgs.reviewF.id]);
});
after(async () => t?.close());

test("requires auth", async () => {
  const r = await t.client().get("/api/mails");
  assert.equal(r.status, 401);
  assert.equal((await t.client().get(`/api/mails/${msgs.sentA.id}`)).status, 401);
});

test("state groups, ordering and counts", async () => {
  const sent = (await c.get("/api/mails?state=sent")).json;
  assert.deepEqual(sent.mails.map((m) => m.id), [msgs.sentE.id, msgs.sentA.id]); // sent_at DESC
  assert.deepEqual(sent.counts, { sent: 2, scheduled: 4, attention: 1 });
  const sched = (await c.get("/api/mails?state=scheduled")).json;
  assert.deepEqual(sched.mails.map((m) => m.id), [msgs.overdueC.id, msgs.sendingD.id, msgs.schedB.id, msgs.fuA.id]); // scheduled_for ASC
  assert.equal(sched.total, 4);
  const att = (await c.get("/api/mails?state=attention")).json;
  assert.deepEqual(att.mails.map((m) => m.id), [msgs.reviewF.id]);
  const all = (await c.get("/api/mails")).json;
  assert.equal(all.total, 7); // cancelled excluded
  assert.deepEqual(all.counts, { sent: 2, scheduled: 4, attention: 1 });
});

test("row shape, overdue and dry run flags", async () => {
  const sched = (await c.get("/api/mails?state=scheduled")).json.mails;
  const overdue = sched.find((m) => m.id === msgs.overdueC.id);
  assert.equal(overdue.overdue, true);
  assert.equal(sched.find((m) => m.id === msgs.schedB.id).overdue, false);
  assert.equal(sched.find((m) => m.id === msgs.sendingD.id).overdue, false);
  const a = (await c.get("/api/mails?state=sent")).json.mails.find((m) => m.id === msgs.sentA.id);
  assert.equal(a.kind, "initial");
  assert.equal(a.state, "sent");
  assert.equal(a.attempts, 1);
  assert.equal(a.dryRun, false);
  assert.equal(a.subject, "Hello Alpha");
  assert.equal(a.sentAt, msgs.sentA.sent_at.toISOString());
  assert.deepEqual(a.contact, { id: contacts[0].id, person: "Ann Lee", company: "Alpha", role: "SWE Intern", email: "a@m.example.com", status: "sent", repliedAt: null });
  assert.deepEqual(a.batch, { id: batchId, name: "Mail batch" });
  assert.equal((await c.get("/api/mails?state=sent")).json.mails.find((m) => m.id === msgs.sentE.id).dryRun, true);
  const f = (await c.get("/api/mails?state=attention")).json.mails[0];
  assert.equal(f.error, "boom");
  const fu = sched.find((m) => m.id === msgs.fuA.id);
  assert.equal(fu.kind, "followup");
  assert.equal(fu.subject, "Re: Hello Alpha");
});

test("kind, q (escaped) and batchId filters; counts stay global", async () => {
  const fu = (await c.get("/api/mails?kind=followup")).json;
  assert.deepEqual(fu.mails.map((m) => m.id), [msgs.fuA.id]);
  assert.equal(fu.counts.sent, 2);
  assert.deepEqual((await c.get("/api/mails?q=beta")).json.mails.map((m) => m.id), [msgs.schedB.id]);
  assert.deepEqual((await c.get("/api/mails?q=ann%20lee&state=all")).json.mails.map((m) => m.id).sort(), [msgs.sentA.id, msgs.fuA.id].sort());
  assert.deepEqual((await c.get("/api/mails?q=d%40m.example")).json.mails.map((m) => m.id), [msgs.sendingD.id]);
  assert.equal((await c.get("/api/mails?q=%25")).json.total, 0);
  assert.equal((await c.get("/api/mails?q=Eps_ilon")).json.total, 1);
  assert.equal((await c.get(`/api/mails?batchId=${batchId}`)).json.total, 7);
  assert.equal((await c.get("/api/mails?batchId=00000000-0000-4000-8000-000000000000")).json.total, 0);
});

test("pagination and validation", async () => {
  const p1 = (await c.get("/api/mails?state=scheduled&pageSize=3&page=1")).json;
  const p2 = (await c.get("/api/mails?state=scheduled&pageSize=3&page=2")).json;
  assert.equal(p1.mails.length, 3);
  assert.equal(p2.mails.length, 1);
  assert.equal(p1.total, 4);
  assert.equal(p2.page, 2);
  assert.equal((await c.get("/api/mails")).json.pageSize, 25);
  for (const q of ["pageSize=101", "pageSize=0", "page=0", "state=nope", "kind=x", "bogus=1", "batchId=nope"]) {
    assert.equal((await c.get(`/api/mails?${q}`)).status, 400, q);
  }
});

test("detail: initial mail", async () => {
  await t.pool.query("INSERT INTO events(contact_id, type, meta) VALUES ($1,'scheduled',$2), ($1,'sent',$3), ($1,'scheduled',$4)", [
    contacts[0].id,
    JSON.stringify({ messageId: msgs.sentA.id }),
    JSON.stringify({ messageId: msgs.sentA.id, kind: "initial" }),
    JSON.stringify({ messageId: msgs.fuA.id }),
  ]);
  const r = await c.get(`/api/mails/${msgs.sentA.id}`);
  assert.equal(r.status, 200);
  const m = r.json.mail;
  assert.equal(m.id, msgs.sentA.id);
  assert.equal(m.subject, "Hello Alpha");
  assert.match(m.body, /Hello there\./);
  assert.doesNotMatch(m.body, /\*\*/);
  assert.equal(m.messageId, "<a@x>");
  assert.equal(m.threadedWith, null);
  assert.deepEqual(m.timeline.map((e) => e.type), ["scheduled", "sent"]);
  assert.ok("attachment" in m);
  assert.equal(m.related.id, msgs.fuA.id);
  assert.equal(m.related.kind, "followup");
});

test("detail: follow-up uses template and followup_text override, threads to initial", async () => {
  const r = await c.get(`/api/mails/${msgs.fuA.id}`);
  const m = r.json.mail;
  assert.equal(m.kind, "followup");
  assert.equal(m.subject, "Re: Hello Alpha");
  assert.match(m.body, /Hi Ann,/);
  assert.equal(m.threadedWith, msgs.sentA.id);
  assert.equal(m.related.id, msgs.sentA.id);
  assert.deepEqual(m.timeline.map((e) => e.type), ["scheduled"]);
  await t.pool.query("UPDATE contacts SET followup_text = 'Custom nudge' WHERE id = $1", [contacts[0].id]);
  assert.match((await c.get(`/api/mails/${msgs.fuA.id}`)).json.mail.body, /Custom nudge/);
});

test("detail: a follow-up shows no attachment even when the initial carries a resume", async () => {
  const { rows } = await t.pool.query(
    "INSERT INTO resumes(display_name, file_name, storage_key, generation, size_bytes, sha256) VALUES ('CV', 'cv.pdf', 'k-detail', '1', 10, 'x') RETURNING id",
  );
  await t.pool.query("UPDATE messages SET resume_id = $1 WHERE id = ANY($2::uuid[])", [rows[0].id, [msgs.sentA.id, msgs.fuA.id]]);
  try {
    assert.equal((await c.get(`/api/mails/${msgs.sentA.id}`)).json.mail.attachment.displayName, "CV");
    assert.equal((await c.get(`/api/mails/${msgs.fuA.id}`)).json.mail.attachment, null);
  } finally {
    await t.pool.query("UPDATE messages SET resume_id = NULL WHERE resume_id = $1", [rows[0].id]);
    await t.pool.query("DELETE FROM resumes WHERE id = $1", [rows[0].id]);
  }
});

test("detail: needs_review plus contact-level reply events in timeline", async () => {
  await t.pool.query("INSERT INTO events(contact_id, type, meta) VALUES ($1,'needs_review',$2), ($1,'replied','{}'), ($1,'opted_out','{}'), ($1,'send_failed',$3)", [
    contacts[5].id,
    JSON.stringify({ messageId: msgs.reviewF.id }),
    JSON.stringify({ messageId: msgs.sentA.id }),
  ]);
  const m = (await c.get(`/api/mails/${msgs.reviewF.id}`)).json.mail;
  assert.equal(m.state, "needs_review");
  assert.equal(m.error, "boom");
  assert.deepEqual(m.timeline.map((e) => e.type), ["needs_review", "replied", "opted_out"]);
  assert.ok(m.timeline.every((e) => typeof e.at === "string" && typeof e.meta === "object"));
});

test("detail 404 and 400", async () => {
  assert.equal((await c.get("/api/mails/00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await c.get("/api/mails/nope")).status, 400);
});

test("cancelled messages are not reachable", async () => {
  const { rows } = await t.pool.query("SELECT id FROM messages WHERE state = 'cancelled' LIMIT 1");
  assert.equal((await c.get(`/api/mails/${rows[0].id}`)).status, 404);
});
