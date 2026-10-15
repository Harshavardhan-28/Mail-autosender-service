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

const del = (path, client = c) => client.raw("DELETE", path);
const count = async (sql, p = []) => Number((await t.pool.query(sql, p)).rows[0].n);
const ZERO = "00000000-0000-4000-8000-000000000000";

test("auth and CSRF are required for delete routes", async () => {
  const anon = t.client();
  for (const [m, p] of [["DELETE", `/api/contacts/${ZERO}`], ["POST", "/api/contacts/delete"], ["DELETE", `/api/batches/${ZERO}`]]) {
    assert.equal((await anon.raw(m, p)).status, 401, `${m} ${p}`);
  }
  const noCsrf = t.client();
  await noCsrf.login();
  noCsrf.csrf = null;
  assert.equal((await noCsrf.raw("DELETE", `/api/contacts/${ZERO}`, { csrf: false })).status, 403);
  assert.equal((await noCsrf.raw("POST", "/api/contacts/delete", { body: { ids: [ZERO] }, csrf: false })).status, 403);
  assert.equal((await noCsrf.raw("DELETE", `/api/batches/${ZERO}`, { csrf: false })).status, 403);
});

test("single delete: scheduled contact goes, its messages cascade, event is written", async () => {
  const { contacts } = await seedBatch(t.pool, ["d1@del.example.com"], { overrides: { "d1@del.example.com": { status: "scheduled" } } });
  const id = contacts[0].id;
  await addMessage(t.pool, id, { state: "scheduled", scheduledFor: new Date(Date.now() + 3600_000) });
  const r = await del(`/api/contacts/${id}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { deleted: 1 });
  assert.equal(await count("select count(*) n from contacts where id=$1", [id]), 0);
  assert.equal(await count("select count(*) n from messages where contact_id=$1", [id]), 0);
  const ev = await t.pool.query("select contact_id, meta from events where type='contact_deleted' and meta->>'email'='d1@del.example.com'");
  assert.equal(ev.rowCount, 1);
  assert.equal(ev.rows[0].contact_id, null);
  assert.equal(ev.rows[0].meta.status, "scheduled");
});

test("single delete: 404 unknown, 400 bad id / bad force", async () => {
  assert.equal((await del(`/api/contacts/${ZERO}`)).status, 404);
  assert.equal((await del("/api/contacts/nope")).status, 400);
  assert.equal((await del(`/api/contacts/${ZERO}?force=maybe`)).status, 400);
});

test("sent/replied/needs_review-message contacts are protected until force", async () => {
  const { contacts } = await seedBatch(t.pool, ["p1@del.example.com", "p2@del.example.com", "p3@del.example.com"], {
    overrides: { "p1@del.example.com": { status: "sent" }, "p2@del.example.com": { status: "replied" }, "p3@del.example.com": { status: "scheduled" } },
  });
  await addMessage(t.pool, contacts[2].id, { state: "needs_review" });
  for (const ct of contacts) {
    const r = await del(`/api/contacts/${ct.id}`);
    assert.equal(r.status, 409, ct.email);
    assert.equal(r.json.code, "needs_force");
    assert.equal(r.json.protectedCount, 1);
  }
  assert.equal(await count("select count(*) n from contacts where id = any($1)", [contacts.map((x) => x.id)]), 3);
  const ok = await del(`/api/contacts/${contacts[0].id}?force=true`);
  assert.equal(ok.status, 200);
  assert.equal(await count("select count(*) n from contacts where id=$1", [contacts[0].id]), 0);
});

test("bulk delete: any protected target blocks everything without force; force deletes all", async () => {
  const { contacts } = await seedBatch(t.pool, ["b1@del.example.com", "b2@del.example.com", "b3@del.example.com"], {
    overrides: { "b2@del.example.com": { status: "sent" }, "b3@del.example.com": { status: "bounced" } },
  });
  const ids = contacts.map((x) => x.id);
  const blocked = await c.post("/api/contacts/delete", { ids });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, "needs_force");
  assert.equal(blocked.json.protectedCount, 1);
  assert.equal(await count("select count(*) n from contacts where id = any($1)", [ids]), 3);
  const ok = await c.post("/api/contacts/delete", { ids, force: true });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { deleted: 3 });
  assert.equal(await count("select count(*) n from contacts where id = any($1)", [ids]), 0);
});

test("bulk delete: unknown ids ignored, none existing -> 404, shape is strict", async () => {
  const { contacts } = await seedBatch(t.pool, ["k1@del.example.com"]);
  const r = await c.post("/api/contacts/delete", { ids: [contacts[0].id, ZERO] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deleted: 1 });
  assert.equal((await c.post("/api/contacts/delete", { ids: [ZERO] })).status, 404);
  assert.equal((await c.post("/api/contacts/delete", { ids: [] })).status, 400);
  assert.equal((await c.post("/api/contacts/delete", { ids: [ZERO, ZERO] })).status, 400);
  assert.equal((await c.post("/api/contacts/delete", { ids: ["x"] })).status, 400);
  assert.equal((await c.post("/api/contacts/delete", { ids: [ZERO], extra: 1 })).status, 400);
  assert.equal((await c.post("/api/contacts/delete", { ids: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) })).status, 400);
});

test("deleting an opted-out contact leaves the suppression in place", async () => {
  const { contacts } = await seedBatch(t.pool, ["s1@del.example.com"]);
  assert.equal((await c.post(`/api/contacts/${contacts[0].id}/opt-out`)).status, 200);
  assert.equal((await del(`/api/contacts/${contacts[0].id}`)).status, 200);
  assert.equal(await count("select count(*) n from suppressions where email='s1@del.example.com'"), 1);
});

test("batch delete: removes contacts and messages, writes events, honours protection", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, ["x1@del.example.com", "x2@del.example.com"], {
    name: "doomed",
    overrides: { "x1@del.example.com": { status: "scheduled" }, "x2@del.example.com": { status: "sent" } },
  });
  await addMessage(t.pool, contacts[0].id, { state: "scheduled" });
  const blocked = await del(`/api/batches/${batchId}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, "needs_force");
  assert.equal(await count("select count(*) n from batches where id=$1", [batchId]), 1);
  const r = await del(`/api/batches/${batchId}?force=true`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { deleted: 2, batchId });
  assert.equal(await count("select count(*) n from batches where id=$1", [batchId]), 0);
  assert.equal(await count("select count(*) n from contacts where batch_id=$1", [batchId]), 0);
  assert.equal(await count("select count(*) n from messages where contact_id = any($1)", [contacts.map((x) => x.id)]), 0);
  assert.equal(await count("select count(*) n from events where type='contact_deleted' and meta->>'batchId'=$1", [batchId]), 2);
  const be = await t.pool.query("select meta from events where type='batch_deleted' and meta->>'batchId'=$1", [batchId]);
  assert.equal(be.rowCount, 1);
  assert.equal(be.rows[0].meta.name, "doomed");
  assert.equal(be.rows[0].meta.contacts, 2);
});

test("batch delete: unprotected batch needs no force; 404 / 400", async () => {
  const { batchId } = await seedBatch(t.pool, ["y1@del.example.com"]);
  assert.equal((await del(`/api/batches/${batchId}`)).status, 200);
  assert.equal((await del(`/api/batches/${ZERO}`)).status, 404);
  assert.equal((await del("/api/batches/nope")).status, 400);
});
