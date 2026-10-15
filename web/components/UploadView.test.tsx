import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch, type Seen } from "@/test/fetch";
import { resetApiState } from "@/lib/api";
import { UploadView } from "./UploadView";
import type { ImportConflict, ImportRow, UploadedContact } from "@/lib/types";

const row = (n: number, email: string): ImportRow => ({ row: n, company: `Co ${n}`, role: "SWE", person: `Person ${n}`, email, subject: `Subject ${n}`, mailText: `Body ${n}`, followupText: null });
const conflict = (n: number, email: string, replaceable = true): ImportConflict => ({
  row: n,
  email,
  replaceable,
  matches: [{ contactId: `old${n}`, batchId: "b0", batchName: "Spring", status: replaceable ? "uploaded" : "sent", company: "Old Co", role: "PM", person: "Old Person", subject: "Old subject" }],
});

const contact = (id: string, r: ImportRow): UploadedContact => ({
  row: r.row, id, batchId: "b-1", company: r.company, role: r.role, person: r.person, email: r.email, subject: r.subject, mailText: r.mailText, followupText: null,
  status: "uploaded", followupRequested: false, followupDelayDays: 7, repliedAt: null, error: null, createdAt: "2030-01-01T00:00:00Z", preview: { subject: r.subject, text: r.mailText },
});

const batch = { id: "b-1", name: "Leads", originalFilename: "leads.csv", createdAt: "2030-01-01T00:00:00Z" };

type Handlers = { preview?: () => Response; commit?: (body: Record<string, unknown>) => Response };
function stub(h: Handlers) {
  return stubFetch((c) => {
    if (c.url === "/api/resumes") return json({ resumes: [] });
    if (c.url === "/api/settings/send-window") return json({});
    if (c.url === "/api/batches/preview") return h.preview!();
    if (c.url === "/api/batches/commit") return h.commit!(JSON.parse(c.body as string));
    return json({});
  });
}
const calls = (seen: Seen[], url: string) => seen.filter((c) => c.url === url);

