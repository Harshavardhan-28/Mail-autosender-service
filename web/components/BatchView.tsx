"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { plural } from "@/lib/format";
import type { Resume, SendWindowInfo, UploadResult } from "@/lib/types";
import { BatchScheduler } from "./BatchScheduler";
import { DeleteDialog } from "./DeleteDialog";
import { FollowupBulkBar } from "./FollowupBulkBar";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** An existing batch in the same preview-and-schedule table the upload shows. */
export function BatchView({ id }: { id: string }) {
  const [batch, setBatch] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [sendWindow, setSendWindow] = useState<SendWindowInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const router = useRouter();

  useEffect(() => {
    let live = true;
    api.getBatch(id).then(
      (b) => {
        // Import problems are only known at upload time; `row` is the CSV line, so use the list position.
        if (live) setBatch({ batch: b.batch, contacts: b.contacts.map((c, i) => ({ ...c, row: i + 2 })), errors: [], warnings: [] });
      },
      (err) => live && setError(err instanceof ApiError ? err.message : "Could not load this batch. Try again."),
    );
    return () => {
      live = false;
    };
  }, [id, tick]);

  useEffect(() => {
    let live = true;
    api.listResumes().then((r) => live && setResumes(r), () => {});
    api.getSendWindow().then((w) => live && setSendWindow(w), () => {});
    return () => {
      live = false;
    };
  }, [id]);

  const back = (
    <Button variant="outline" size="sm" asChild>
      <Link href={`/contacts?batchId=${encodeURIComponent(id)}`}>
        <ArrowLeft />
        Contacts
      </Link>
    </Button>
  );

  if (error) {
    return (
      <div>
        <PageHeader title="Batch" actions={back} />
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      </div>
    );
  }

  if (!batch) {
    return (
      <div aria-busy="true">
        <PageHeader title="Batch" actions={back} />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const waiting = batch.contacts.filter((c) => c.status === "uploaded").length;
  return (
    <div>
      <PageHeader
        eyebrow="Schedule batch"
        title={batch.batch.name}
        description={`${plural(batch.contacts.length, "contact")} · ${waiting === 0 ? "nothing left to schedule" : `${waiting} waiting to be scheduled`}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
              <Trash2 />
              Delete batch
            </Button>
            {back}
          </>
        }
      />
      <DeleteDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete batch “${batch.batch.name}”?`}
        description={`Its ${plural(batch.contacts.length, "contact")} will be removed and their scheduled emails cancelled.`}
        confirmLabel="Delete batch"
        successMessage={() => `Deleted batch “${batch.batch.name}”`}
        perform={(force) => api.deleteBatch(id, force)}
        onDeleted={() => router.push("/contacts")}
      />
      <div className="mb-5">
        <FollowupBulkBar key={sendWindow?.window?.tz} batchId={id} batchName={batch.batch.name} tz={sendWindow?.window?.tz || undefined} onApplied={reload} />
      </div>
      <BatchScheduler upload={batch} resumes={resumes} sendWindow={sendWindow} reopened />
    </div>
  );
}
