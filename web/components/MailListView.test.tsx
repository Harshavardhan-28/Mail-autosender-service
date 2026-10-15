import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { MailListView } from "./MailListView";
import { resetApiState } from "@/lib/api";
import type { MailRow, MailsPage } from "@/lib/types";

const contact = { id: "c-1", person: "Jo Smith", company: "Acme", role: "SWE", email: "jo@acme.com", status: "sent" as const, repliedAt: null };
const mail = (over: Partial<MailRow> = {}): MailRow => ({
  id: "m-1",
  kind: "initial",
  state: "sent",
  subject: "SWE role at Acme",
  scheduledFor: "2030-01-01T09:00:00Z",
  sentAt: "2030-01-01T09:12:00Z",
  attempts: 1,
  error: null,
  dryRun: false,
  overdue: false,
  contact,
  batch: { id: "b-1", name: "Spring" },
  ...over,
});
const page = (mails: MailRow[], counts = { sent: 1, scheduled: 0, attention: 0 }, total = mails.length): MailsPage => ({ mails, total, page: 1, pageSize: 25, counts });
const quiet = (c: { url: string }) => (c.url === "/api/messages/overdue" ? json({ count: 0, overdueMinutes: 60, messages: [] }) : null);

beforeEach(() => {
  resetApiState();
  window.history.replaceState(null, "", "/mail");
});
afterEach(() => vi.unstubAllGlobals());

const mailCalls = (seen: { url: string }[]) => seen.filter((c) => c.url.startsWith("/api/mails")).map((c) => c.url);