async function chooseFile() {
  const file = new File(["Company,Role\n"], "leads.csv", { type: "text/csv" });
  await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
}

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("UploadView", () => {
  it("offers the CSV template and a Preview button instead of uploading", () => {
    stub({});
    render(<UploadView />);
    expect(screen.getByRole("link", { name: /download csv template/i })).toHaveAttribute("href", "/contacts-template.csv");
    expect(screen.getByText(/Columns: Company, Role, Person, Email, Subject, Mail Text/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
  });

  it("previews without saving, Back returns to file selection", async () => {
    const seen = stub({ preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows: [row(2, "a@x.com")], errors: [], conflicts: [] }) });
    render(<UploadView />);
    await chooseFile();
    expect(await screen.findByLabelText("Company for row 2")).toBeInTheDocument();
    expect(calls(seen, "/api/batches")).toHaveLength(0);
    expect(calls(seen, "/api/batches/commit")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(calls(seen, "/api/batches/commit")).toHaveLength(0);
  });

  it("shows the server's reason when the file cannot be previewed", async () => {
    stub({ preview: () => json({ error: "No valid rows to import", errors: [{ row: 2, message: "Email is not a valid address" }] }, 422) });
    render(<UploadView />);
    await chooseFile();
    expect(await screen.findByText("No valid rows to import")).toBeInTheDocument();
    expect(screen.getByText("Row 2")).toBeInTheDocument();
  });

  it("saves edited rows straight away when there are no duplicates, then shows the scheduler", async () => {
    const rows = [row(2, "a@x.com"), row(3, "b@x.com")];
    let sent: Record<string, unknown> | null = null;
    stub({
      preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows, errors: [], conflicts: [] }),
      commit: (b) => {
        sent = b;
        return json({ batch, contacts: [contact("c1", rows[0]!)], errors: [], warnings: [], skipped: 0, replaced: 0 }, 201);
      },
    });
    render(<UploadView />);
    await chooseFile();
    await userEvent.type(await screen.findByLabelText("Follow-up Text for row 3"), "Ping");
    await userEvent.click(screen.getByRole("button", { name: "Save to database" }));
    expect(await screen.findByText("Batch uploaded")).toBeInTheDocument();
    expect(sent).toEqual({ name: "leads", filename: "leads.csv", rows: [rows[0], { ...rows[1], followupText: "Ping" }], resolutions: {} });
    expect(screen.getByText(/1 contact imported\. Nothing is scheduled/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /schedule \d+ email/i })).toBeInTheDocument();
  });

  it("uses the batch name typed on the file step as the review name and saves it", async () => {
    const rows = [row(2, "a@x.com")];
    let sent: Record<string, unknown> | null = null;
    stub({
      preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows, errors: [], conflicts: [] }),
      commit: (b) => {
        sent = b;
        return json({ batch, contacts: [contact("c1", rows[0]!)], errors: [], warnings: [], skipped: 0, replaced: 0 }, 201);
      },
    });
    render(<UploadView />);
    await userEvent.type(screen.getByLabelText("Batch name (optional)"), "  October wave  ");
    await chooseFile();
    expect(await screen.findByLabelText("Batch name")).toHaveValue("October wave");
    await userEvent.click(screen.getByRole("button", { name: "Save to database" }));
    expect(await screen.findByText("Batch uploaded")).toBeInTheDocument();
    expect(sent).toMatchObject({ name: "October wave" });
  });

  it("asks about known duplicates, commits the edited rows with the decisions, and reports skipped/replaced", async () => {
    const rows = [row(2, "a@x.com"), row(3, "B@x.com"), row(4, "c@x.com")];
    let sent: Record<string, unknown> | null = null;
    const seen = stub({
      preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows, errors: [], conflicts: [conflict(2, "a@x.com"), conflict(3, "B@x.com")] }),
      commit: (b) => {
        sent = b;
        return json({ batch, contacts: [contact("c1", rows[2]!)], errors: [], warnings: [], skipped: 1, replaced: 1 }, 201);
      },
    });
    render(<UploadView />);
    await chooseFile();
    expect(await screen.findByRole("status")).toHaveTextContent("3 rows ready, 0 with problems, 2 duplicates");
    await userEvent.clear(screen.getByLabelText("Subject for row 4"));
    await userEvent.type(screen.getByLabelText("Subject for row 4"), "Edited");
    await userEvent.click(screen.getByRole("button", { name: "Save to database" }));

    const dlg = await screen.findByRole("alertdialog");
    expect(calls(seen, "/api/batches/commit")).toHaveLength(0);
    expect(within(dlg).getByText("a@x.com")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("B@x.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));

    expect(await screen.findByText("Batch uploaded")).toBeInTheDocument();
    expect(sent).toEqual({
      name: "leads",
      filename: "leads.csv",
      rows: [rows[0], rows[1], { ...rows[2], subject: "Edited" }],
      resolutions: { "a@x.com": "skip", "b@x.com": "replace" },
    });
    expect(screen.getByText(/1 skipped, 1 replaced/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /schedule \d+ email/i })).toBeInTheDocument();
  });

  it("Cancel in the dialog writes nothing and keeps the edits", async () => {
    const seen = stub({ preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows: [row(2, "a@x.com")], errors: [], conflicts: [conflict(2, "a@x.com")] }) });
    render(<UploadView />);
    await chooseFile();
    await userEvent.type(await screen.findByLabelText("Follow-up Text for row 2"), "kept");
    await userEvent.click(screen.getByRole("button", { name: "Save to database" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls(seen, "/api/batches/commit")).toHaveLength(0);
    expect(screen.getByLabelText("Follow-up Text for row 2")).toHaveValue("kept");
  });

  it("loops the dialog when the server finds a duplicate created by an edit, keeping earlier decisions", async () => {
    const rows = [row(2, "a@x.com"), row(3, "b@x.com")];
    const bodies: Record<string, unknown>[] = [];
    stub({
      preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows, errors: [], conflicts: [conflict(2, "a@x.com")] }),
      commit: (b) => {
        bodies.push(b);
        if (bodies.length === 1) return json({ error: "Duplicate emails need a decision", code: "needs_resolution", conflicts: [conflict(3, "b@x.com")] }, 409);
        return json({ batch, contacts: [contact("c1", rows[0]!)], errors: [], warnings: [], skipped: 1, replaced: 0 }, 201);
      },
    });
    render(<UploadView />);
    await chooseFile();
    await userEvent.click(await screen.findByRole("button", { name: "Save to database" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep both" }));
    expect(await screen.findByText("b@x.com", { selector: "p" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Batch uploaded")).toBeInTheDocument();
    expect(bodies.map((b) => b.resolutions)).toEqual([{ "a@x.com": "keep" }, { "a@x.com": "keep", "b@x.com": "skip" }]);
  });

  it("shows save errors in a notice and keeps the edits", async () => {
    stub({
      preview: () => json({ filename: "leads.csv", suggestedName: "leads", rows: [row(2, "a@x.com")], errors: [], conflicts: [] }),
      commit: () => json({ error: "Some rows are invalid", errors: [{ row: 2, message: "Email is on the suppression list" }] }, 422),
    });
    render(<UploadView />);
    await chooseFile();
    await userEvent.type(await screen.findByLabelText("Follow-up Text for row 2"), "kept");
    await userEvent.click(screen.getByRole("button", { name: "Save to database" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Some rows are invalid")).toBeInTheDocument();
    expect(within(alert).getByText("Email is on the suppression list")).toBeInTheDocument();
    expect(screen.getByLabelText("Follow-up Text for row 2")).toHaveValue("kept");
    expect(screen.getByRole("button", { name: "Save to database" })).toBeEnabled();
  });
});
