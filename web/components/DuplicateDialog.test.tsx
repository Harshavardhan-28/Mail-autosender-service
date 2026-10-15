import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DuplicateDialog } from "./DuplicateDialog";
import type { ContactStatus, ImportConflict, ImportRow } from "@/lib/types";

const newRow = (n: number, email: string): ImportRow => ({ row: n, company: `New Co ${n}`, role: "PM", person: `New Person ${n}`, email, subject: `New subject ${n}`, mailText: "x", followupText: null });
const conflict = (n: number, email: string, status: ContactStatus = "uploaded"): ImportConflict => ({
  row: n,
  email,
  replaceable: status === "uploaded" || status === "scheduled",
  matches: [{ contactId: `c${n}`, batchId: "b", batchName: "Old batch", status, company: `Old Co ${n}`, role: "SWE", person: `Old Person ${n}`, subject: `Old subject ${n}` }],
});

const emails = ["a@x.com", "B@x.com", "c@x.com"];
const rows = emails.map((e, i) => newRow(i + 2, e));

function setup(conflicts: ImportConflict[]) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<DuplicateDialog conflicts={conflicts} rows={rows} onDone={onDone} onCancel={onCancel} />);
  return { onDone, onCancel };
}
const click = (name: string | RegExp) => userEvent.click(screen.getByRole("button", { name }));

describe("DuplicateDialog", () => {
  it("shows the existing entry next to the new row", async () => {
    setup([conflict(2, "a@x.com", "sent")]);
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("a@x.com")).toBeInTheDocument();
    const existing = within(dlg).getByRole("region", { name: /existing entry in old batch/i });
    expect(within(existing).getByText("Old subject 2")).toBeInTheDocument();
    expect(within(existing).getByText("Old Person 2")).toBeInTheDocument();
    expect(within(existing).getByText("Sent")).toBeInTheDocument();
    const fresh = within(dlg).getByRole("region", { name: "New row" });
    expect(within(fresh).getByText("New subject 2")).toBeInTheDocument();
  });

  it.each([
    ["Skip", "skip"],
    ["Replace", "replace"],
    ["Keep both", "keep"],
  ])("%s resolves a single duplicate, keyed by lowercased email", async (label, action) => {
    const { onDone } = setup([conflict(3, "B@x.com")]);
    await screen.findByRole("alertdialog");
    await click(label);
    expect(onDone).toHaveBeenCalledWith({ "b@x.com": action });
  });

  it("asks one by one and reports once all are decided", async () => {
    const { onDone } = setup([conflict(2, "a@x.com"), conflict(3, "B@x.com")]);
    await screen.findByText("1 of 2");
    await click("Skip");
    expect(onDone).not.toHaveBeenCalled();
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    expect(screen.getByText("New subject 3")).toBeInTheDocument();
    await click("Keep both");
    expect(onDone).toHaveBeenCalledWith({ "a@x.com": "skip", "b@x.com": "keep" });
  });

  it("disables Replace with an explanation when the existing contact was already emailed", async () => {
    setup([conflict(2, "a@x.com", "sent")]);
    await screen.findByRole("alertdialog");
    const replace = screen.getByRole("button", { name: "Replace" });
    expect(replace).toBeDisabled();
    expect(screen.getByText("Already emailed - can't be replaced.")).toBeInTheDocument();
    expect(replace).toHaveAccessibleDescription("Already emailed - can't be replaced.");
  });

  it("applies Skip to every remaining duplicate", async () => {
    const { onDone } = setup([conflict(2, "a@x.com"), conflict(3, "B@x.com", "sent"), conflict(4, "c@x.com")]);
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("checkbox", { name: "Apply to all remaining duplicates" }));
    await click("Skip");
    expect(onDone).toHaveBeenCalledWith({ "a@x.com": "skip", "b@x.com": "skip", "c@x.com": "skip" });
  });

  it("applies Replace to all only where replaceable and asks about the rest", async () => {
    const { onDone } = setup([conflict(2, "a@x.com"), conflict(3, "B@x.com", "sent"), conflict(4, "c@x.com")]);
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("checkbox", { name: "Apply to all remaining duplicates" }));
    await click("Replace");
    expect(onDone).not.toHaveBeenCalled();
    // The already-emailed one is asked individually (Replace is off for it).
    expect(await screen.findByText("New subject 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    await click("Keep both");
    expect(onDone).toHaveBeenCalledWith({ "a@x.com": "replace", "c@x.com": "replace", "b@x.com": "keep" });
  });

  it("Cancel aborts without resolving anything", async () => {
    const { onDone, onCancel } = setup([conflict(2, "a@x.com")]);
    await screen.findByRole("alertdialog");
    await click("Cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });
});
