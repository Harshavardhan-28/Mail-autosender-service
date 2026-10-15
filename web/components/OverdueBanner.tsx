"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { formatDateTime, plural } from "@/lib/format";
import { MAX_STAGGER_MINUTES } from "@/lib/schedule";
import { describeWindowPlan, nextWindowOpen, planWindowStagger } from "@/lib/sendWindowPlan";
import { sendWindowLabel } from "@/lib/sendWindow";
import type { SendWindow } from "@/lib/types";
import { Notice } from "./Notice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const isWindow = (w: unknown): w is SendWindow => {
  const x = w as Partial<SendWindow> | null | undefined;
  return !!x && typeof x.start === "string" && typeof x.end === "string" && typeof x.tz === "string";
};

/** Warning for scheduled emails whose send window closed before they went out, with a one-click reschedule. */
export function OverdueBanner({ className, onRescheduled, now = () => new Date() }: { className?: string; onRescheduled?: () => void; now?: () => Date }) {
  const [count, setCount] = useState(0);
  const [sendWin, setWindow] = useState<SendWindow | null>(null);
  const [open, setOpen] = useState(false);
  const [stagger, setStagger] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Quiet by design: a failed lookup just means no banner.
    api.getOverdue().then(
      (r) => setCount(typeof r?.count === "number" ? r.count : 0),
      () => setCount(0),
    );
  }, []);

  useEffect(() => {
    load();
    api.getSendWindow().then(
      (w) => setWindow(isWindow(w?.window) ? w.window : null),
      () => {},
    );
  }, [load]);

  if (count <= 0) return null;

  const raw = stagger.trim();
  const minutes = raw === "" ? 0 : Number(raw);
  const staggerError = !/^\d*$/.test(raw) || minutes > MAX_STAGGER_MINUTES ? `Whole minutes from 0 to ${MAX_STAGGER_MINUTES}` : null;
  const start = sendWin ? nextWindowOpen(sendWin, now()) : null;
  const plan = sendWin && start && !staggerError ? planWindowStagger(start, count, minutes, sendWin) : null;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.rescheduleOverdue({ staggerMinutes: minutes });
      toast.success(`Rescheduled ${plural(r.rescheduled, "email")}`);
      setOpen(false);
      setCount(0);
      load();
      onRescheduled?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reschedule. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Notice tone="warning" role="status" className={className}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p>
            {plural(count, "scheduled email")} {count === 1 ? "is" : "are"} past due (their send window closed before they went out).
          </p>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Reschedule to next window
          </Button>
        </div>
      </Notice>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reschedule {plural(count, "past-due email")}</DialogTitle>
            <DialogDescription>
              {start && sendWin ? `First send ${formatDateTime(start)} (window ${sendWindowLabel(sendWin)}).` : "They move to the next daily send window."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="overdue-stagger">Stagger (minutes)</Label>
            <Input
              id="overdue-stagger"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_STAGGER_MINUTES}
              value={stagger}
              onChange={(e) => setStagger(e.target.value)}
              aria-invalid={staggerError ? true : undefined}
              aria-describedby="overdue-stagger-hint"
            />
            <p className="text-xs text-muted-foreground" id="overdue-stagger-hint" aria-live="polite">
              {staggerError ? <span className="text-destructive">{staggerError}</span> : plan && sendWin ? describeWindowPlan(plan, count, sendWin) : "Gap between slots, packed into the window"}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={busy || !!staggerError}>
              {busy && <Loader2 className="animate-spin" />}
              Reschedule {plural(count, "email")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
