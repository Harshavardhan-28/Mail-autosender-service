"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, Mail, MoreHorizontal, Paperclip, Search, Trash2, Users } from "lucide-react";
import { toast } from "@/lib/toast";
import { api, ApiError } from "@/lib/api";
import { checkSendTime, toLocalInputValue, MAX_DAYS_AHEAD } from "@/lib/schedule";
import { formatDateTime, plural, statusLabel } from "@/lib/format";
import { refusalText } from "@/lib/refusals";
import { CONTACT_STATUSES, type BatchSummary, type ContactListItem, type ContactStatus, type ContactsPage, type MessageRef, type Resume } from "@/lib/types";
import { useMode } from "./AppShell";
import { DeleteDialog, deleteContactsCopy } from "./DeleteDialog";
import { FollowupToggle } from "./FollowupToggle";
import { Notice } from "./Notice";
import { OverdueBanner } from "./OverdueBanner";
import { PageHeader } from "./PageHeader";
import { StatusBadge } from "./StatusBadge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 25;

const isStatus = (v: string | undefined): v is ContactStatus => !!v && (CONTACT_STATUSES as readonly string[]).includes(v);

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.refused?.[0] ? refusalText(err.refused[0].reason) : err.message;
  return "Something went wrong. Try again.";
}

type Confirm = "opt-out" | "replied" | null;

/** The mail to open from a contact row: what is pending next, else the latest that went out. */
function mailToView(c: ContactListItem): MessageRef | undefined {
  return c.messages.find((m) => m.state === "scheduled" || m.state === "sending" || m.state === "needs_review") ?? [...c.messages].reverse().find((m) => m.state === "sent") ?? c.messages[0];
}

