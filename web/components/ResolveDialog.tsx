"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { refusalText } from "@/lib/refusals";
import { toast } from "@/lib/toast";
import type { ResolveAction } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const RESOLVE_COPY: Record<ResolveAction, { label: string; ask: string; confirm: string; hint: string }> = {
  mark_sent: { label: "It was sent", ask: "Check your Sent folder first. Record this email as delivered?", confirm: "Mark sent", hint: "It reached the recipient. Record it as delivered." },
  requeue: { label: "Send again", ask: "Send it again now? If it did go out, the recipient gets a duplicate.", confirm: "Send again", hint: "It did not go out. Queue it again now." },
  cancel: { label: "Drop it", ask: "Drop this email? It will not be sent.", confirm: "Drop email", hint: "Do not send it at all." },
};

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.refused?.[0] ? refusalText(err.refused[0].reason) : err.message;
  return "Something went wrong. Try again.";
}

/** Settles a message whose delivery is unknown (needs_review): pick an outcome, confirm, record it. */
export function ResolveDialog({
  open,
  onClose,
  messageId,
  kindLabel,
  email,
  onResolved,
}: {
  open: boolean;
  onClose: () => void;
  messageId: string;
  kindLabel: string;
  email: string;
  onResolved: (action: ResolveAction) => void;
}) {
  const [resolving, setResolving] = useState<ResolveAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setResolving(null);
    setError(null);
    onClose();
  }

  async function confirm(action: ResolveAction) {
    setBusy(true);
    setError(null);
    try {
      await api.resolveMessage(messageId, action);
      toast.success("Settled");
      setResolving(null);
      onResolved(action);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kindLabel} delivery unknown</DialogTitle>
          <DialogDescription>The send to {email} was interrupted, so it is unclear whether it went out. Check your Sent folder, then choose what to record.</DialogDescription>
        </DialogHeader>
        {resolving ? (
          <div className="space-y-4">
            <p className="text-[13px]">{RESOLVE_COPY[resolving].ask}</p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setResolving(null)}>
                Keep
              </Button>
              <Button variant={resolving === "requeue" ? "destructive" : "default"} disabled={busy} onClick={() => void confirm(resolving)}>
                {busy && <Loader2 className="animate-spin" />}
                {RESOLVE_COPY[resolving].confirm}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <ul className="space-y-2">
            {(Object.keys(RESOLVE_COPY) as ResolveAction[]).map((action) => (
              <li key={action}>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setResolving(action);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30"
                >
                  <span className="text-[13px] font-medium">{RESOLVE_COPY[action].label}</span>
                  <span className="text-xs text-muted-foreground">{RESOLVE_COPY[action].hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
