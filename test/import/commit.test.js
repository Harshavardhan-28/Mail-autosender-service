import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

const H = '"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"';
const line = (e, o = {}) =>
  ["Acme", "SWE", "Jo", e, o.s ?? "SWE role at Acme", "Hi Jo,\n\nHello **there**.\n\nBest,\nH", ""].map((x) => `"${x.replace(/"/g, '""')}"`).join(",");

let t, c;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

const preview = (emails, { filename = "leads.csv", client = c } = {}) => {
  const f = new FormData();
  f.append("file", new Blob([`${H}\n${emails.map((e) => line(e)).join("\n")}`], { type: "text/csv" }), filename);
  return client.raw("POST", "/api/batches/preview", { rawBody: f });
};
const rowOf = (email, o = {}) => ({ company: "Acme", role: "SWE", person: "Jo", email, subject: "Subj", mailText: "Hi Jo,\n\nHello.", followupText: null, ...o });
const commit = (body, client = c) => client.post("/api/batches/commit", body);
const count = async (sql, p = []) => Number((await t.pool.query(sql, p)).rows[0].n);

test("auth and CSRF required for preview/commit", async () => {
  const anon = t.client();
  assert.equal((await anon.raw("POST", "/api/batches/preview")).status, 401);
  assert.equal((await anon.raw("POST", "/api/batches/commit")).status, 401);
  const noCsrf = t.client();
  await noCsrf.login();
  noCsrf.csrf = null;
  assert.equal((await noCsrf.raw("POST", "/api/batches/commit", { body: {}, csrf: false })).status, 403);
});

test("preview: no DB writes; conflicts are case-insensitive with replaceable flag", async () => {
  const { batchId } = await seedBatch(t.pool, ["Dup1@pv.example.com", "dup2@pv.example.com"], {
    name: "Old batch",
    overrides: { "dup2@pv.example.com": { status: "sent" } },
  });
  const before = [await count("select count(*) n from batches"), await count("select count(*) n from contacts"), await count("select count(*) n from events")];
  const r = await preview(["dup1@pv.example.com", "DUP2@pv.example.com", "fresh@pv.example.com", "bad-email"], { filename: "My leads.csv" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.filename, "My leads.csv");
  assert.equal(r.json.suggestedName, "My leads");
  assert.equal(r.json.rows.length, 3);
  assert.equal(r.json.rows[0].email, "dup1@pv.example.com");
  assert.equal(r.json.errors.length, 1);
  assert.equal(r.json.conflicts.length, 2);
  const [a, b] = r.json.conflicts;
  assert.equal(a.row, 2);
  assert.equal(a.replaceable, true);
  assert.equal(a.matches[0].batchId, batchId);
  assert.equal(a.matches[0].batchName, "Old batch");
  assert.equal(a.matches[0].status, "uploaded");
  assert.ok(a.matches[0].contactId);
  assert.equal(b.replaceable, false);
  assert.equal(b.matches[0].status, "sent");
  const after = [await count("select count(*) n from batches"), await count("select count(*) n from contacts"), await count("select count(*) n from events")];
  assert.deepEqual(after, before);
});

test("preview: 422 when no valid row; 400 without file", async () => {
  const r = await preview(["nope"]);
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "No valid rows to import");
  assert.equal(r.json.errors.length, 1);
  assert.equal((await c.raw("POST", "/api/batches/preview", { rawBody: new FormData() })).status, 400);
});

