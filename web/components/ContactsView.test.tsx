import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { ContactsView } from "./ContactsView";
import { resetApiState } from "@/lib/api";
import type { ContactListItem } from "@/lib/types";

const row: ContactListItem = {
  id: "c-1",
  batchId: "b-1",
  company: "Acme",
  role: "SWE",
  person: "Jo Smith",
  email: "jo@acme.com",
  subject: "s",
  mailText: "m",
  followupText: null,
  status: "scheduled",
  followupRequested: false,
  followupDelayDays: 7,
  followupAt: null,
  repliedAt: null,
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  messages: [{ id: "m-1", kind: "initial", state: "scheduled", scheduledFor: "2030-02-01T09:00:00Z", sentAt: null }],
};

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("ContactsView", () => {
  it("filters by the batch from the URL and offers no per-send columns or cancel (those live under Mail)", async () => {
    const seen = stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [] }) : json({ contacts: [row], total: 1, page: 1, pageSize: 25 })));
    render(<ContactsView initialBatchId="b-1" initialQ="jo@" />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for jo@acme.com" }));
    expect(screen.queryByRole("menuitem", { name: "Cancel send" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reschedule" })).toBeInTheDocument();
    expect(seen.find((c) => c.url.startsWith("/api/contacts"))!.url).toBe("/api/contacts?q=jo%40&batchId=b-1&page=1&pageSize=25");
    expect(screen.queryByRole("columnheader", { name: "Next send" })).toBeNull();
  });

  it("links each contact to its mail, preferring the one still pending", async () => {
    const both: ContactListItem = {
      ...row,
      messages: [
        { id: "m-sent", kind: "initial", state: "sent", scheduledFor: "2030-02-01T09:00:00Z", sentAt: "2030-02-01T09:00:10Z" },
        { id: "m-fu", kind: "followup", state: "scheduled", scheduledFor: "2030-02-08T09:00:00Z", sentAt: null },
      ],
    };
    const none: ContactListItem = { ...row, id: "c-2", email: "no@acme.com", status: "uploaded", messages: [] };
    stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [] }) : json({ contacts: [both, none], total: 2, page: 1, pageSize: 25 })));
    render(<ContactsView />);
    expect(await screen.findByRole("link", { name: "View mail for jo@acme.com" })).toHaveAttribute("href", "/mail/m-fu");
    expect(screen.queryByRole("link", { name: "View mail for no@acme.com" })).toBeNull();
  });

  it("asks before opting out, then calls the opt-out endpoint", async () => {
    const seen = stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [] }) : c.method === "POST" ? json({ contact: row }) : json({ contacts: [row], total: 1, page: 1, pageSize: 25 })));
    render(<ContactsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for jo@acme.com" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Opt out" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/stop all sends\?/i)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Opt out" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "POST")?.url).toBe("/api/contacts/c-1/opt-out"));
  });

  it("shows which resume goes out and lets the operator pick a per-contact override", async () => {
    const withAtt: ContactListItem = { ...row, status: "uploaded", messages: [], attachment: { id: "r-1", displayName: "General SWE", source: "default" } };
    const seen = stubFetch((c) => {
      if (c.url === "/api/batches") return json({ batches: [] });
      if (c.url === "/api/resumes") return json({ resumes: [{ id: "r-1", displayName: "General SWE", isDefault: true }, { id: "r-2", displayName: "Backend", isDefault: false }] });
      if (c.method === "PUT") return json({ contact: { ...withAtt, resumeId: "r-2" } });
      return json({ contacts: [withAtt], total: 1, page: 1, pageSize: 25 });
    });
    render(<ContactsView />);
    const select = await screen.findByRole("combobox", { name: /resume for jo@acme.com/i });
    expect(screen.getByText(/Attachment: General SWE/)).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /default \(General SWE\)/i })).toBeInTheDocument();
    await userEvent.selectOptions(select, "r-2");
    await vi.waitFor(() => expect(seen.find((c) => c.method === "PUT")).toBeTruthy());
    expect(seen.find((c) => c.method === "PUT")!.url).toBe("/api/contacts/c-1/resume");
    expect(JSON.parse(String(seen.find((c) => c.method === "PUT")!.body))).toEqual({ resumeId: "r-2" });
  });

  it("does not offer a resume picker once the email is sent, only the attachment text", async () => {
    const sent: ContactListItem = { ...row, status: "sent", messages: [{ id: "m-1", kind: "initial", state: "sent", scheduledFor: "2030-02-01T09:00:00Z", sentAt: "2030-02-01T09:00:10Z" }], attachment: { id: "r-1", displayName: "General SWE", source: "scheduled" } };
    stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [] }) : c.url === "/api/resumes" ? json({ resumes: [] }) : json({ contacts: [sent], total: 1, page: 1, pageSize: 25 })));
    render(<ContactsView />);
    expect(await screen.findByText(/Attachment: General SWE/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /resume for/i })).toBeNull();
  });

  it("offers to schedule the selected batch only while it still has contacts waiting", async () => {
    const batch = (uploaded?: number) => ({ id: "b-1", name: "Spring", originalFilename: null, createdAt: "2030-01-01T00:00:00Z", contactCount: 3, statusCounts: uploaded ? { uploaded } : { scheduled: 3 } });
    for (const [uploaded, expected] of [[2, true], [0, false]] as const) {
      stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [batch(uploaded)] }) : c.url === "/api/resumes" ? json({ resumes: [] }) : json({ contacts: [row], total: 1, page: 1, pageSize: 25 })));
      const { unmount } = render(<ContactsView initialBatchId="b-1" />);
      await screen.findByText(/Batch “Spring”/);
      const link = screen.queryByRole("link", { name: "Schedule this batch" });
      expect(!!link).toBe(expected);
      if (link) expect(link).toHaveAttribute("href", "/batches/b-1");
      unmount();
    }
  });

  it("deletes one contact after confirming, never forcing on the first attempt", async () => {
    const seen = stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [] }) : c.method === "DELETE" ? json({ deleted: 1 }) : json({ contacts: [row], total: 1, page: 1, pageSize: 25 })));
    render(<ContactsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete jo@acme.com" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("Delete 1 contact?")).toBeInTheDocument();
    expect(within(dlg).getByText(/scheduled emails will be cancelled/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete 1 contact" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "DELETE")?.url).toBe("/api/contacts/c-1"));
    await vi.waitFor(() => expect(seen.filter((c) => c.url.startsWith("/api/contacts?")).length).toBeGreaterThan(1)); // list refreshed
  });

  it("asks again when the API says some were already emailed, and forces only after that", async () => {
    const deletes: string[] = [];
    stubFetch((c) => {
      if (c.url === "/api/batches") return json({ batches: [] });
      if (c.method === "DELETE") {
        deletes.push(c.url);
        return c.url.includes("force=true") ? json({ deleted: 1 }) : json({ error: "already emailed", code: "needs_force", protectedCount: 1 }, 409);
      }
      return json({ contacts: [row], total: 1, page: 1, pageSize: 25 });
    });
    render(<ContactsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete jo@acme.com" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete 1 contact" }));
    expect(await screen.findByText(/1 of these was already emailed \(sent or replied\)/)).toBeInTheDocument();
    expect(deletes).toEqual(["/api/contacts/c-1"]);
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await vi.waitFor(() => expect(deletes).toEqual(["/api/contacts/c-1", "/api/contacts/c-1?force=true"]));
  });

  it("offers Delete batch in a batch-filtered view and goes back to all batches", async () => {
    const batch = { id: "b-1", name: "Spring", originalFilename: null, createdAt: "2030-01-01T00:00:00Z", contactCount: 4, statusCounts: {} };
    const seen = stubFetch((c) => {
      if (c.url === "/api/batches") return json({ batches: [batch] });
      if (c.method === "DELETE") return json({ deleted: 4, batchId: "b-1" });
      return json({ contacts: [row], total: 1, page: 1, pageSize: 25 });
    });
    render(<ContactsView initialBatchId="b-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete batch" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText(/Delete batch “Spring”\?/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete batch" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "DELETE")?.url).toBe("/api/batches/b-1"));
    await vi.waitFor(() => expect(seen.some((c) => c.url === "/api/contacts?page=1&pageSize=25")).toBe(true));
    expect(window.location.pathname).toBe("/contacts");
  });

  it("shows the overdue banner on the Contacts page", async () => {
    stubFetch((c) => (c.url === "/api/messages/overdue" ? json({ count: 2, overdueMinutes: 60, messages: [] }) : c.url === "/api/batches" ? json({ batches: [] }) : c.url === "/api/settings/send-window" ? json({ enforced: true, window: { start: "09:00", end: "10:00", tz: "Asia/Kolkata" } }) : json({ contacts: [row], total: 1, page: 1, pageSize: 25 })));
    render(<ContactsView />);
    expect(await screen.findByText(/2 scheduled emails are past due/)).toBeInTheDocument();
  });
  describe("company filter and bulk follow-up", () => {
    const spring = { id: "b-1", name: "Spring", originalFilename: null, createdAt: "2030-01-01T00:00:00Z", contactCount: 4, statusCounts: {} };
    const fall = { id: "b-2", name: "Fall", originalFilename: null, createdAt: "2030-01-02T00:00:00Z", contactCount: 2, statusCounts: {} };
    const serve = (companies: (url: string) => { company: string; count: number }[], extra?: (c: { url: string; method: string }) => Response | null) =>
      stubFetch((c) => {
        const hit = extra?.(c);
        if (hit) return hit;
        if (c.url === "/api/batches") return json({ batches: [spring, fall] });
        if (c.url.startsWith("/api/companies")) return json({ companies: companies(c.url) });
        return json({ contacts: [row], total: 1, page: 1, pageSize: 25 });
      });
    const contactCalls = (seen: { url: string }[]) => seen.filter((c) => c.url.startsWith("/api/contacts")).map((c) => c.url);

    it("lists the batch's companies with counts next to the Batch select and filters by the picked one, back on page 1", async () => {
      const seen = serve(() => [
        { company: "Acme", count: 3 },
        { company: "Globex", count: 1 },
      ]);
      render(<ContactsView initialBatchId="b-1" />);
      const select = await screen.findByRole("combobox", { name: "Company" });
      await screen.findByRole("option", { name: "Acme (3)" });
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All companies", "Acme (3)", "Globex (1)"]);
      expect(seen.some((c) => c.url === "/api/companies?batchId=b-1")).toBe(true);
      await userEvent.selectOptions(select, "Acme");
      await vi.waitFor(() => expect(contactCalls(seen).at(-1)).toBe("/api/contacts?batchId=b-1&company=Acme&page=1&pageSize=25"));
    });

    it("refetches companies when the batch changes and drops a company the new batch does not have", async () => {
      const seen = serve((url) => (url.endsWith("b-2") ? [{ company: "Initech", count: 2 }] : [{ company: "Acme", count: 3 }]));
      render(<ContactsView initialBatchId="b-1" initialCompany="Acme" />);
      await screen.findByRole("option", { name: "Acme (3)" });
      expect(contactCalls(seen)[0]).toBe("/api/contacts?batchId=b-1&company=Acme&page=1&pageSize=25");
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Batch" }), "b-2");
      await screen.findByRole("option", { name: "Initech (2)" });
      expect(seen.some((c) => c.url === "/api/companies?batchId=b-2")).toBe(true);
      expect(screen.getByRole("combobox", { name: "Company" })).toHaveValue("");
      await vi.waitFor(() => expect(contactCalls(seen).at(-1)).toBe("/api/contacts?batchId=b-2&page=1&pageSize=25"));
    });

    it("offers the bulk follow-up bar only with a batch selected, scoped to the picked company, and reloads after applying", async () => {
      const seen = serve(
        () => [{ company: "Acme", count: 3 }],
        (c) => (c.method === "PUT" ? json({ updated: 3, skipped: 0, total: 3 }) : null),
      );
      render(<ContactsView initialBatchId="b-1" />);
      expect(await screen.findByText("Follow-up for all contacts in “Spring”")).toBeInTheDocument();
      await screen.findByRole("option", { name: "Acme (3)" });
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Company" }), "Acme");
      expect(await screen.findByText("Follow-up for all contacts at Acme in “Spring”")).toBeInTheDocument();
      const before = contactCalls(seen).length;
      await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
      expect(await screen.findByText("Updated 3 of 3")).toBeInTheDocument();
      expect(JSON.parse(String(seen.find((c) => c.method === "PUT")!.body))).toMatchObject({ batchId: "b-1", company: "Acme", enabled: true });
      await vi.waitFor(() => expect(contactCalls(seen).length).toBeGreaterThan(before));
    });

    it("hides the bulk bar when no batch is selected", async () => {
      serve(() => [{ company: "Acme", count: 3 }]);
      render(<ContactsView />);
      await screen.findByRole("option", { name: "Acme (3)" });
      expect(screen.queryByRole("button", { name: "Schedule follow-up" })).toBeNull();
    });
  });
});
