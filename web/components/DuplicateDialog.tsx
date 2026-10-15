"use client";

import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { StatusBadge } from "./StatusBadge";
import type { ImportConflict, ImportRow, Resolution } from "@/lib/types";

const key = (email: string) => email.trim().toLowerCase();

type Props = {
  /** The duplicates that still need a decision. */
  conflicts: ImportConflict[];
  /** The rows being imported, to show the new entry next to the existing one. */
  rows: ImportRow[];
  /** Every conflict is decided: resolutions keyed by lowercased email. */
  onDone: (resolutions: Record<string, Resolution>) => void;
  /** Abort the save; nothing was written. */
  onCancel: () => void;
};

function Entry({ heading, lines, status }: { heading: string; lines: [string, string][]; status?: string }) {
  return (
    <section aria-label={heading} className="min-w-0 space-y-1.5 rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{heading}</h3>
        {status && <StatusBadge status={status} />}
      </div>
      <dl className="space-y-1 text-[13px]">
        {lines.map(([k, v]) => (
          <div key={k}>
            <dt className="sr-only">{k}</dt>
            <dd className={k === "Subject" ? "break-words font-medium" : "break-words"}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Asks what to do with each email that already exists, one at a time, like a file-conflict prompt. */
export function DuplicateDialog({ conflicts, rows, onDone, onCancel }: Props) {
  const [decided, setDecided] = useState<Record<string, Resolution>>({});
  const [applyAll, setApplyAll] = useState(false);

  const pending = conflicts.filter((c) => !decided[key(c.email)]);
  const current = pending[0];
  if (!current) return null;
  const incoming = rows.find((r) => key(r.email) === key(current.email));
  const position = conflicts.length - pending.length + 1;

  function choose(action: Resolution) {
    const next = { ...decided, [key(current!.email)]: action };
    if (applyAll) {
      // Replace only where it is allowed; the rest are asked one by one.
      for (const c of pending.slice(1)) if (action !== "replace" || c.replaceable) next[key(c.email)] = action;
    }
    setDecided(next);
    if (conflicts.every((c) => next[key(c.email)])) onDone(next);
  }

  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent className="sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            This email is already in your data
            {conflicts.length > 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">{position} of {conflicts.length}</span>}
          </AlertDialogTitle>
          <AlertDialogDescription className="font-mono break-all">{current.email}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-3">
            {current.matches.map((m) => (
              <Entry
                key={m.contactId}
                heading={`Existing entry in ${m.batchName}`}
                status={m.status}
                lines={[
                  ["Person", m.person],
                  ["Company and role", `${m.company} · ${m.role}`],
                  ["Subject", m.subject],
                ]}
              />
            ))}
          </div>
          {incoming && (
            <Entry
              heading="New row"
              lines={[
                ["Person", incoming.person],
                ["Company and role", `${incoming.company} · ${incoming.role}`],
                ["Subject", incoming.subject],
              ]}
            />
          )}
        </div>

        {!current.replaceable && (
          <p id="replace-hint" className="text-xs text-muted-foreground">
            Already emailed - can&apos;t be replaced.
          </p>
        )}

        {pending.length > 1 && (
          <div className="flex items-center gap-2">
            <Checkbox id="apply-all" checked={applyAll} onCheckedChange={(v) => setApplyAll(v === true)} />
            <Label htmlFor="apply-all">Apply to all remaining duplicates</Label>
            <span className="text-xs text-muted-foreground">({pending.length - 1} more)</span>
          </div>
        )}

        <AlertDialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => choose("skip")}>
            Skip
          </Button>
          <Button variant="outline" disabled={!current.replaceable} aria-describedby={current.replaceable ? undefined : "replace-hint"} onClick={() => choose("replace")}>
            Replace
          </Button>
          <Button onClick={() => choose("keep")}>Keep both</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