test("commit happy path has the POST / shape", async () => {
  const r = await commit({ name: "Fresh", filename: "f.csv", rows: [rowOf("c1@cm.example.com", { row: 5 }), rowOf("c2@cm.example.com", { followupText: "Nudge" })] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.batch.name, "Fresh");
  assert.equal(r.json.batch.originalFilename, "f.csv");
  assert.equal(r.json.contacts.length, 2);
  assert.deepEqual(r.json.errors, []);
  assert.deepEqual(r.json.warnings, []);
  assert.equal(r.json.skipped, 0);
  assert.equal(r.json.replaced, 0);
  const [a, b] = r.json.contacts;
  assert.equal(a.row, 5);
  assert.equal(b.row, 3);
  assert.equal(a.status, "uploaded");
  assert.equal(a.attachment, null);
  assert.equal(a.preview.subject, "Subj");
  assert.equal(b.followupText, "Nudge");
  assert.equal(await count("select count(*) n from events where type='imported' and meta->>'batchId'=$1", [r.json.batch.id]), 2);
  const ev = await t.pool.query("select meta from events where type='batch_created' and meta->>'batchId'=$1", [r.json.batch.id]);
  assert.equal(ev.rows[0].meta.imported, 2);
  assert.equal(ev.rows[0].meta.rejected, 0);
});

test("commit: name defaults from filename, then to 'Imported batch'", async () => {
  const a = await commit({ filename: "Q4 list.csv", rows: [rowOf("n1@cm.example.com")] });
  assert.equal(a.json.batch.name, "Q4 list");
  const b = await commit({ rows: [rowOf("n2@cm.example.com")] });
  assert.equal(b.json.batch.name, "Imported batch");
});

test("commit: body is validated strictly", async () => {
  assert.equal((await commit({ rows: [] })).status, 400);
  assert.equal((await commit({ rows: [rowOf("z@cm.example.com")], extra: 1 })).status, 400);
  assert.equal((await commit({ rows: [{ ...rowOf("z@cm.example.com"), bogus: 1 }] })).status, 400);
  assert.equal((await commit({ rows: [rowOf("z@cm.example.com")], resolutions: { "z@cm.example.com": "nuke" } })).status, 400);
  assert.equal((await commit({ name: "a\nb", rows: [rowOf("z@cm.example.com")] })).status, 400);
});

test("commit: edited rows are re-validated (invalid, duplicate, suppressed -> 422, nothing written)", async () => {
  await t.pool.query("insert into suppressions(email, reason) values ('sup@cm.example.com','opt_out')");
  const n = await count("select count(*) n from batches");
  const r = await commit({ rows: [rowOf("ok@cm.example.com"), rowOf("not-an-email"), rowOf("SUP@cm.example.com"), rowOf("ok@cm.example.com")] });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "Some rows are invalid");
  assert.deepEqual(r.json.errors.map((e) => e.row), [3, 4, 5]);
  assert.equal(await count("select count(*) n from batches"), n);
});

test("commit: unresolved conflict -> 409 needs_resolution", async () => {
  await seedBatch(t.pool, ["u1@cm.example.com"]);
  const n = await count("select count(*) n from batches");
  const r = await commit({ rows: [rowOf("U1@cm.example.com"), rowOf("u2@cm.example.com")] });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "needs_resolution");
  assert.equal(r.json.conflicts.length, 1);
  assert.equal(r.json.conflicts[0].matches[0].status, "uploaded");
  assert.equal(await count("select count(*) n from batches"), n);
});

test("commit: skip drops the row", async () => {
  await seedBatch(t.pool, ["sk1@cm.example.com"]);
  const r = await commit({ rows: [rowOf("sk1@cm.example.com"), rowOf("sk2@cm.example.com")], resolutions: { "sk1@cm.example.com": "skip" } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.contacts.length, 1);
  assert.equal(r.json.contacts[0].email, "sk2@cm.example.com");
  assert.equal(r.json.skipped, 1);
  assert.equal(r.json.replaced, 0);
});

test("commit: replace deletes the old contact and its scheduled message, writes an event", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, ["rp1@cm.example.com"], { overrides: { "rp1@cm.example.com": { status: "scheduled" } } });
  await addMessage(t.pool, contacts[0].id, { state: "scheduled", scheduledFor: new Date(Date.now() + 3600_000) });
  const r = await commit({ rows: [rowOf("RP1@cm.example.com", { subject: "New subject" })], resolutions: { "rp1@cm.example.com": "replace" } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.replaced, 1);
  assert.equal(r.json.contacts[0].subject, "New subject");
  assert.equal(await count("select count(*) n from contacts where id=$1", [contacts[0].id]), 0);
  assert.equal(await count("select count(*) n from messages where contact_id=$1", [contacts[0].id]), 0);
  const ev = await t.pool.query("select contact_id, meta from events where type='contact_replaced' and meta->>'oldContactId'=$1", [contacts[0].id]);
  assert.equal(ev.rowCount, 1);
  assert.equal(ev.rows[0].meta.email.toLowerCase(), "rp1@cm.example.com");
  assert.equal(ev.rows[0].meta.oldBatchId, batchId);
  assert.equal(ev.rows[0].meta.oldStatus, "scheduled");
});

