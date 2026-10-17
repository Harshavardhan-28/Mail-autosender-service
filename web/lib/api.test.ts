import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

type Call = { url: string; method: string; headers: Headers; body: unknown };

// Minimal fake backend: `handler` decides the response for each non-CSRF call.
function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>, tokens = ["tok-1", "tok-2", "tok-3"]) {
  const calls: Call[] = [];
  let csrfCount = 0;
  let n = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: (init.method ?? "GET").toUpperCase(),
      headers: new Headers(init.headers),
      body: init.body,
    };
    calls.push(call);
    if (call.url === "/api/auth/csrf") return json({ csrfToken: tokens[csrfCount++] });
    return handler(call, n++);
  });
  return { fn: fn as unknown as typeof fetch, calls, csrfCalls: () => calls.filter((c) => c.url === "/api/auth/csrf").length };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client CSRF handling", () => {
  it("fetches the CSRF token once and sends it on every mutating call", async () => {
    const f = fakeFetch(() => json({ contact: { id: "c1" } }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.markReplied("c1");
    await api.optOut("c2");
    expect(f.csrfCalls()).toBe(1);
    const mutating = f.calls.filter((c) => c.method === "POST");
    expect(mutating).toHaveLength(2);
    for (const c of mutating) expect(c.headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("shares one CSRF fetch between concurrent mutating calls", async () => {
    const f = fakeFetch(() => json({ contact: { id: "c" } }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await Promise.all([api.markReplied("a"), api.markReplied("b"), api.optOut("c")]);
    expect(f.csrfCalls()).toBe(1);
  });

  it("does not fetch a token or send the header for GET requests", async () => {
    const f = fakeFetch(() => json({ batches: [] }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.listBatches();
    expect(f.csrfCalls()).toBe(0);
    expect(f.calls[0]!.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("on 403 refetches the token and retries exactly once", async () => {
    const f = fakeFetch((_c, n) => (n === 0 ? json({ error: "Invalid CSRF token" }, 403) : json({ contact: { id: "c1" } })));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const contact = await api.markReplied("c1");
    expect(contact).toEqual({ id: "c1" });
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.headers.get("X-CSRF-Token"))).toEqual(["tok-1", "tok-2"]);
    expect(f.csrfCalls()).toBe(2);
  });

  it("does not retry a 403 that is not the backend's CSRF error", async () => {
    for (const body of [{ error: "Forbidden" }, null, { error: "invalid csrf token " }]) {
      const f = fakeFetch(() => (body ? json(body, 403) : new Response("", { status: 403 })));
      const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
      await expect(api.markReplied("c1")).rejects.toMatchObject({ status: 403 });
      expect(f.calls.filter((c) => c.method === "POST"), JSON.stringify(body)).toHaveLength(1);
      expect(f.csrfCalls()).toBe(1);
    }
  });

  it("gives up after one retry when the token is still refused", async () => {
    const f = fakeFetch(() => json({ error: "Invalid CSRF token" }, 403));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await expect(api.markReplied("c1")).rejects.toMatchObject({ status: 403 });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("keeps the rotated token returned by login and by change-password", async () => {
    const f = fakeFetch((c) => {
      if (c.url === "/api/auth/login") return json({ user: { id: "u", username: "admin" }, csrfToken: "after-login" });
      if (c.url === "/api/auth/change-password") return json({ ok: true, csrfToken: "after-change" });
      return json({ contact: {} });
    });
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.login("admin", "pw");
    await api.markReplied("x");
    await api.changePassword("old-password", "new-password-123");
    await api.optOut("y");
    const tokens = f.calls.filter((c) => c.method !== "GET").map((c) => [c.url, c.headers.get("X-CSRF-Token")]);
    expect(tokens).toEqual([
      ["/api/auth/login", "tok-1"],
      ["/api/contacts/x/mark-replied", "after-login"],
      ["/api/auth/change-password", "after-login"],
      ["/api/contacts/y/opt-out", "after-change"],
    ]);
  });

  it("sends credentials same-origin and JSON bodies", async () => {
    const f = fakeFetch(() => json({ message: { id: "m" } }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.scheduleContact("c1", "2030-01-01T09:00:00.000Z");
    const spy = f.fn as unknown as ReturnType<typeof vi.fn>;
    const init = spy.mock.calls.at(-1)![1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(f.calls.at(-1)!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(f.calls.at(-1)!.body))).toEqual({ sendAt: "2030-01-01T09:00:00.000Z" });
  });
});

describe("api client 401 and errors", () => {
  it("calls onUnauthorized on 401 and rejects", async () => {
    const onUnauthorized = vi.fn();
    const f = fakeFetch(() => json({ error: "Authentication required" }, 401));
    const api = createApi({ fetch: f.fn, onUnauthorized });
    await expect(api.getDashboard()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a failed login is an error to show, not a redirect", async () => {
    const onUnauthorized = vi.fn();
    const f = fakeFetch(() => json({ error: "Invalid username or password" }, 401));
    const api = createApi({ fetch: f.fn, onUnauthorized });
    await expect(api.login("admin", "nope")).rejects.toMatchObject({ status: 401, message: "Invalid username or password" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("exposes the refusal list of a 409 schedule response", async () => {
    const refused = [{ contactId: "c1", email: "a@x.com", reason: "replied" }];
    const f = fakeFetch(() => json({ error: "Some contacts cannot be scheduled", refused }, 409));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const err = await api.scheduleBatch("b1", { contactIds: ["c1"], sendAt: "2030-01-01T09:00:00.000Z" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.refused).toEqual(refused);
  });

  it("exposes row errors of a 422 upload and sends multipart without a JSON content-type", async () => {
    const errors = [{ row: 2, message: "Email is not a valid address" }];
    const f = fakeFetch(() => json({ error: "No valid rows to import", errors }, 422));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const file = new File(["a,b"], "leads.csv", { type: "text/csv" });
    const err = await api.uploadBatch(file, "Leads").catch((e) => e);
    expect(err.rowErrors).toEqual(errors);
    const upload = f.calls.find((c) => c.url === "/api/batches")!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect(upload.headers.get("content-type")).toBeNull();
    expect(upload.headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("previews a CSV as multipart without saving, and commits JSON rows with resolutions", async () => {
    const row = { row: 2, company: "A", role: "R", person: "P", email: "a@x.com", subject: "S", mailText: "M", followupText: null };
    const f = fakeFetch((c) => json(c.url === "/api/batches/preview" ? { filename: "leads.csv", suggestedName: "leads", rows: [row], errors: [], conflicts: [] } : { batch: { id: "b" }, contacts: [], errors: [], warnings: [], skipped: 1, replaced: 0 }, c.url.endsWith("commit") ? 201 : 200));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const prev = await api.previewBatch(new File(["a,b"], "leads.csv", { type: "text/csv" }));
    expect(prev.rows).toEqual([row]);
    const p = f.calls.find((c) => c.url === "/api/batches/preview")!;
    expect(p.body).toBeInstanceOf(FormData);
    expect(p.headers.get("X-CSRF-Token")).toBe("tok-1");
    const body = { name: "Leads", filename: "leads.csv", rows: [row], resolutions: { "a@x.com": "skip" as const } };
    await api.commitBatch(body);
    const c = f.calls.find((x) => x.url === "/api/batches/commit")!;
    expect(c.method).toBe("POST");
    expect(c.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(c.body as string)).toEqual(body);
  });

  it("exposes the conflicts of a 409 needs_resolution commit, and only for that code", async () => {
    const conflicts = [{ row: 2, email: "a@x.com", replaceable: true, matches: [] }];
    const f = fakeFetch(() => json({ error: "Duplicate emails need a decision", code: "needs_resolution", conflicts }, 409));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const err = await api.commitBatch({ name: "n", filename: "f.csv", rows: [], resolutions: {} }).catch((e) => e);
    expect(err.conflicts).toEqual(conflicts);
    const other = new ApiError(409, "x", { code: "not_replaceable", conflicts });
    expect(other.conflicts).toBeUndefined();
  });

  it("maps network failures to a readable ApiError", async () => {
    const api = createApi({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      onUnauthorized: vi.fn(),
    });
    await expect(api.getDashboard()).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/reach the server/i) });
  });

  it("builds the contacts query string from defined filters only", async () => {
    const f = fakeFetch(() => json({ contacts: [], total: 0, page: 1, pageSize: 25 }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.listContacts({ status: "sent", q: "acme co", page: 2 });
    expect(f.calls[0]!.url).toBe("/api/contacts?status=sent&q=acme+co&page=2");
  });

  it("uses the documented endpoints for scheduling, follow-up and cancel", async () => {
    const f = fakeFetch(() => json({ messages: [], message: {}, contact: {}, followup: null }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.scheduleBatch("b1", { contactIds: ["c1"], sendAt: "2030-01-01T09:00:00.000Z", staggerMinutes: 5 });
    await api.setFollowup("c1", { enabled: true, date: "2030-01-05" });
    await api.cancelMessage("m1");
    const sent = f.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url} ${c.body ?? ""}`);
    expect(sent).toEqual([
      'POST /api/batches/b1/schedule {"contactIds":["c1"],"sendAt":"2030-01-01T09:00:00.000Z","staggerMinutes":5}',
      'PUT /api/contacts/c1/followup {"enabled":true,"date":"2030-01-05"}',
      "DELETE /api/messages/m1 ",
    ]);
  });
});

describe("resume library calls", () => {
  it("uploads multipart with the CSRF token, and lists/renames/defaults/deletes/sets override", async () => {
    const f = fakeFetch(() => json({ resume: { id: "r" }, resumes: [], contact: {}, ok: true }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.uploadResume(new File(["%PDF-"], "cv.pdf", { type: "application/pdf" }), " My CV ");
    const up = f.calls.find((c) => c.method === "POST")!;
    expect(up.url).toBe("/api/resumes");
    expect(up.headers.get("X-CSRF-Token")).toBe("tok-1");
    expect(up.headers.get("content-type")).toBeNull();
    expect((up.body as FormData).get("displayName")).toBe("My CV");
    await api.listResumes();
    await api.updateResume("r/1", { displayName: "N" });
    await api.deleteResume("r/1");
    await api.setContactResume("c1", null);
    await api.scheduleBatch("b1", { contactIds: ["c1"], sendAt: "2030-01-01T00:00:00Z", resumeId: "r1" });
    const by = (m: string, u: string) => f.calls.find((c) => c.method === m && c.url === u);
    expect(by("GET", "/api/resumes")).toBeTruthy();
    expect(by("PUT", "/api/resumes/r%2F1")).toBeTruthy();
    expect(by("DELETE", "/api/resumes/r%2F1")).toBeTruthy();
    expect(JSON.parse(String(by("PUT", "/api/contacts/c1/resume")!.body))).toEqual({ resumeId: null });
    expect(JSON.parse(String(by("POST", "/api/batches/b1/schedule")!.body))).toMatchObject({ resumeId: "r1" });
  });
});

describe("delete and overdue calls", () => {
  it("uses the delete endpoints and only sends force when asked", async () => {
    const f = fakeFetch(() => json({ deleted: 1 }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    expect(await api.deleteContact("c/1")).toEqual({ deleted: 1 });
    await api.deleteContact("c1", true);
    await api.deleteContacts(["a", "b"]);
    await api.deleteContacts(["a"], true);
    await api.deleteBatch("b1");
    await api.deleteBatch("b1", true);
    const sent = f.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url} ${c.body ?? ""}`.trim());
    expect(sent).toEqual([
      "DELETE /api/contacts/c%2F1",
      "DELETE /api/contacts/c1?force=true",
      'POST /api/contacts/delete {"ids":["a","b"]}',
      'POST /api/contacts/delete {"ids":["a"],"force":true}',
      "DELETE /api/batches/b1",
      "DELETE /api/batches/b1?force=true",
    ]);
  });

  it("flags a needs_force refusal with its protected count", async () => {
    const f = fakeFetch(() => json({ error: "2 contacts were already emailed", code: "needs_force", protectedCount: 2 }, 409));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const err = await api.deleteContacts(["a", "b"]).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.needsForce).toBe(true);
    expect(err.protectedCount).toBe(2);
    const other = await createApi({ fetch: fakeFetch(() => json({ error: "x" }, 409)).fn, onUnauthorized: vi.fn() }).deleteBatch("b").catch((e) => e);
    expect(other.needsForce).toBe(false);
  });

  it("reads the overdue list and reschedules it", async () => {
    const f = fakeFetch((c) => (c.method === "GET" ? json({ count: 2, overdueMinutes: 60, messages: [] }) : json({ rescheduled: 2, messages: [], plan: { start: "s", slots: 1, perSlot: 2, staggerMinutes: 5, window: {} } })));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    expect((await api.getOverdue()).count).toBe(2);
    const r = await api.rescheduleOverdue({ staggerMinutes: 5 });
    expect(r.rescheduled).toBe(2);
    expect(f.calls.find((c) => c.method === "GET")!.url).toBe("/api/messages/overdue");
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/messages/reschedule-overdue");
    expect(JSON.parse(String(post.body))).toEqual({ staggerMinutes: 5 });
  });

  it("scheduleBatchWithPlan returns the server plan while scheduleBatch still returns messages", async () => {
    const plan = { start: "2030-01-01T03:30:00.000Z", slots: 12, perSlot: 2, staggerMinutes: 5, window: { start: "09:00", end: "10:00", tz: "Asia/Kolkata" } };
    const f = fakeFetch(() => json({ messages: [{ id: "m1" }], plan }, 201));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const body = { contactIds: ["c1"], sendAt: "2030-01-01T09:00:00.000Z", staggerMinutes: 5 };
    expect((await api.scheduleBatchWithPlan("b1", body)).plan).toEqual(plan);
    expect(await api.scheduleBatch("b1", body)).toEqual([{ id: "m1" }]);
  });
});
