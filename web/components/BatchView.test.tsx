import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { BatchView } from "./BatchView";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));
import { resetApiState } from "@/lib/api";
import type { ContactWithPreview } from "@/lib/types";

const contact = (id: string, status: ContactWithPreview["status"]): ContactWithPreview => ({
  id,
  batchId: "b-1",
  company: "Acme",
  role: "SWE",
  person: `Person ${id}`,
  email: `${id}@acme.com`,
  subject: "s",
  mailText: "m",
  followupText: null,
  status,
  followupRequested: false,
  followupDelayDays: 7,
  followupAt: null,
  repliedAt: null,
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  preview: { subject: `Hello ${id}`, text: "body" },
});

const serve = (contacts: ContactWithPreview[]) =>
  stubFetch((c) => {
    if (c.url === "/api/batches/b-1") return json({ batch: { id: "b-1", name: "Spring", originalFilename: null, createdAt: "2030-01-01T00:00:00Z" }, contacts });
    if (c.url === "/api/resumes") return json({ resumes: [] });
    if (c.url === "/api/settings/send-window") return json({ enforced: false });
    return json({});
  });

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("BatchView", () => {
  it("shows the batch preview table with only waiting contacts selectable", async () => {
    serve([contact("a", "uploaded"), contact("b", "scheduled")]);
    render(<BatchView id="b-1" />);
    expect(await screen.findByRole("heading", { name: "Spring" })).toBeInTheDocument();
    expect(screen.getByText(/1 waiting to be scheduled/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select a@acme.com" })).toBeChecked();
    const done = screen.getByRole("checkbox", { name: "Select b@acme.com" });
    expect(done).toBeDisabled();
    expect(done).not.toBeChecked();
    expect(screen.queryByRole("navigation", { name: "Progress" })).toBeNull();
    expect(screen.getByRole("link", { name: /contacts/i })).toHaveAttribute("href", "/contacts?batchId=b-1");
  });

  it("explains a batch that cannot be loaded", async () => {
    stubFetch((c) => (c.url === "/api/batches/b-1" ? json({ error: "Batch not found" }, 404) : json({})));
    render(<BatchView id="b-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Batch not found");
  });

  it("deletes the whole batch after confirming, then goes to Contacts", async () => {
    push.mockClear();
    const seen = stubFetch((c) => {
      if (c.method === "DELETE") return json({ deleted: 2, batchId: "b-1" });
      if (c.url === "/api/batches/b-1") return json({ batch: { id: "b-1", name: "Spring", originalFilename: null, createdAt: "2030-01-01T00:00:00Z" }, contacts: [contact("a", "uploaded"), contact("b", "uploaded")] });
      if (c.url === "/api/resumes") return json({ resumes: [] });
      return json({ enforced: false });
    });
    render(<BatchView id="b-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete batch" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText(/Delete batch “Spring”\?/)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete batch" }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/contacts"));
    expect(seen.find((c) => c.method === "DELETE")!.url).toBe("/api/batches/b-1");
  });
  it("offers the bulk follow-up for the whole batch and refreshes the rows' follow-up dates after applying", async () => {
    let fu: string | null = null;
    const seen = stubFetch((c) => {
      if (c.method === "PUT" && c.url === "/api/followups/bulk") {
        fu = "2030-03-05T03:30:00.000Z"; // 09:00 IST
        return json({ updated: 1, skipped: 0, total: 1 });
      }
      if (c.url === "/api/batches/b-1")
        return json({ batch: { id: "b-1", name: "Spring", originalFilename: null, createdAt: "2030-01-01T00:00:00Z" }, contacts: [{ ...contact("a", "uploaded"), followupRequested: fu !== null, followupAt: fu }] });
      if (c.url === "/api/resumes") return json({ resumes: [] });
      return json({ enforced: false });
    });
    render(<BatchView id="b-1" />);
    expect(await screen.findByText("Follow-up for all contacts in “Spring”")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(await screen.findByText("Updated 1 of 1")).toBeInTheDocument();
    expect(JSON.parse(String(seen.find((c) => c.method === "PUT")!.body))).toMatchObject({ batchId: "b-1", enabled: true });
    await vi.waitFor(() => expect(screen.getByLabelText(/follow-up date for a@acme.com/i)).toHaveValue("2030-03-05"));
    expect(screen.getByRole("switch", { name: /follow up with a@acme.com/i })).toBeChecked();
  });
});
