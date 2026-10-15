"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { FileText, Loader2, Pencil, Star, Trash2, Upload } from "lucide-react";
import { toast } from "@/lib/toast";
import { api, ApiError } from "@/lib/api";
import { formatDay, plural } from "@/lib/format";
import { checkResumeFile, checkResumeName, defaultNameFor, formatBytes, looksLikePdf } from "@/lib/resumes";
import type { Resume } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice } from "./Notice";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function deleteMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    const n = (err.body as { pendingMessages?: unknown } | null)?.pendingMessages;
    if (typeof n === "number") {
      return `This resume is attached to ${plural(n, "email")} that ${n === 1 ? "has" : "have"} not been sent yet. Cancel ${n === 1 ? "it" : "them"} or wait until ${n === 1 ? "it is" : "they are"} sent, then delete the resume.`;
    }
  }
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [suggested, setSuggested] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  function pick(f: File | undefined) {
    setFile(f ?? null);
    setError(null);
    if (f && (name === "" || name === suggested)) {
      const s = defaultNameFor(f.name);
      setSuggested(s);
      setName(s);
    }
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (input.current) {
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        input.current.files = dt.files;
      } catch {
        // Older browsers: the file is still tracked in state below.
      }
    }
    pick(f);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = checkResumeFile(file) ?? checkResumeName(name);
    if (problem) return setError(problem);
    if (!(await looksLikePdf(file!))) return setError("This file does not look like a PDF. Choose a real PDF.");
    setBusy(true);
    try {
      await api.uploadResume(file!, name);
      setFile(null);
      setName("");
      setSuggested("");
      if (input.current) input.current.value = "";
      toast.success("Resume uploaded");
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex h-full flex-col gap-3.5 rounded-[14px] border-2 border-dashed p-[18px]" onSubmit={onSubmit} noValidate>
      <label
        htmlFor="resume-file"
        className={cn(
          "group flex cursor-pointer flex-col items-center gap-1 rounded-lg px-4 py-4 text-center transition-colors",
          "hover:border-primary/60 hover:bg-accent/50 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
          dragging && "border-primary bg-accent",
          file && "bg-muted/50",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input id="resume-file" ref={input} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(e) => pick(e.target.files?.[0])} />
        {file ? <FileText aria-hidden="true" className="size-5 text-accent-text" /> : <Upload aria-hidden="true" className="size-5 text-muted-foreground group-hover:text-foreground" />}
        <span className="text-[13px] font-medium">Resume file (PDF, up to 5 MB)</span>
        <span className="text-xs text-muted-foreground">{file ? `${file.name} · ${formatBytes(file.size)}` : "Drop a PDF here or click to choose"}</span>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="resume-name">Display name</Label>
        <Input id="resume-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Backend roles" />
        <p className="text-xs text-muted-foreground">Shown when you choose which resume to attach.</p>
      </div>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Uploading…" : "Upload resume"}
        </Button>
      </div>
    </form>
  );
}

function ResumeItem({ resume, onChanged, onError }: { resume: Resume; onChanged: () => void; onError: (m: string | null) => void }) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(resume.displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const u = resume.usage;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      setMode("view");
      onChanged();
    } catch (err) {
      onError(deleteMessage(err));
      setMode("view");
    } finally {
      setBusy(false);
    }
  }

  function saveName(e: FormEvent) {
    e.preventDefault();
    const problem = checkResumeName(name);
    setNameError(problem);
    if (problem) return;
    void run(() => api.updateResume(resume.id, { displayName: name.trim() }));
  }

  const stat = (label: string, n: number, text: string, first = false) => (
    <div className={cn("px-3 py-[9px]", !first && "border-l")}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-base font-[650]">
        <span aria-hidden="true">{n}</span>
        <span className="sr-only">{n ? text : `No ${text.replace(/^\d+ /, "")}`}</span>
      </div>
    </div>
  );

  return (
    <li className="flex flex-col gap-3.5 rounded-[14px] border bg-card p-[18px]">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-[52px] w-[42px] shrink-0 place-items-center rounded-lg border border-st-red/20 bg-st-red-bg font-mono text-[10px] font-bold text-st-red">
          PDF
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold">{resume.displayName}</div>
          <div className="truncate font-mono text-[11.5px] text-muted-foreground">
            {resume.fileName} · {formatBytes(resume.sizeBytes)}
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">Added {formatDay(resume.createdAt)}</div>
        </div>
        {resume.isDefault && (
          <span className="flex items-center gap-1 rounded-full bg-st-indigo-bg px-2 py-[3px] text-[11px] font-semibold whitespace-nowrap text-st-indigo">
            <Star aria-hidden="true" className="size-[11px]" />
            Default
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 rounded-[10px] border">
        {stat("Pending mails", u.pendingMessages, plural(u.pendingMessages, "scheduled email"), true)}
        {stat("Batches", u.batches, plural(u.batches, "batch", "batches"))}
        {stat("Contacts", u.contacts, plural(u.contacts, "contact"))}
      </div>
      {mode === "rename" ? (
        <form className="flex w-full flex-wrap items-start gap-2" onSubmit={saveName} noValidate>
          <label className="sr-only" htmlFor={`rn-${resume.id}`}>
            New name for {resume.displayName}
          </label>
          <div className="min-w-0 flex-1">
            <Input id={`rn-${resume.id}`} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameError ? true : undefined} />
            {nameError && <p className="mt-1 text-xs text-destructive">{nameError}</p>}
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            Save name
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setMode("view")}>
            Keep
          </Button>
        </form>
      ) : (
        <div className="flex gap-2">
          {!resume.isDefault ? (
            <Button variant="outline" size="sm" className="flex-1" disabled={busy} aria-label={`Make ${resume.displayName} the default`} onClick={() => run(() => api.updateResume(resume.id, { isDefault: true }))}>
              <Star />
              Make default
            </Button>
          ) : (
            <span className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[12.5px] font-medium text-muted-foreground">
              <Star aria-hidden="true" className="size-[13px]" />
              Attached by default
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-label={`Rename ${resume.displayName}`}
            onClick={() => {
              setName(resume.displayName);
              setNameError(null);
              setMode("rename");
            }}
          >
            <Pencil />
            Rename
          </Button>
          <Button variant="outline" size="icon-sm" className="text-st-red hover:text-st-red" aria-label={`Delete ${resume.displayName}`} onClick={() => setMode("delete")}>
            <Trash2 />
          </Button>
        </div>
      )}
      <AlertDialog open={mode === "delete"} onOpenChange={(o) => !o && setMode("view")}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {resume.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>Delete this resume? Emails already sent are not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run(() => api.deleteResume(resume.id));
              }}
            >
              Delete resume
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function ResumesPanel() {
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    api.listResumes().then(
      (r) => live && setResumes(r),
      (err) => live && setError(err instanceof ApiError ? err.message : "Could not load the resumes."),
    );
    return () => {
      live = false;
    };
  }, [tick]);

  return (
    <div className="space-y-5">
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {resumes === null ? (
        !error && <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : resumes.length === 0 ? (
        <div className="space-y-4">
          <p className="rounded-lg border border-dashed px-4 py-5 text-center text-[13px] text-muted-foreground">No resumes yet. Upload a PDF below; the default one is attached to every email.</p>
          <div className="max-w-sm">
            <UploadForm onUploaded={reload} />
          </div>
        </div>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {resumes.map((r) => (
            <ResumeItem key={r.id} resume={r} onChanged={reload} onError={setError} />
          ))}
          <li>
            <UploadForm onUploaded={reload} />
          </li>
        </ul>
      )}
    </div>
  );
}
