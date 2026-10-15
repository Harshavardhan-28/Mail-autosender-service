"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { checkCsvFile, MAX_ROWS } from "@/lib/upload";
import { plural } from "@/lib/format";
import type { CommitResult, ImportConflict, ImportRow, PreviewResult, Resolution, Resume, RowIssue, SendWindowInfo } from "@/lib/types";
import { Download, FileSpreadsheet, Loader2, RotateCcw, Upload as UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BatchScheduler } from "./BatchScheduler";
import { DuplicateDialog } from "./DuplicateDialog";
import { ImportReview } from "./ImportReview";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Stepper } from "./Stepper";
import { Button } from "@/components/ui/button";

export function UploadView() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<RowIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; rows: RowIssue[] } | null>(null);
  // The edits being saved, and the duplicates still waiting for a decision (round counts how often the dialog opened).
  const [draft, setDraft] = useState<{ name: string; rows: ImportRow[]; resolutions: Record<string, Resolution> } | null>(null);
  const [asking, setAsking] = useState<{ conflicts: ImportConflict[]; round: number } | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);

  const [sendWindow, setSendWindow] = useState<SendWindowInfo | null>(null);

  useEffect(() => {
    api.listResumes().then(setResumes, () => {});
    api.getSendWindow().then(setSendWindow, () => {});
  }, []);

  function pick(f: File | undefined | null) {
    setRowErrors([]);
    if (!f) return;
    const problem = checkCsvFile(f);
    setError(problem);
    setFile(problem ? null : f);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  }

  async function onPreview() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setRowErrors([]);
    try {
      setPreview(await api.previewBatch(file));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setRowErrors(err.rowErrors ?? []);
      } else setError("Could not read the file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function commit(d: NonNullable<typeof draft>) {
    if (!preview) return;
    setSaving(true);
    setSaveError(null);
    setAsking(null);
    try {
      setResult(await api.commitBatch({ name: d.name, filename: preview.filename, rows: d.rows, resolutions: d.resolutions }));
    } catch (err) {
      if (err instanceof ApiError && err.conflicts?.length) {
        // An edit introduced a duplicate the preview did not know about.
        setAsking((a) => ({ conflicts: err.conflicts!, round: (a?.round ?? 0) + 1 }));
      } else if (err instanceof ApiError) setSaveError({ message: err.message, rows: err.rowErrors ?? [] });
      else setSaveError({ message: "Could not save. Try again.", rows: [] });
    } finally {
      setSaving(false);
    }
  }

  function onSave({ name, rows }: { name: string; rows: ImportRow[] }) {
    // Duplicates the preview found still apply while the row's email is unchanged; the server reports any others.
    const known = new Map((preview?.conflicts ?? []).map((c) => [c.email.trim().toLowerCase(), c]));
    const conflicts = rows.flatMap((r) => {
      const c = known.get(r.email.trim().toLowerCase());
      return c ? [{ ...c, row: r.row, email: r.email.trim() }] : [];
    });
    const d = { name, rows, resolutions: {} };
    setDraft(d);
    if (conflicts.length) setAsking({ conflicts, round: 1 });
    else void commit(d);
  }

  function onResolved(res: Record<string, Resolution>) {
    if (!draft) return;
    const d = { ...draft, resolutions: { ...draft.resolutions, ...res } };
    setDraft(d);
    void commit(d);
  }

  function reset() {
    setResult(null);
    setPreview(null);
    setDraft(null);
    setAsking(null);
    setSaveError(null);
    setFile(null);
    setError(null);
    setRowErrors([]);
    if (input.current) input.current.value = "";
  }

  // Back to file selection; nothing was saved.
  function back() {
    setPreview(null);
    setDraft(null);
    setAsking(null);
    setSaveError(null);
  }

  if (result) {
    return (
      <div>
        <PageHeader
          eyebrow="Batch uploaded"
          title={result.batch.name}
          description={
            <>
              {plural(result.contacts.length, "contact")} imported
              {result.errors.length > 0 && `, ${plural(result.errors.length, "row")} rejected`}
              {(result.skipped > 0 || result.replaced > 0) && `, ${result.skipped} skipped, ${result.replaced} replaced`}. Nothing is scheduled until you confirm below.
            </>
          }
          actions={
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw />
              Upload another file
            </Button>
          }
        />
        <BatchScheduler upload={result} resumes={resumes} sendWindow={sendWindow} />
      </div>
    );
  }

  if (preview) {
    return (
      <div>
        <PageHeader title="Review your import" description={`${file?.name ?? preview.filename}. Check the rows, fix anything that is wrong, then save.`} />
        <Stepper current={1} />
        <ImportReview
          preview={preview}
          saving={saving}
          onBack={back}
          onSave={onSave}
          error={
            saveError && (
              <Notice tone="danger" role="alert" title={saveError.message}>
                {saveError.rows.length > 0 && (
                  <ul className="max-h-60 space-y-1 overflow-y-auto pt-1">
                    {saveError.rows.map((e) => (
                      <li key={e.row} className="flex gap-3">
                        <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">Row {e.row}</span>
                        <span>{e.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Notice>
            )
          }
        />
        {asking && draft && <DuplicateDialog key={asking.round} conflicts={asking.conflicts} rows={draft.rows} onDone={onResolved} onCancel={() => setAsking(null)} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        eyebrow="Create / Upload"
        title="Upload a CSV"
        description={`Columns: Company, Role, Person, Email, Subject, Mail Text, and optionally Follow-up Text. Up to ${MAX_ROWS} rows, 1 MB.`}
      />
      <Stepper current={1} />

      <div className="space-y-5 rounded-lg border bg-card p-5">
        <label
          className={cn(
            "group flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
            "hover:border-primary/60 hover:bg-accent/50 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
            dragging && "border-primary bg-accent",
            file && "border-solid bg-muted/50",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input ref={input} className="sr-only" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
          <span className="mb-1 grid size-9 place-items-center rounded-lg border bg-background text-muted-foreground group-hover:text-foreground">
            {file ? <FileSpreadsheet aria-hidden="true" className="size-4.5" /> : <UploadIcon aria-hidden="true" className="size-4.5" />}
          </span>
          <span className="text-sm font-medium">{file ? file.name : "Drop a CSV here"}</span>
          <span className="text-[13px] text-muted-foreground">{file ? `${(file.size / 1024).toFixed(1)} KB · choose again to replace` : "or click to choose a file"}</span>
        </label>

        {error && (
          <Notice tone="danger" role="alert" title={error}>
            {rowErrors.length > 0 && (
              <ul className="max-h-60 space-y-1 overflow-y-auto pt-1">
                {rowErrors.map((e) => (
                  <li key={e.row} className="flex gap-3">
                    <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">Row {e.row}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        )}

        <div className="flex items-center justify-between gap-3">
          <a
            href="/contacts-template.csv"
            download
            className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-accent-text underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
          >
            <Download aria-hidden="true" className="size-3.5" />
            Download CSV template
          </a>
          <Button disabled={!file || busy} onClick={onPreview}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Reading…" : "Preview"}
          </Button>
        </div>
      </div>
    </div>
  );
}
