import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { defaultAttachmentName } from "../../src/domain/attachmentName.js";

let t, c;
before(async () => {
  t = await startTestApp({ FROM_NAME: "Harshavardhan Khamkar" });
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

test("defaultAttachmentName: built from the sender name; plain 'Resume' without one", () => {
  assert.equal(defaultAttachmentName("Harshavardhan Khamkar"), "Harshavardhan_Khamkar_Resume");
  assert.equal(defaultAttachmentName("  Jo  O'Neil-Smith "), "Jo_O_Neil-Smith_Resume");
  assert.equal(defaultAttachmentName(""), "Resume");
  assert.equal(defaultAttachmentName(undefined), "Resume");
});

test("GET: the default comes from FROM_NAME until one is saved", async () => {
  const r = await c.get("/api/settings/attachment-name");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { name: "Harshavardhan_Khamkar_Resume", fileName: "Harshavardhan_Khamkar_Resume.pdf", isDefault: true });
});

test("PUT saves a name (a typed .pdf is dropped, whitespace trimmed); GET returns it", async () => {
  const r = await c.raw("PUT", "/api/settings/attachment-name", { body: { name: "  Harshavardhan_Khamkar_resume.PDF " } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { name: "Harshavardhan_Khamkar_resume", fileName: "Harshavardhan_Khamkar_resume.pdf", isDefault: false });
  assert.deepEqual((await c.get("/api/settings/attachment-name")).json.fileName, "Harshavardhan_Khamkar_resume.pdf");
});

test("PUT rejects empty, path-like, odd-character and over-long names", async () => {
  for (const name of ["", "   ", ".pdf", "../etc/passwd", "a/b", "na\\me", "bad\"quote", "x".repeat(101), 42]) {
    const r = await c.raw("PUT", "/api/settings/attachment-name", { body: { name } });
    assert.equal(r.status, 400, JSON.stringify(name));
  }
});

test("PUT with reset:true goes back to the default", async () => {
  const r = await c.raw("PUT", "/api/settings/attachment-name", { body: { reset: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.isDefault, true);
  assert.equal(r.json.fileName, "Harshavardhan_Khamkar_Resume.pdf");
});

test("requires auth", async () => {
  assert.equal((await t.client().raw("GET", "/api/settings/attachment-name")).status, 401);
});
