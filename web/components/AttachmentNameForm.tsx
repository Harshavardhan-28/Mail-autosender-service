"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { AttachmentNameInfo } from "@/lib/types";
import { Notice } from "./Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Same rule as the server: a typed .pdf is dropped; letters (with combining marks), digits, spaces and . _ - ( ) only.
function check(raw: string): { name: string; error?: string } {
  const name = raw.trim().replace(/\.pdf$/i, "").trim();
  if (!name) return { name, error: "Enter a file name." };
  if (name.length > 100) return { name, error: "At most 100 characters." };
  if (!/^[\p{L}\p{M}\p{N} ._()-]+$/u.test(name)) return { name, error: "Use letters, digits, spaces and . _ - ( ) only." };
  return { name };
}

/** The one file name every resume attachment is sent under, whatever the resume is called here. */
export function AttachmentNameForm() {
  const [info, setInfo] = useState<AttachmentNameInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getAttachmentName().then(
      (i) => {
        setInfo(i);
        setDraft(i.name);
      },
      (err) => setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not load the attachment name." }),
    );
  }, []);

  async function save(body: { name: string } | { reset: true }) {
    setBusy(true);
    try {
      const saved = await api.saveAttachmentName(body);
      setInfo(saved);
      setDraft(saved.name);
      setNote({ kind: "ok", text: `Saved. Resumes are sent as ${saved.fileName}.` });
    } catch (err) {
      setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not save the attachment name." });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = check(draft);
    if (v.error) return setNote({ kind: "err", text: v.error });
    setNote(null);
    void save({ name: v.name });
  }

  if (!info) return note ? <Notice tone="danger" role="alert">{note.text}</Notice> : null;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3 rounded-xl border bg-card p-5">
      <div>
        <Label htmlFor="attachment-name" className="text-[14px] font-semibold">
          File name in emails
        </Label>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          Every resume is attached under this name, whatever you call it below. Recruiters see{" "}
          <span className="inline-flex items-center gap-1 font-mono text-foreground">
            <Paperclip aria-hidden="true" className="size-3" />
            {info.fileName}
          </span>
          {info.source === "sender_name" && " (default, from your sender name)"}
          {info.source === "fallback" && " (default: no sender name is set on this server, so type your own name and Save)"}.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:max-w-md">
          <Input id="attachment-name" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
          <span className="font-mono text-[13px] text-muted-foreground">.pdf</span>
        </div>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Save
        </Button>
        {!info.isDefault && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void save({ reset: true })}>
            Use default
          </Button>
        )}
      </div>
      {note && (
        <Notice tone={note.kind === "ok" ? "success" : "danger"} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </Notice>
      )}
    </form>
  );
}
