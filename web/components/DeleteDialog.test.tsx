import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { DeleteDialog } from "./DeleteDialog";

function setup(perform: (force: boolean) => Promise<{ deleted: number }>) {
  const onDeleted = vi.fn();
  const onClose = vi.fn();
  render(
    <DeleteDialog open onClose={onClose} title="Delete 3 contacts?" description="Their scheduled emails will be cancelled." confirmLabel="Delete 3 contacts" successMessage={(n) => `Deleted ${n}`} perform={perform} onDeleted={onDeleted} />,
  );
  return { onDeleted, onClose };
}

const needsForce = () => new ApiError(409, "already emailed", { code: "needs_force", protectedCount: 2 });

describe("DeleteDialog", () => {
  it("names what is removed and deletes without force on the first attempt", async () => {
    const perform = vi.fn().mockResolvedValue({ deleted: 3 });
    const { onDeleted } = setup(perform);
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText("Delete 3 contacts?")).toBeInTheDocument();
    expect(within(dlg).getByText(/scheduled emails will be cancelled/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete 3 contacts" }));
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledWith(3));
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform).toHaveBeenCalledWith(false);
  });

  it("asks a second question on needs_force and retries with force only after confirming", async () => {
    const perform = vi.fn().mockRejectedValueOnce(needsForce()).mockResolvedValueOnce({ deleted: 3 });
    const { onDeleted } = setup(perform);
    await userEvent.click(await screen.findByRole("button", { name: "Delete 3 contacts" }));
    const second = await screen.findByText(/2 of these were already emailed \(sent or replied\)/);
    expect(second).toBeInTheDocument();
    expect(screen.getByText(/removes their history from the dashboard/)).toBeInTheDocument();
    expect(perform).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledWith(3));
    expect(perform.mock.calls).toEqual([[false], [true]]);
  });

  it("does not force when the second dialog is declined", async () => {
    const perform = vi.fn().mockRejectedValue(needsForce());
    const { onClose, onDeleted } = setup(perform);
    await userEvent.click(await screen.findByRole("button", { name: "Delete 3 contacts" }));
    await screen.findByText(/sent or replied/);
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(perform).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows other errors in the dialog and stays open", async () => {
    const perform = vi.fn().mockRejectedValue(new ApiError(500, "Boom"));
    const { onDeleted } = setup(perform);
    await userEvent.click(await screen.findByRole("button", { name: "Delete 3 contacts" }));
    expect(await screen.findByText("Boom")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
