"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { plural } from "@/lib/format";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  successMessage: (deleted: number) => string;
  /** Runs the delete. The first call is always force=false; force=true only follows an explicit second confirmation. */
  perform: (force: boolean) => Promise<{ deleted: number }>;
  onDeleted: (deleted: number) => void;
};

/** Two-step delete confirmation: names what goes, then, if some contacts were already emailed, asks again before forcing. */
export function DeleteDialog({ open, onClose, title, description, confirmLabel, successMessage, perform, onDeleted }: Props) {
  const [protectedCount, setProtectedCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Always reopen on the first question.
  function close() {
    onClose();
    setProtectedCount(null);
    setError(null);
  }

  async function run(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { deleted } = await perform(force);
      toast.success(successMessage(deleted));
      close();
      onDeleted(deleted);
    } catch (err) {
      if (!force && err instanceof ApiError && err.needsForce) setProtectedCount(err.protectedCount ?? 0);
      else setError(err instanceof ApiError ? err.message : "Could not delete. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const forcing = protectedCount !== null;
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{forcing ? "Some of these were already emailed" : title}</AlertDialogTitle>
          <AlertDialogDescription>
            {forcing
              ? `${protectedCount} of these ${protectedCount === 1 ? "was" : "were"} already emailed (sent or replied). Deleting removes their history from the dashboard. Delete anyway?`
              : description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void run(forcing);
            }}
          >
            {busy && <Loader2 className="animate-spin" />}
            {forcing ? "Delete anyway" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Delete 3 contacts?" copy shared by the Contacts page and the batch header. */
export const deleteContactsCopy = (n: number) => ({
  title: `Delete ${plural(n, "contact")}?`,
  description: `${n === 1 ? "Its" : "Their"} scheduled emails will be cancelled.`,
  confirmLabel: `Delete ${plural(n, "contact")}`,
  successMessage: (d: number) => `Deleted ${plural(d, "contact")}`,
});
