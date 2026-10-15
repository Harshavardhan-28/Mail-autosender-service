import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/mail/m-1" }));

import { MailDetailView } from "./MailDetailView";
import { resetApiState } from "@/lib/api";
import type { MailDetail } from "@/lib/types";

const detail = (over: Partial<MailDetail> = {}): MailDetail => ({
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
  contact: { id: "c-1", person: "Jo Smith", company: "Acme", role: "SWE Intern", email: "jo@acme.com", status: "sent", repliedAt: null },
  batch: { id: "b-1", name: "Spring" },
  body: "Hi Jo,\n\nHello there.",
  attachment: { id: "r-1", displayName: "General SWE", source: "scheduled" },
  messageId: "<abc@mail.example>",
  threadedWith: null,
  related: null,
  timeline: [
    { type: "scheduled", at: "2030-01-01T08:00:00Z", meta: { scheduledFor: "2030-01-01T09:00:00Z" } },
    { type: "sent", at: "2030-01-01T09:12:00Z", meta: { kind: "initial" } },
    { type: "replied", at: "2030-01-02T10:00:00Z", meta: {} },
  ],
  ...over,
});

beforeEach(() => {
  resetApiState();
  push.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("MailDetailView", () => {
  it("shows the subject, summary, rendered body and timeline, with a back link keeping the list query", async () => {
    stubFetch(() => json({ mail: detail() }));
    render(<MailDetailView id="m-1" backQuery="tab=sent&q=acme&page=2" />);
    expect(await screen.findByRole("heading", { level: 1, name: "SWE role at Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All mail/ })).toHaveAttribute("href", "/mail?tab=sent&q=acme&page=2");
    const details = screen.getByRole("region", { name: "Details" });
    expect(within(details).getByText("jo@acme.com")).toBeInTheDocument();
    expect(within(details).getByText("SWE Intern")).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "Spring" })).toHaveAttribute("href", "/contacts?batchId=b-1");
    expect(within(details).getByText("<abc@mail.example>")).toBeInTheDocument();
    expect(within(details).getByText("General SWE")).toBeInTheDocument();
    const letter = screen.getByRole("article", { name: "Email" });
    expect(within(letter).getByText(/Hello there\./)).toBeInTheDocument();
    const items = within(screen.getByRole("list", { name: "Timeline" })).getAllByRole("listitem");
    expect(items.map((i) => i.querySelector("div")?.textContent)).toEqual(["Scheduled", "Sent", "Reply received"]);
    expect(screen.getByRole("link", { name: "Open contact" })).toHaveAttribute("href", "/contacts?batchId=b-1&q=jo%40acme.com");
    expect(screen.queryByRole("button", { name: "Cancel send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("links a follow-up to its initial mail", async () => {
    stubFetch(() => json({ mail: detail({ kind: "followup", threadedWith: "m-0", related: { id: "m-0", kind: "initial", state: "sent" } }) }));
    render(<MailDetailView id="m-1" backQuery="tab=scheduled" />);
    const link = await screen.findByRole("link", { name: "View the first email" });
    expect(link).toHaveAttribute("href", `/mail/m-0?from=${encodeURIComponent("tab=scheduled")}`);
  });

  it("cancels a scheduled send only after confirming, then returns to the list", async () => {
    const seen = stubFetch((c) => (c.method === "DELETE" ? json({ message: {}, contact: {} }) : json({ mail: detail({ state: "scheduled", sentAt: null, timeline: [] }) })));
    render(<MailDetailView id="m-1" backQuery="tab=scheduled" />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(dlg).getByRole("button", { name: "Cancel send" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "DELETE")?.url).toBe("/api/messages/m-1"));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/mail?tab=scheduled"));
  });

  it("resolves a needs_review mail through the existing endpoint, asking first", async () => {
    const seen = stubFetch((c) => (c.method === "POST" ? json({ message: {}, contact: {} }) : json({ mail: detail({ state: "needs_review", sentAt: null }) })));
    render(<MailDetailView id="m-1" />);
    expect(await screen.findByText("Delivery unknown")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await userEvent.click(await screen.findByRole("button", { name: /send again/i }));
    expect(screen.getByText(/duplicate/i)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Send again" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "POST")?.url).toBe("/api/messages/m-1/resolve"));
    expect(JSON.parse(seen.find((c) => c.method === "POST")!.body as string)).toEqual({ action: "requeue" });
    await vi.waitFor(() => expect(seen.filter((c) => c.url === "/api/mails/m-1").length).toBe(2)); // reloaded
  });

  it("warns about an overdue mail and shows the send error", async () => {
    stubFetch(() => json({ mail: detail({ state: "scheduled", sentAt: null, overdue: true, error: "SMTP timeout", attempts: 3 }) }));
    render(<MailDetailView id="m-1" />);
    expect(await screen.findByText("Overdue", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("SMTP timeout")).toBeInTheDocument();
  });

  it("explains a missing mail and links back, without a retry", async () => {
    stubFetch(() => json({ error: "Mail not found" }, 404));
    render(<MailDetailView id="gone" backQuery="tab=sent" />);
    expect(await screen.findByText("This mail no longer exists")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All mail/ })).toHaveAttribute("href", "/mail?tab=sent");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers Retry when loading fails for another reason", async () => {
    let fail = true;
    stubFetch(() => (fail ? json({ error: "Internal server error" }, 500) : json({ mail: detail() })));
    render(<MailDetailView id="m-1" />);
    expect(await screen.findByText("Could not load this mail")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "SWE role at Acme" })).toBeInTheDocument();
  });
});