describe("MailListView", () => {
  it("opens on Scheduled when something is scheduled, with live counts on every tab", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json(page([mail({ state: "scheduled", sentAt: null })], { sent: 4, scheduled: 1, attention: 2 })));
    render(<MailListView />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Scheduled1", "Sent4", "Needs attention2"]);
    expect(screen.getByRole("tab", { name: /Scheduled/ })).toHaveAttribute("aria-selected", "true");
    expect(mailCalls(seen)[0]).toBe("/api/mails?state=scheduled&page=1&pageSize=25");
  });

  it("falls back to Sent when nothing is scheduled", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json(page([mail()], { sent: 3, scheduled: 0, attention: 0 })));
    render(<MailListView />);
    await vi.waitFor(() => expect(screen.getByRole("tab", { name: /Sent/ })).toHaveAttribute("aria-selected", "true"));
    expect(mailCalls(seen)).toEqual(["/api/mails?state=scheduled&page=1&pageSize=25", "/api/mails?state=sent&page=1&pageSize=25"]);
    await screen.findByText("SWE role at Acme");
  });

  it("does not auto-switch when the URL names a tab, and only emphasises Needs attention when it has items", async () => {
    stubFetch((c) => quiet(c) ?? json(page([], { sent: 3, scheduled: 0, attention: 0 })));
    render(<MailListView initialTab="scheduled" />);
    expect(await screen.findByText("Nothing is scheduled to go out.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Scheduled/ })).toHaveAttribute("aria-selected", "true");
    const counts = screen.getAllByText("0", { selector: "[data-slot=tab-count]" });
    expect(counts.length).toBeGreaterThan(0);
    for (const el of counts) expect(el.className).not.toMatch(/st-amber/);
  });

  it("renders each mail as one link to its detail, carrying the list query, with chips and times", async () => {
    stubFetch((c) =>
      quiet(c) ??
      json(
        page(
          [
            mail({ id: "m-a", kind: "followup", subject: "Re: SWE role", contact: { ...contact, status: "replied" }, dryRun: true }),
            mail({ id: "m-b", state: "scheduled", sentAt: null, overdue: true, scheduledFor: "2020-01-01T09:00:00Z" }),
          ],
          { sent: 2, scheduled: 0, attention: 0 },
        ),
      ),
    );
    render(<MailListView initialTab="sent" initialQ="acme" />);
    const first = await screen.findByRole("link", { name: /Re: SWE role/ });
    expect(first).toHaveAttribute("href", `/mail/m-a?from=${encodeURIComponent("tab=sent&q=acme")}`);
    expect(within(first).getByText("Jo Smith")).toBeInTheDocument();
    expect(within(first).getByText("jo@acme.com")).toBeInTheDocument();
    expect(within(first).getByText("Follow-up")).toBeInTheDocument();
    expect(within(first).getByText("Replied")).toBeInTheDocument();
    expect(within(first).getByText("Dry run")).toBeInTheDocument();
    expect(within(first).getByText(/^Sent/)).toBeInTheDocument();
    const second = screen.getAllByRole("link")[1]!;
    expect(within(second).getByText("Overdue")).toBeInTheDocument();
    expect(within(second).getByText(/^Scheduled for/)).toBeInTheDocument();
  });

  it("switches tab, resets paging and keeps the URL in step", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json(page([mail({ state: "needs_review", error: "boom" })], { sent: 1, scheduled: 1, attention: 1 })));
    render(<MailListView initialTab="scheduled" initialPage={2} />);
    await screen.findAllByRole("tab");
    await userEvent.click(screen.getByRole("tab", { name: /Needs attention/ }));
    await vi.waitFor(() => expect(mailCalls(seen).at(-1)).toBe("/api/mails?state=attention&page=1&pageSize=25"));
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(window.location.search).toBe("?tab=attention"));
  });

  it("searches (debounced) and filters by type", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json(page([mail()])));
    render(<MailListView initialTab="sent" />);
    await screen.findByText("SWE role at Acme");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "acme");
    await vi.waitFor(() => expect(mailCalls(seen).at(-1)).toBe("/api/mails?state=sent&q=acme&page=1&pageSize=25"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Type" }), "followup");
    await vi.waitFor(() => expect(mailCalls(seen).at(-1)).toBe("/api/mails?state=sent&kind=followup&q=acme&page=1&pageSize=25"));
    expect(window.location.search).toBe("?tab=sent&q=acme&kind=followup");
  });

  it("restores search, type and page from the URL values", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json({ ...page([mail()], { sent: 60, scheduled: 0, attention: 0 }, 60), page: 2 }));
    render(<MailListView initialTab="sent" initialQ="acme" initialKind="followup" initialPage={2} />);
    await screen.findByText("SWE role at Acme");
    expect(mailCalls(seen)[0]).toBe("/api/mails?state=sent&kind=followup&q=acme&page=2&pageSize=25");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("acme");
    expect(screen.getByText("26–50 of 60 mails")).toBeInTheDocument();
  });

  it("pages forward and back", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json(page([mail()], { sent: 60, scheduled: 0, attention: 0 }, 60)));
    render(<MailListView initialTab="sent" />);
    await screen.findByText("SWE role at Acme");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await vi.waitFor(() => expect(mailCalls(seen).at(-1)).toBe("/api/mails?state=sent&page=2&pageSize=25"));
  });

  it("shows a per-tab empty state with an Upload a CSV call to action, and none for Needs attention", async () => {
    stubFetch((c) => quiet(c) ?? json(page([], { sent: 0, scheduled: 0, attention: 0 })));
    const { unmount } = render(<MailListView initialTab="sent" />);
    expect(await screen.findByText("Nothing has been sent yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload a CSV" })).toHaveAttribute("href", "/upload");
    unmount();
    render(<MailListView initialTab="attention" />);
    expect(await screen.findByText("Nothing needs your attention.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Upload a CSV" })).toBeNull();
  });

  it("offers to clear filters when a search finds nothing", async () => {
    const seen = stubFetch((c) => quiet(c) ?? json(page([], { sent: 5, scheduled: 0, attention: 0 })));
    render(<MailListView initialTab="sent" initialQ="zzz" />);
    expect(await screen.findByText("No mail matches these filters.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await vi.waitFor(() => expect(mailCalls(seen).at(-1)).toBe("/api/mails?state=sent&page=1&pageSize=25"));
  });

  it("shows skeletons while loading, then an error with Retry", async () => {
    let fail = true;
    const seen = stubFetch((c) => quiet(c) ?? (fail ? json({ error: "Internal server error" }, 500) : json(page([mail()]))));
    render(<MailListView initialTab="sent" />);
    expect(screen.getByLabelText("Loading mail")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("SWE role at Acme")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mailCalls(seen).length).toBe(2);
  });
});
