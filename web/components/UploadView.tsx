"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { checkCsvFile, MAX_ROWS } from "@/lib/upload";
import { plural } from "@/lib/format";
import type { CommitResult, ImportConflict, ImportRow, PreviewResult, Resolution, Resume, RowIssue, SendWindowInfo } from "@/lib/types";
import { ArrowRight, Download, FileSpreadsheet, Loader2, RotateCcw, Upload as UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BatchScheduler } from "./BatchScheduler";
import { DuplicateDialog } from "./DuplicateDialog";
import { ImportReview } from "./ImportReview";
import { Notice } from "./Notice";
import { PageBody, PageHeader } from "./PageHeader";
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
  const [schedStep, setSchedStep] = useState<3 | 4>(3);

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
        >
          <Stepper current={schedStep} />
        </PageHeader>
        <PageBody max="max-w-[1100px]">
          <BatchScheduler upload={result} resumes={resumes} sendWindow={sendWindow} onStep={setSchedStep} />
        </PageBody>
      </div>
    );
  }

  if (preview) {
    return (
      <div>
        <PageHeader eyebrow="Create / Upload" title="Import contacts" description={`${file?.name ?? preview.filename}. Check the rows, fix anything that is wrong, then save.`}>
          <Stepper current={2} />
        </PageHeader>
        <PageBody max="max-w-[1100px]">
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
        </PageBody>
      </div>
    );
  }

  const REQUIRED = ["company", "role", "person", "email", "subject", "mailText", "followupText"];
  return (
    <div>
      <PageHeader eyebrow="Create / Upload" title="Import contacts" description={`Columns: Company, Role, Person, Email, Subject, Mail Text, and optionally Follow-up Text. Up to ${MAX_ROWS} rows, 1 MB.`}>
        <Stepper current={1} />
      </PageHeader>
      <PageBody max="max-w-[1100px]" className="pt-[26px]">
        <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,1fr)]">
          <div className="space-y-4">
            <label
              className={cn(
                "group flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[#c3c7f2] bg-card px-6 py-14 text-center transition-colors dark:border-[#3a3f7a]",
                "hover:border-primary hover:bg-st-indigo-bg/40 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
                dragging && "border-primary bg-st-indigo-bg/60",
                file && "border-solid border-primary/40",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input ref={input} className="sr-only" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
              <span className="grid size-14 place-items-center rounded-2xl bg-st-indigo-bg text-primary">
                {file ? <FileSpreadsheet aria-hidden="true" className="size-[26px]" /> : <UploadIcon aria-hidden="true" className="size-[26px]" />}
              </span>
              <span className="text-base font-semibold">{file ? file.name : "Drop your CSV here"}</span>
              <span className="text-[13px] text-muted-foreground">
                {file ? (
                  `${(file.size / 1024).toFixed(1)} KB · choose again to replace`
                ) : (
                  <>
                    or <span className="font-semibold text-primary">browse files</span> · up to {MAX_ROWS} rows
                  </>
                )}
              </span>
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

            <div className="flex justify-end">
              <Button disabled={!file || busy} onClick={onPreview}>
                {busy && <Loader2 className="animate-spin" />}
                {busy ? "Reading…" : "Preview"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3.5">
            <div className="rounded-[14px] border bg-card px-[18px] py-4">
              <h2 className="mb-2.5 text-sm font-semibold">Required columns</h2>
              <div className="flex flex-wrap gap-1.5">
                {REQUIRED.map((c, i) => (
                  <span key={c} className={cn("rounded-md px-2 py-[3px] font-mono text-xs font-medium", i < 6 ? "bg-st-indigo-bg text-st-indigo" : "bg-secondary text-muted-foreground")}>
                    {c}
                  </span>
                ))}
              </div>
              <p className="mt-2.5 text-xs text-muted-foreground">Grey columns are optional. Follow-up text falls back to your template in Settings.</p>
            </div>
            <a href="/contacts-template.csv" download className="flex items-center gap-2.5 rounded-[14px] border bg-card px-[18px] py-3.5 transition-colors hover:bg-accent/50">
              <Download aria-hidden="true" className="size-4 text-primary" />
              <span className="flex-1">
                <span className="block text-[13.5px] font-semibold">Download CSV template</span>
                <span className="block text-xs text-muted-foreground">contacts-template.csv</span>
              </span>
              <ArrowRight aria-hidden="true" className="size-[15px] text-muted-foreground" />
            </a>
          </div>
        </div>
      </PageBody>
    </div>
  );
}
