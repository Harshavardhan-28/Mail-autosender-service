"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Layers, Upload } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatDay } from "@/lib/format";
import type { BatchSummary } from "@/lib/types";
import { Dyn } from "./Dyn";
import { Notice } from "./Notice";
import { PageBody, PageHeader } from "./PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const SEGMENTS: { key: string; label: string; className: string; keys: string[] }[] = [
  { key: "uploaded", label: "unscheduled", className: "bg-[#a7aab8]", keys: ["uploaded"] },
  { key: "scheduled", label: "scheduled", className: "bg-[#6d78f0]", keys: ["scheduled"] },
  { key: "sent", label: "sent", className: "bg-[#30a46c]", keys: ["sent"] },
  { key: "replied", label: "replied", className: "bg-[#b38cf0]", keys: ["replied"] },
  { key: "problem", label: "stopped", className: "bg-[#e5484d]", keys: ["failed", "bounced", "opted_out"] },
];

function BatchRow({ batch }: { batch: BatchSummary }) {
  const n = batch.contactCount || 1;
  const count = (keys: string[]) => keys.reduce((sum, k) => sum + (batch.statusCounts[k as keyof typeof batch.statusCounts] ?? 0), 0);
  const unscheduled = count(["uploaded"]);
  return (
    <li className="grid items-center gap-x-6 gap-y-3 rounded-[14px] border bg-card px-5 py-4 md:grid-cols-[minmax(200px,1.2fr)_minmax(220px,2fr)_auto]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-[38px] shrink-0 place-items-center rounded-[10px] bg-st-indigo-bg text-primary">
          <Layers aria-hidden="true" className="size-[17px]" />
        </span>
        <div className="min-w-0">
          <Link href={`/batches/${encodeURIComponent(batch.id)}`} className="block truncate text-[14.5px] font-semibold hover:underline">
            {batch.name}
          </Link>
          <p className="truncate font-mono text-[11.5px] text-muted-foreground">
            {batch.originalFilename ? `${batch.originalFilename} · ` : ""}
            {formatDay(batch.createdAt)}
          </p>
        </div>
      </div>
      <div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-accent" role="img" aria-label={`${batch.contactCount} contacts`}>
          {SEGMENTS.map((s) => (
            <Dyn key={s.key} className={s.className} w={(count(s.keys) / n) * 100} />
          ))}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3.5 text-xs text-muted-foreground">
          <span>
            <b className="font-semibold text-foreground">{batch.contactCount}</b> contacts
          </span>
          {SEGMENTS.filter((s) => count(s.keys) > 0).map((s) => (
            <span key={s.key} className={s.key === "replied" ? "text-st-violet" : undefined}>
              {count(s.keys)} {s.label}
            </span>
          ))}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {unscheduled > 0 && (
          <Button size="sm" asChild>
            <Link href={`/batches/${encodeURIComponent(batch.id)}`}>
              <CalendarClock />
              Schedule {unscheduled}
            </Link>
          </Button>
        )}
        <Button size="sm" variant="outline" asChild>
          <Link href={`/contacts?batchId=${encodeURIComponent(batch.id)}`}>Contacts</Link>
        </Button>
      </div>
    </li>
  );
}

export function BatchesView() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.listBatches().then(
      (b) => live && setBatches(b),
      (err) => live && setError(err instanceof ApiError ? err.message : "Could not load batches. Try again."),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Workspace / Batches"
        title="Batches"
        description="Each CSV import becomes a batch you can schedule or delete as a unit."
        actions={
          <Button asChild>
            <Link href="/upload">
              <Upload />
              New batch
            </Link>
          </Button>
        }
      />
      <PageBody max="max-w-[1200px]" className="space-y-3">
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {!batches && !error && (
        <div className="space-y-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      )}
      {batches && batches.length === 0 && (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-[13px] text-muted-foreground">No batches yet. Upload a CSV to create one.</p>
      )}
      {batches && batches.length > 0 && (
        <ul className="space-y-3">
          {batches.map((b) => (
            <BatchRow key={b.id} batch={b} />
          ))}
        </ul>
      )}
      </PageBody>
    </div>
  );
}