test("commit: keep inserts alongside the old one with a warning", async () => {
  await seedBatch(t.pool, ["kp1@cm.example.com"], { overrides: { "kp1@cm.example.com": { status: "sent" } } });
  const r = await commit({ rows: [rowOf("kp1@cm.example.com", { row: 7 })], resolutions: { "kp1@cm.example.com": "keep" } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.contacts.length, 1);
  assert.equal(r.json.warnings.length, 1);
  assert.equal(r.json.warnings[0].row, 7);
  assert.equal(r.json.warnings[0].existingStatus, "sent");
  assert.equal(await count("select count(*) n from contacts where lower(email)='kp1@cm.example.com'"), 2);
});

test("commit: replace on an already-emailed contact -> 409 not_replaceable, nothing changes", async () => {
  const { contacts } = await seedBatch(t.pool, ["nr1@cm.example.com"], { overrides: { "nr1@cm.example.com": { status: "replied" } } });
  const n = await count("select count(*) n from batches");
  const r = await commit({ rows: [rowOf("nr1@cm.example.com")], resolutions: { "nr1@cm.example.com": "replace" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "not_replaceable");
  assert.match(r.json.error, /nr1@cm\.example\.com/);
  assert.equal(await count("select count(*) n from contacts where id=$1", [contacts[0].id]), 1);
  assert.equal(await count("select count(*) n from batches"), n);
});

test("commit: every row skipped -> 422 and no batch", async () => {
  await seedBatch(t.pool, ["al1@cm.example.com"]);
  const n = await count("select count(*) n from batches");
  const r = await commit({ rows: [rowOf("al1@cm.example.com")], resolutions: { "al1@cm.example.com": "skip" } });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "Nothing to import: every row was skipped");
  assert.equal(await count("select count(*) n from batches"), n);
});

test("commit: a failure mid-way rolls back replace + batch (atomic)", async () => {
  const { contacts } = await seedBatch(t.pool, ["at1@cm.example.com"], { overrides: { "at1@cm.example.com": { status: "scheduled" } } });
  const n = await count("select count(*) n from batches");
  // Force the contacts insert to fail after the replace delete has run.
  await t.pool.query(`create function ${"fail_insert_" + process.pid}() returns trigger language plpgsql as $$ begin if new.email = 'boom@cm.example.com' then raise exception 'boom'; end if; return new; end $$`);
  await t.pool.query(`create trigger fail_insert_trg before insert on contacts for each row execute function ${"fail_insert_" + process.pid}()`);
  try {
    const r = await commit({ rows: [rowOf("at1@cm.example.com"), rowOf("boom@cm.example.com")], resolutions: { "at1@cm.example.com": "replace" } });
    assert.equal(r.status, 500);
  } finally {
    await t.pool.query("drop trigger fail_insert_trg on contacts");
  }
  assert.equal(await count("select count(*) n from contacts where id=$1", [contacts[0].id]), 1);
  assert.equal(await count("select count(*) n from batches"), n);
  assert.equal(await count("select count(*) n from events where type='contact_replaced' and meta->>'oldContactId'=$1", [contacts[0].id]), 0);
});

test("commit accepts a full-size payload (above the global 100kb JSON limit)", async () => {
  const big = "x".repeat(2000);
  const rows = Array.from({ length: 200 }, (_, i) => rowOf(`big${i}@cm.example.com`, { mailText: big }));
  const r = await commit({ rows });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  assert.equal(r.json.contacts.length, 200);
});
