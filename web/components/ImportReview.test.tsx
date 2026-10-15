import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportReview } from "./ImportReview";
import type { ImportRow, PreviewResult } from "@/lib/types";

const row = (n: number, over: Partial<ImportRow> = {}): ImportRow => ({
  row: n,
  company: `Co ${n}`,
  role: "SWE",
  person: `Person ${n}`,
  email: `p${n}@x.com`,
  subject: `Subject ${n}`,
  mailText: `Body ${n}`,
  followupText: null,
  ...over,
});

const preview = (over: Partial<PreviewResult> = {}): PreviewResult => ({
  filename: "leads.csv",
  suggestedName: "leads",
  rows: [row(2), row(3), row(4)],
  errors: [],
  conflicts: [],
  ...over,
});

function setup(p = preview(), extra: { saving?: boolean; error?: React.ReactNode } = {}) {
  const onSave = vi.fn();
  const onBack = vi.fn();
  render(<ImportReview preview={p} saving={extra.saving ?? false} error={extra.error} onBack={onBack} onSave={onSave} />);
  return { onSave, onBack };
}
const save = () => screen.getByRole("button", { name: "Save to database" });

describe("ImportReview", () => {
  it("prefills the batch name, says nothing is saved, and counts rows", () => {
    setup();
    expect(screen.getByLabelText("Batch name")).toHaveValue("leads");
    expect(screen.getByText("Nothing is saved yet. Review and edit, then save to the database.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 rows ready, 0 with problems, 0 duplicates");
    expect(save()).toBeEnabled();
  });

  it("saves edited cells, the follow-up (blank becomes null) and the batch name", async () => {
    const { onSave } = setup();
    await userEvent.clear(screen.getByLabelText("Company for row 2"));
    await userEvent.type(screen.getByLabelText("Company for row 2"), "Initech");
    await userEvent.type(screen.getByLabelText("Follow-up Text for row 3"), "Ping");
    await userEvent.clear(screen.getByLabelText("Batch name"));
    await userEvent.type(screen.getByLabelText("Batch name"), "  October  ");
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith({
      name: "October",
      rows: [row(2, { company: "Initech" }), row(3, { followupText: "Ping" }), row(4)],
    });
  });

  it("edits the mail text in an expandable textarea", async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Edit mail text for row 3" }));
    const area = screen.getByLabelText("Mail Text for row 3");
    expect(area).toHaveValue("Body 3");
    await userEvent.clear(area);
    await userEvent.type(area, "New body");
    expect(screen.getByRole("button", { name: "Hide mail text for row 3" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0].rows[1].mailText).toBe("New body");
  });

  it("outlines an invalid cell, explains it, updates the counters and disables save", async () => {
    setup();
    const email = screen.getByLabelText("Email for row 3");
    await userEvent.clear(email);
    await userEvent.type(email, "nope");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Email is not a valid address");
    expect(screen.getByRole("status")).toHaveTextContent("2 rows ready, 1 with problems, 0 duplicates");
    expect(save()).toBeDisabled();
    await userEvent.clear(email);
    await userEvent.type(email, "ok@x.com");
    expect(email).not.toHaveAttribute("aria-invalid");
    expect(save()).toBeEnabled();
  });

  it("flags a duplicate email created by an edit", async () => {
    setup();
    const email = screen.getByLabelText("Email for row 3");
    await userEvent.clear(email);
    await userEvent.type(email, "P2@x.com");
    expect(email).toHaveAccessibleDescription("Duplicate email in this list");
    expect(save()).toBeDisabled();
  });

  it("removes a row; with none left saving is disabled", async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Remove row 3" }));
    expect(screen.queryByLabelText("Company for row 3")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 rows ready");
    await userEvent.click(save());
    expect(onSave.mock.calls[0]![0].rows.map((r: ImportRow) => r.row)).toEqual([2, 4]);
    await userEvent.click(screen.getByRole("button", { name: "Remove row 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove row 4" }));
    expect(screen.getByText("No rows left to import.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("badges rows whose email already exists and counts them, until the email is changed", async () => {
    setup(
      preview({
        conflicts: [{ row: 3, email: "p3@x.com", replaceable: true, matches: [{ contactId: "c1", batchId: "b1", batchName: "Spring", status: "sent", company: "O", role: "R", person: "P", subject: "S" }] }],
      }),
    );
    expect(screen.getByText("Already in Spring (Sent)")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 rows ready, 0 with problems, 1 duplicate");
    const email = screen.getByLabelText("Email for row 3");
    await userEvent.clear(email);
    await userEvent.type(email, "fresh@x.com");
    expect(screen.queryByText(/Already in Spring/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 duplicates");
  });

  it("lists the rows the file check rejected", async () => {
    setup(preview({ errors: [{ row: 5, message: "Email is not a valid address" }] }));
    expect(screen.getByText(/1 row in the file was rejected/)).toBeInTheDocument();
    const details = screen.getByText("Show rejected rows").closest("details")!;
    expect(within(details).getByText("Row 5")).toBeInTheDocument();
  });

  it("Back returns without saving", async () => {
    const { onBack, onSave } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("disables everything while saving and shows a save error", () => {
    setup(preview(), { saving: true, error: <p>Boom</p> });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });
});