function RowActions({ contact, onDone }: { contact: ContactListItem; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const initial = contact.messages.find((m) => m.kind === "initial");
  const canSchedule = (contact.status === "uploaded" || contact.status === "scheduled") && (!initial || initial.state === "scheduled");
  const closed = contact.status === "replied" || contact.status === "opted_out";
  const hasMenu = canSchedule || !closed || contact.status !== "opted_out";

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      setConfirm(null);
      if (done) toast.success(done);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const r = checkSendTime(when, new Date());
    if (r.error) return setError(r.error);
    void run(() => api.scheduleContact(contact.id, r.at!.toISOString()), "Send time saved");
  }

  const now = new Date();
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${contact.email}`} onClick={() => setDeleting(true)}>
        <Trash2 />
      </Button>
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${contact.email}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {canSchedule && (
              <DropdownMenuItem
                onSelect={() => {
                  setWhen(initial ? toLocalInputValue(new Date(initial.scheduledFor)) : "");
                  setError(null);
                  setEditing(true);
                }}
              >
                <CalendarClock />
                {initial ? "Reschedule" : "Schedule"}
              </DropdownMenuItem>
            )}
            {canSchedule && (!closed || contact.status !== "opted_out") && <DropdownMenuSeparator />}
            {!closed && <DropdownMenuItem onSelect={() => setConfirm("replied")}>Mark replied</DropdownMenuItem>}
            {contact.status !== "opted_out" && (
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("opt-out")}>
                Opt out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DeleteDialog open={deleting} onClose={() => setDeleting(false)} {...deleteContactsCopy(1)} perform={(force) => api.deleteContact(contact.id, force)} onDeleted={onDone} />

      <Dialog open={editing} onOpenChange={(o) => !o && setEditing(false)}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={save} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{initial ? "Reschedule" : "Schedule"} email</DialogTitle>
              <DialogDescription className="break-all">{contact.email}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor={`when-${contact.id}`}>New send time for {contact.email}</Label>
              <Input
                id={`when-${contact.id}`}
                type="datetime-local"
                value={when}
                min={toLocalInputValue(new Date(now.getTime() + 60_000))}
                max={toLocalInputValue(new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000))}
                onChange={(e) => setWhen(e.target.value)}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Keep
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "opt-out" ? "Opt out and stop all sends?" : "Mark as replied and cancel pending sends?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {contact.email}
              {confirm === "opt-out" ? " will not be emailed again." : " will be treated as having answered."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === "opt-out" ? "destructive" : "default"}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run(() => (confirm === "opt-out" ? api.optOut(contact.id) : api.markReplied(contact.id)), confirm === "opt-out" ? "Opted out" : "Marked as replied");
              }}
            >
              {confirm === "opt-out" ? "Opt out" : "Mark replied"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}

function ResumePick({ contact, resumes, onDone }: { contact: ContactListItem; resumes: Resume[]; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const def = resumes.find((r) => r.isDefault);
  async function change(value: string) {
    setBusy(true);
    setError(null);
    try {
      await api.setContactResume(contact.id, value || null);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-1.5 w-56 max-w-full">
      <label className="sr-only" htmlFor={`rs-${contact.id}`}>
        Resume for {contact.email}
      </label>
      <NativeSelect id={`rs-${contact.id}`} className="[&_select]:h-7 [&_select]:text-xs" value={contact.resumeId ?? ""} disabled={busy} onChange={(e) => change(e.target.value)}>
        <option value="">{def ? `Default (${def.displayName})` : "Default"}</option>
        {resumes.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </NativeSelect>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function ContactsView({ initialBatchId, initialStatus, initialQ }: { initialBatchId?: string; initialStatus?: string; initialQ?: string }) {
  const { mode } = useMode();
  const [status, setStatus] = useState<ContactStatus | "">(isStatus(initialStatus) ? initialStatus : "");
  const [batchId, setBatchId] = useState(initialBatchId ?? "");
  const [search, setSearch] = useState(initialQ ?? "");
  const [q, setQ] = useState(initialQ ?? "");
  const [page, setPage] = useState(1);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [data, setData] = useState<ContactsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api.listBatches().then(setBatches, () => {});
  }, [tick]);

  useEffect(() => {
    api.listResumes().then(setResumes, () => {});
  }, []);

  useEffect(() => {
    let live = true;
    api
      .listContacts({ status: status || undefined, q: q || undefined, batchId: batchId || undefined, page, pageSize: PAGE_SIZE })
      .then(
        (d) => {
          if (!live) return;
          setData(d);
          setError(null);
        },
        (err) => live && setError(describe(err)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [status, q, batchId, page, tick]);

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentBatch = batches.find((b) => b.id === batchId);

  return (
    <div>
      <PageHeader
        eyebrow="Workspace / Contacts"
        title="Contacts"
        description={
          <>
            {currentBatch ? `Batch “${currentBatch.name}” · ${plural(currentBatch.contactCount, "contact")}` : `All batches · ${plural(total, "contact")}`}
            {mode?.dryRun ? " · dry run: nothing is delivered" : ""}
          </>
        }
        actions={
          currentBatch && (
            <>
              {(currentBatch.statusCounts.uploaded ?? 0) > 0 && (
                <Button size="sm" asChild>
                  <Link href={`/batches/${encodeURIComponent(currentBatch.id)}`}>
                    <CalendarClock />
                    Schedule this batch
                  </Link>
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setDeletingBatch(true)}>
                <Trash2 />
                Delete batch
              </Button>
            </>
          )
        }
      />

      {currentBatch && (
        <DeleteDialog
          open={deletingBatch}
          onClose={() => setDeletingBatch(false)}
          title={`Delete batch “${currentBatch.name}”?`}
          description={`Its ${plural(currentBatch.contactCount, "contact")} will be removed and their scheduled emails cancelled.`}
          confirmLabel="Delete batch"
          successMessage={() => `Deleted batch “${currentBatch.name}”`}
          perform={(force) => api.deleteBatch(currentBatch.id, force)}
          onDeleted={() => {
            // Back to the unfiltered list (this view keeps the filter in state, so mirror it in the URL).
            setBatchId("");
            setPage(1);
            window.history.replaceState(null, "", "/contacts");
            reload();
          }}
        />
      )}

      <OverdueBanner className="mb-4" onRescheduled={reload} />

      <form
        className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[14rem_11rem_minmax(0,1fr)]"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(search.trim());
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="f-batch">Batch</Label>
          <NativeSelect
            id="f-batch"
            value={batchId}
            onChange={(e) => {
              setPage(1);
              setBatchId(e.target.value);
            }}
          >
            <option value="">All batches</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.contactCount})
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-status">Status</Label>
          <NativeSelect
            id="f-status"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as ContactStatus | "");
            }}
          >
            <option value="">Any status</option>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="f-q">Search</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input id="f-q" type="search" maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email, company, role or subject" className="pl-8" />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </div>
        </div>
      </form>

      {error && (
        <Notice tone="danger" role="alert" className="mb-4">
          {error}
        </Notice>
      )}

      <div className="rounded-lg border bg-card" aria-busy={loading}>
        <Table className="md:min-w-[48rem]">
          <caption className="sr-only">Contacts matching the filters</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent max-md:hidden">
              <TableHead className="pl-4">Recipient</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Follow-up</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="max-md:block">
            {!data &&
              loading &&
              [0, 1, 2, 3, 4].map((i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell className="pl-4 max-md:block">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-1.5 h-3 w-52" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-32" />
                  </TableCell>
                  <TableCell className="pr-4">
                    <Skeleton className="ml-auto h-7 w-7" />
                  </TableCell>
                </TableRow>
              ))}
            {data?.contacts.map((c) => (
              <TableRow key={c.id} className="relative align-top max-md:block max-md:py-3">
                <TableCell className="max-w-72 pl-4 max-md:block max-md:max-w-none max-md:py-1 max-md:pr-14">
                  <div className="truncate font-medium">{c.person}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{c.email}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.company} · {c.role}
                  </div>
                  {c.error && <div className="mt-1 text-xs text-destructive">{c.error}</div>}
                  {c.attachment && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate">Attachment: {c.attachment.displayName}</span>
                    </div>
                  )}
                  {resumes.length > 0 && (c.status === "uploaded" || c.status === "scheduled") && !c.messages.some((m) => m.kind === "initial" && m.state !== "scheduled") && (
                    <ResumePick key={`${c.id}:${c.resumeId ?? ""}`} contact={c} resumes={resumes} onDone={reload} />
                  )}
                </TableCell>
                <TableCell className="max-md:block max-md:px-4 max-md:py-1">
                  <StatusBadge status={c.status} />
                  {c.repliedAt && <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(c.repliedAt)}</div>}
                  {mailToView(c) && (
                    <Link
                      href={`/mail/${encodeURIComponent(mailToView(c)!.id)}`}
                      aria-label={`View mail for ${c.email}`}
                      className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-accent-text underline-offset-2 hover:underline"
                    >
                      <Mail aria-hidden="true" className="size-3" />
                      View mail
                    </Link>
                  )}
                </TableCell>
                <TableCell className="max-md:block max-md:px-4 max-md:py-1">
                  <FollowupToggle
                    key={`${c.id}:${c.followupRequested}:${c.followupDelayDays}`}
                    contact={c}
                    disabled={c.status === "replied" || c.status === "opted_out" || c.status === "bounced"}
                    onChange={reload}
                  />
                </TableCell>
                <TableCell className="pr-4 max-md:absolute max-md:top-2 max-md:right-2 max-md:p-0">
                  <RowActions contact={c} onDone={reload} />
                </TableCell>
              </TableRow>
            ))}
            {data && data.contacts.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-14 text-center whitespace-normal">
                  <Users aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="text-muted-foreground">No contacts match these filters. Clear the search or pick another status.</p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <nav className="flex items-center justify-between gap-3 border-t px-4 py-2.5" aria-label="Pages">
          <span className="text-xs text-muted-foreground tabular-nums">{total ? `${from}–${to} of ${total}` : ""}</span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
              Next
              <ChevronRight />
            </Button>
          </div>
        </nav>
      </div>
    </div>
  );
}
