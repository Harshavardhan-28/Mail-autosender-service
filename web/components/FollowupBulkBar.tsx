"use client";

import { useId, useState } from "react";
import { BellOff, CalendarClock, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatCalendarDay } from "@/lib/format";
import { describeFollowupError, FOLLOWUP_RANGE_ERROR, followupDateRange, isFollowupDateInRange } from "@/lib/followupDate";
import type { FollowupBulkResult } from "@/lib/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  batchId: string;
  /** Shown in the scope line; falls back to "this batch". */
  batchName?: string;
  /** Narrows the change to one company of the batch (exact, case-insensitive on the server). */
  company?: string;
  /** Called after the server applied the change, so the parent can reload its rows. */
  onApplied: (result: FollowupBulkResult) => void;
};

const resultLine = (r: FollowupBulkResult) => `Updated ${r.updated} of ${r.total}${r.skipped > 0 ? ` · ${r.skipped} skipped (replied, bounced or opted out)` : ""}`;

/** Sets (or clears) the follow-up date for every contact of a batch, optionally one company, via PUT /api/followups/bulk. */
export function FollowupBulkBar({ batchId, batchName, company, onApplied }: Props) {
  const id = useId();
  const range = followupDateRange();
  const [date, setDate] = useState(range.fallback);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const batchLabel = batchName ? `“${batchName}”` : "this batch";
  const scope = `all contacts${company ? ` at ${company}` : ""} in ${batchLabel}`;
  const validDate = isFollowupDateInRange(date, range);

  async function apply(enabled: boolean) {
    if (enabled && !validDate) return setError(FOLLOWUP_RANGE_ERROR);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.setFollowupBulk({ batchId, ...(company ? { company } : {}), enabled, ...(enabled ? { date } : {}) });
      setResult(resultLine(r));
      setConfirmOff(false);
      onApplied(r);
    } catch (err) {
      setError(describeFollowupError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[14px] border bg-card p-4" aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-0.5">
          <h2 id={`${id}-h`} className="text-sm font-medium">
            Follow-up for {scope}
          </h2>
          <p className="text-[13px] text-muted-foreground">Goes out at the send window’s opening on the picked day, never before the first email.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label>
            <span className="sr-only">Follow-up date</span>
            <Input
              type="date"
              min={range.min}
              max={range.max}
              value={date}
              disabled={busy}
              aria-invalid={!validDate || undefined}
              aria-describedby={error ? `${id}-err` : undefined}
              onChange={(e) => {
                setDate(e.target.value);
                setError(isFollowupDateInRange(e.target.value, range) ? null : FOLLOWUP_RANGE_ERROR);
              }}
              className="h-9 w-[9.5rem] bg-card"
            />
          </label>
          {validDate && <span className="text-xs whitespace-nowrap text-muted-foreground">{formatCalendarDay(date)}</span>}
          <Button className="h-9" disabled={busy} onClick={() => void apply(true)}>
            {busy && !confirmOff ? <Loader2 className="animate-spin" /> : <CalendarClock />}
            Schedule follow-up
          </Button>
          <Button variant="outline" className="h-9" disabled={busy} onClick={() => setConfirmOff(true)}>
            <BellOff />
            Turn off follow-ups
          </Button>
        </div>
      </div>
      {(error || result) && (
        <p role={error ? "alert" : "status"} id={error ? `${id}-err` : undefined} className={error ? "mt-2.5 text-xs text-destructive" : "mt-2.5 text-xs text-muted-foreground"}>
          {error ?? result}
        </p>
      )}

      <AlertDialog open={confirmOff} onOpenChange={(o) => !o && !busy && setConfirmOff(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off follow-ups for {scope}?</AlertDialogTitle>
            <AlertDialogDescription>Follow-ups that have not gone out yet are cancelled. Contacts who replied or bounced are left as they are.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void apply(false);
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
