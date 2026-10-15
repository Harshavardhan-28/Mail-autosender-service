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
  repliedAt: null,
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  messages: [{ id: "m-1", kind: "initial", state: "scheduled", scheduledFor: "2030-02-01T09:00:00Z", sentAt: null }],
};

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("ContactsView", () => {
  it("filters by the batch from the URL and cancels a scheduled send by message id", async () => {
    let releaseReload = false;
    const seen = stubFetch((c) => {
      if (c.url === "/api/batches") return json({ batches: [] });
      if (c.method === "DELETE") {
        releaseReload = true;
        return json({ message: {}, contact: {} });
      }
      // the reload after cancel never resolves: the button must already be gone
      if (releaseReload) return new Promise<Response>(() => {});
      return json({ contacts: [row], total: 1, page: 1, pageSize: 25 });
    });
    render(<ContactsView initialBatchId="b-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for jo@acme.com" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Cancel send" }));
    await vi.waitFor(() => expect(seen.some((c) => c.method === "DELETE")).toBe(true));
    expect(seen.find((c) => c.url.startsWith("/api/contacts"))!.url).toBe("/api/contacts?batchId=b-1&page=1&pageSize=25");
    expect(seen.find((c) => c.method === "DELETE")!.url).toBe("/api/messages/m-1");
    await userEvent.click(screen.getByRole("button", { name: "Actions for jo@acme.com" }));
    expect(screen.queryByRole("menuitem", { name: "Cancel send" })).toBeNull();
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

  it("lets the operator settle a needs_review message, asking first, via the resolve endpoint", async () => {
    const stuck: ContactListItem = { ...row, messages: [{ id: "m-9", kind: "initial", state: "needs_review", scheduledFor: "2030-02-01T09:00:00Z", sentAt: null }] };
    const seen = stubFetch((c) =>
      c.url === "/api/batches" ? json({ batches: [] }) : c.method === "POST" ? json({ message: {}, contact: {} }) : json({ contacts: [stuck], total: 1, page: 1, pageSize: 25 }),
    );
    render(<ContactsView />);
    await userEvent.click(await screen.findByRole("button", { name: /delivery unknown\. resolve/i }));
    await userEvent.click(await screen.findByRole("button", { name: /send again/i }));
    expect(screen.getByText(/duplicate/i)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Send again" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "POST")?.url).toBe("/api/messages/m-9/resolve"));
    expect(JSON.parse(seen.find((c) => c.method === "POST")!.body as string)).toEqual({ action: "requeue" });
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
});
