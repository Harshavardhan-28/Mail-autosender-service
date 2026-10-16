import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

let t, c, b1, b2;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
  b1 = await seedBatch(t.pool, ["a@co.example.com", "b@co.example.com", "c@co.example.com", "d@co.example.com"], {
    name: "one",
    overrides: {
      "a@co.example.com": { company: "Acme" },
      "b@co.example.com": { company: "acme" },
      "c@co.example.com": { company: "Acme Labs" },
      "d@co.example.com": { company: "Zen_co" },
    },
  });
  b2 = await seedBatch(t.pool, ["e@co.example.com"], { name: "two", overrides: { "e@co.example.com": { company: "Acme" } } });
  for (const x of [...b1.contacts, ...b2.contacts]) await addMessage(t.pool, x.id, { scheduledFor: new Date(Date.now() + 3_600_000) });
});
after(async () => t?.close());

const emails = (list) => list.map((x) => x.email ?? x.contact.email).sort();

test("contacts: company filter is an exact, case-insensitive match (no prefix or LIKE wildcards)", async () => {
  const r = await c.get(`/api/contacts?company=ACME`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(emails(r.json.contacts), ["a@co.example.com", "b@co.example.com", "e@co.example.com"]);
  assert.equal(r.json.total, 3);
  const scoped = await c.get(`/api/contacts?company=acme&batchId=${b1.batchId}`);
  assert.deepEqual(emails(scoped.json.contacts), ["a@co.example.com", "b@co.example.com"]);
  const wild = await c.get(`/api/contacts?company=Zen%25`);
  assert.equal(wild.json.total, 0);
});

test("mails: company filter is exact and case-insensitive", async () => {
  const r = await c.get(`/api/mails?company=acme&state=all`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(emails(r.json.mails), ["a@co.example.com", "b@co.example.com", "e@co.example.com"]);
  const scoped = await c.get(`/api/mails?company=Acme%20Labs&batchId=${b1.batchId}`);
  assert.deepEqual(emails(scoped.json.mails), ["c@co.example.com"]);
});

test("companies: distinct names (case-folded) with counts, optionally per batch", async () => {
  const all = await c.get(`/api/companies`);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.json.companies, [
    { company: "Acme", count: 3 },
    { company: "Acme Labs", count: 1 },
    { company: "Zen_co", count: 1 },
  ]);
  const one = await c.get(`/api/companies?batchId=${b2.batchId}`);
  assert.deepEqual(one.json.companies, [{ company: "Acme", count: 1 }]);
  assert.equal((await c.get(`/api/companies?batchId=nope`)).status, 400);
});

test("companies requires auth", async () => {
  assert.equal((await t.client().raw("GET", "/api/companies")).status, 401);
});
