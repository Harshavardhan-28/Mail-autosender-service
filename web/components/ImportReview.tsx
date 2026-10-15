"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Loader2, Trash2 } from "lucide-react";
import { importRowsReady, validateImportRows, type FieldKey } from "@/lib/importRows";
import { plural, statusLabel } from "@/lib/format";
import type { ImportConflict, ImportRow, PreviewResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice } from "./Notice";
import { TextButton } from "./TextButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const SHORT_FIELDS: { key: Exclude<FieldKey, "mailText" | "followupText">; label: string; width: string }[] = [
  { key: "company", label: "Company", width: "w-36" },
  { key: "role", label: "Role", width: "w-36" },
  { key: "person", label: "Person", width: "w-36" },
  { key: "email", label: "Email", width: "w-52" },
  { key: "subject", label: "Subject", width: "w-56" },
];

type Props = {
  preview: PreviewResult;
  saving: boolean;
  /** Save failure to show above the buttons (the edits are kept). */
  error?: React.ReactNode;
  onBack: () => void;
  onSave: (draft: { name: string; rows: ImportRow[] }) => void;
};

/** Step between choosing a file and saving it: nothing is written until "Save to database". */
export function ImportReview({ preview, saving, error, onBack, onSave }: Props) {
  const [name, setName] = useState(preview.suggestedName);
  const [rows, setRows] = useState<ImportRow[]>(preview.rows);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const problems = useMemo(() => validateImportRows(rows), [rows]);
  const ready = importRowsReady(rows, problems);
  const invalid = problems.filter((p) => Object.keys(p).length > 0).length;

  // The preview's duplicates still apply to a row only while its email is unchanged.
  const known = useMemo(() => new Map<string, ImportConflict>(preview.conflicts.map((c) => [c.email.trim().toLowerCase(), c])), [preview.conflicts]);
  const conflictOf = (r: ImportRow) => known.get(r.email.trim().toLowerCase());
  const duplicates = rows.filter((r) => conflictOf(r)).length;

  const edit = (n: number, key: FieldKey, value: string) =>
    setRows((rs) => rs.map((r) => (r.row === n ? { ...r, [key]: key === "followupText" && value === "" ? null : value } : r)));
  const remove = (n: number) => setRows((rs) => rs.filter((r) => r.row !== n));
  const toggle = (n: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(n)) next.add(n);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="space-y-1.5 rounded-lg border bg-card p-4">
        <Label htmlFor="batch-name">Batch name</Label>
        <Input id="batch-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className="max-w-md" />
      </div>

      <Notice tone="info">Nothing is saved yet. Review and edit, then save to the database.</Notice>

      {preview.errors.length > 0 && (
        <Notice tone="warning" title={`${plural(preview.errors.length, "row")} in the file ${preview.errors.length === 1 ? "was" : "were"} rejected and won't be imported`}>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-accent-text">Show rejected rows</summary>
            <ul className="max-h-48 space-y-1 overflow-y-auto pt-1.5">
              {preview.errors.map((e) => (
                <li key={e.row} className="flex gap-3">
                  <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">Row {e.row}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          </details>
        </Notice>
      )}

      <p role="status" className="text-[13px] text-muted-foreground tabular-nums">
        {rows.length - invalid} {rows.length - invalid === 1 ? "row" : "rows"} ready, {invalid} with problems, {plural(duplicates, "duplicate")}
      </p>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Row</TableHead>
              {SHORT_FIELDS.map((f) => (
                <TableHead key={f.key}>{f.label}</TableHead>
              ))}
              <TableHead>Mail Text</TableHead>
              <TableHead>Follow-up Text</TableHead>
              <TableHead className="pr-4">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  No rows left to import.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r, i) => {
              const p = problems[i]!;
              const conflict = conflictOf(r);
              const isOpen = open.has(r.row);
              const err = (k: FieldKey) => (p[k] ? `err-${r.row}-${k}` : undefined);
              const message = (k: FieldKey) =>
                p[k] && (
                  <p id={`err-${r.row}-${k}`} className="mt-1 text-xs text-destructive">
                    {p[k]}
                  </p>
                );
              return (
                <Fragment key={r.row}>
                  <TableRow className="align-top">
                    <TableCell className="pl-4 align-top font-mono text-xs text-muted-foreground">{r.row}</TableCell>
                    {SHORT_FIELDS.map((f) => (
                      <TableCell key={f.key} className="align-top">
                        <Input
                          aria-label={`${f.label} for row ${r.row}`}
                          value={r[f.key]}
                          onChange={(e) => edit(r.row, f.key, e.target.value)}
                          aria-invalid={p[f.key] ? true : undefined}
                          aria-describedby={err(f.key)}
                          className={cn("h-8 px-2 text-xs", f.width)}
                        />
                        {message(f.key)}
                        {f.key === "email" && conflict && (
                          <span className="mt-1 inline-block rounded-md bg-st-amber-bg px-1.5 py-0.5 text-[11px] font-medium text-st-amber">
                            Already in {conflict.matches[0]?.batchName ?? "another batch"} ({statusLabel(conflict.matches[0]?.status ?? "uploaded")})
                            {conflict.matches.length > 1 && ` +${conflict.matches.length - 1}`}
                          </span>
                        )}
                      </TableCell>
                    ))}
                    <TableCell className="align-top">
                      <TextButton
                        className="inline-flex items-center gap-0.5 py-1"
                        aria-expanded={isOpen}
                        aria-controls={`mail-${r.row}`}
                        aria-label={`${isOpen ? "Hide" : "Edit"} mail text for row ${r.row}`}
                        onClick={() => toggle(r.row)}
                      >
                        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
                        {isOpen ? "Hide" : "Edit"}
                      </TextButton>
                      {!isOpen && message("mailText")}
                    </TableCell>
                    <TableCell className="align-top">
                      <Input
                        aria-label={`Follow-up Text for row ${r.row}`}
                        value={r.followupText ?? ""}
                        onChange={(e) => edit(r.row, "followupText", e.target.value)}
                        aria-invalid={p.followupText ? true : undefined}
                        aria-describedby={err("followupText")}
                        className="h-8 w-48 px-2 text-xs"
                      />
                      {message("followupText")}
                    </TableCell>
                    <TableCell className="pr-4 align-top">
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove row ${r.row}`} onClick={() => remove(r.row)}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow id={`mail-${r.row}`} className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={9} className="px-4">
                        <Label htmlFor={`mail-text-${r.row}`} className="mb-1.5">
                          Mail Text for row {r.row}
                        </Label>
                        <Textarea
                          id={`mail-text-${r.row}`}
                          value={r.mailText}
                          rows={8}
                          onChange={(e) => edit(r.row, "mailText", e.target.value)}
                          aria-invalid={p.mailText ? true : undefined}
                          aria-describedby={err("mailText")}
                          className="max-w-3xl text-[13px]"
                        />
                        {message("mailText")}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {error}

      <div className="flex items-center justify-between gap-3">
        <Button variant="outline" disabled={saving} onClick={onBack}>
          Back
        </Button>
        <Button disabled={!ready || saving} onClick={() => onSave({ name: name.trim(), rows })}>
          {saving && <Loader2 className="animate-spin" />}
          {saving ? "Saving…" : "Save to database"}
        </Button>
      </div>
    </div>
  );
}
