import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { json, stubFetch } from "@/test/fetch";
import { BatchView } from "./BatchView";
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
});
