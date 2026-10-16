"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Building2, CalendarClock, Check, ChevronLeft, ChevronRight, Layers, Loader2, MoreHorizontal, Paperclip, Search, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "@/lib/toast";
import { api, ApiError } from "@/lib/api";
import { checkSendTime, toLocalInputValue, MAX_DAYS_AHEAD } from "@/lib/schedule";
import { formatDateTime, plural, statusLabel } from "@/lib/format";
import { refusalText } from "@/lib/refusals";
import { CONTACT_STATUSES, type BatchSummary, type CompanyCount, type ContactListItem, type ContactStatus, type ContactsPage, type MessageRef, type Resume } from "@/lib/types";
import { useMode } from "./AppShell";
import { DeleteDialog, deleteContactsCopy } from "./DeleteDialog";
import { FollowupBulkBar } from "./FollowupBulkBar";
import { FollowupToggle } from "./FollowupToggle";
import { Notice } from "./Notice";
import { OverdueBanner } from "./OverdueBanner";
import { PageBody, PageHeader } from "./PageHeader";
import { hueClass, initials } from "./Dyn";
import { StatusBadge } from "./StatusBadge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const STATUS_DOT: Record<ContactStatus, string> = {
  uploaded: "bg-[#a7aab8]",
  scheduled: "bg-[#6d78f0]",
  sent: "bg-[#30a46c]",
  replied: "bg-[#b38cf0]",
  bounced: "bg-[#e5484d]",
  opted_out: "bg-[#7a7e8a]",
  failed: "bg-[#e5484d]",
};

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
    <div className="w-full max-w-56">
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

export function ContactsView({ initialBatchId, initialStatus, initialQ, initialCompany }: { initialBatchId?: string; initialStatus?: string; initialQ?: string; initialCompany?: string }) {
  const { mode } = useMode();
  const [status, setStatus] = useState<ContactStatus | "">(isStatus(initialStatus) ? initialStatus : "");
  const [batchId, setBatchId] = useState(initialBatchId ?? "");
  const [company, setCompany] = useState(initialCompany ?? "");
  const [companies, setCompanies] = useState<CompanyCount[]>([]);
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
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api.listBatches().then(setBatches, () => {});
  }, [tick]);

  useEffect(() => {
    api.listResumes().then(setResumes, () => {});
  }, []);

  // The company list follows the batch; a picked company the batch does not have is dropped.
  useEffect(() => {
    let live = true;
    api.listCompanies(batchId || undefined).then(
      (list = []) => {
        if (!live) return;
        setCompanies(list);
        // Page 1 already: the batch change that brings a new list resets paging.
        setCompany((c) => (c ? (list.find((x) => x.company.toLowerCase() === c.toLowerCase())?.company ?? "") : c));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [batchId, tick]);

  useEffect(() => {
    let live = true;
    api
      .listContacts({ status: status || undefined, q: q || undefined, batchId: batchId || undefined, company: company || undefined, page, pageSize: PAGE_SIZE })
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
  }, [status, q, batchId, company, page, tick]);

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentBatch = batches.find((b) => b.id === batchId);

  const counts = (currentBatch ? [currentBatch] : batches).reduce<Record<string, number>>((acc, b) => {
    for (const [k, v] of Object.entries(b.statusCounts)) acc[k] = (acc[k] ?? 0) + (v ?? 0);
    return acc;
  }, {});
  const grandTotal = (currentBatch ? [currentBatch] : batches).reduce((n, b) => n + b.contactCount, 0);
  const rows = data?.contacts ?? [];
  const selectedIds = rows.filter((c) => sel[c.id]).map((c) => c.id);
  const allOn = rows.length > 0 && rows.every((c) => sel[c.id]);
  const COLS = "grid-cols-[40px_minmax(200px,1.4fr)_minmax(150px,1fr)_120px_minmax(150px,1fr)_190px_190px_72px]";
  const CB = "grid size-4 place-items-center rounded-[4px] border-[1.5px] text-white transition-colors";

  return (
    <div>
      <PageHeader
        eyebrow="Workspace / Contacts"
        title="Contacts"
        description={
          <>
            {currentBatch ? `Batch “${currentBatch.name}” · ${plural(currentBatch.contactCount, "contact")}` : `${plural(grandTotal, "contact")} across ${plural(batches.length, "batch", "batches")}`}
            {mode?.dryRun ? " · dry run: nothing is delivered" : ""}
          </>
        }
        actions={
          <>
            {currentBatch && (currentBatch.statusCounts.uploaded ?? 0) > 0 && (
              <Button variant="outline" asChild>
                <Link href={`/batches/${encodeURIComponent(currentBatch.id)}`}>
                  <CalendarClock />
                  Schedule this batch
                </Link>
              </Button>
            )}
            {currentBatch && (
              <Button variant="outline" onClick={() => setDeletingBatch(true)}>
                <Trash2 />
                Delete batch
              </Button>
            )}
            <Button asChild>
              <Link href="/upload">
                <UserPlus />
                Import contacts
              </Link>
            </Button>
          </>
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
            setCompany("");
            setPage(1);
            window.history.replaceState(null, "", "/contacts");
            reload();
          }}
        />
      )}

      <PageBody className="flex flex-col gap-3.5 pt-[22px]">
        <OverdueBanner onRescheduled={reload} />

        <form
          className="flex flex-wrap items-center gap-2.5"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQ(search.trim());
          }}
        >
          <div className="flex h-9 min-w-70 flex-[1_1_280px] items-center gap-2 rounded-lg border border-input bg-card px-3 text-muted-foreground">
            <Search aria-hidden="true" className="size-3.5 shrink-0" />
            <input
              id="f-q"
              type="search"
              aria-label="Search"
              maxLength={200}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, company, role…"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="relative">
            <Layers aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <NativeSelect
              id="f-batch"
              aria-label="Batch"
              className="[&_select]:h-9 [&_select]:bg-card [&_select]:pl-9"
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
          <div className="relative">
            <Building2 aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <NativeSelect
              id="f-company"
              aria-label="Company"
              className="[&_select]:h-9 [&_select]:bg-card [&_select]:pl-9"
              value={company}
              onChange={(e) => {
                setPage(1);
                setCompany(e.target.value);
              }}
            >
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c.company} value={c.company}>
                  {c.company} ({c.count})
                </option>
              ))}
              {company && !companies.some((c) => c.company === company) && <option value={company}>{company}</option>}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline" className="h-9">
            Search
          </Button>
        </form>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
          {(["", ...CONTACT_STATUSES] as const).map((k) => {
            const on = status === k;
            const n = k === "" ? grandTotal : (counts[k] ?? 0);
            return (
              <button
                key={k || "all"}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setPage(1);
                  setStatus(k);
                }}
                className={cn(
                  "inline-flex h-[30px] items-center gap-[7px] rounded-full border px-[11px] text-[12.5px] font-medium whitespace-nowrap transition-colors",
                  on ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-accent",
                )}
              >
                {k !== "" && <span aria-hidden="true" className={cn("size-[7px] rounded-full", STATUS_DOT[k])} />}
                {k === "" ? "All" : statusLabel(k)}
                <span className="opacity-65">{n}</span>
              </button>
            );
          })}
        </div>

        {batchId && <FollowupBulkBar key={`${batchId}:${company}`} batchId={batchId} batchName={currentBatch?.name} company={company || undefined} onApplied={reload} />}

        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}

        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] bg-foreground px-3.5 py-2.5 text-[13px] text-background">
            <b className="font-semibold">{selectedIds.length} selected</b>
            <span className="flex-1" />
            <button type="button" onClick={() => setBulkDeleting(true)} className="inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-background/25 px-[11px] text-[12.5px] font-medium text-[#ff8f9a]">
              <Trash2 className="size-3.5" />
              Delete
            </button>
            <button type="button" onClick={() => setSel({})} className="h-[30px] px-2 text-[12.5px] font-medium opacity-70 hover:opacity-100">
              Clear
            </button>
          </div>
        )}
        <DeleteDialog
          open={bulkDeleting}
          onClose={() => setBulkDeleting(false)}
          {...deleteContactsCopy(selectedIds.length)}
          perform={(force) => api.deleteContacts(selectedIds, force)}
          onDeleted={() => {
            setSel({});
            reload();
          }}
        />

        <div className="overflow-x-auto rounded-[14px] border bg-card" aria-busy={loading}>
          <div className="min-w-[1080px]">
            <div className={cn("grid items-center gap-3 border-b bg-sidebar px-[18px] py-[11px] text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase", COLS)}>
              <button
                type="button"
                role="checkbox"
                aria-checked={allOn}
                aria-label="Select all on this page"
                onClick={() => setSel(allOn ? {} : Object.fromEntries(rows.map((c) => [c.id, true])))}
                className={cn(CB, allOn ? "border-primary bg-primary" : "border-[#c9cbd3] bg-card")}
              >
                {allOn && <Check className="size-[11px]" />}
              </button>
              <span>Recipient</span>
              <span>Company · role</span>
              <span>Status</span>
              <span>Latest mail</span>
              <span>Follow-up</span>
              <span>Resume</span>
              <span className="sr-only">Actions</span>
            </div>
            {!data &&
              loading &&
              [0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="space-y-1.5 border-b px-[18px] py-3">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-52" />
                </div>
              ))}
            {rows.map((c) => {
              const on = !!sel[c.id];
              const m = mailToView(c);
              return (
                <div key={c.id} className={cn("grid items-center gap-3 border-b px-[18px] py-3", COLS, on ? "bg-st-indigo-bg/50" : "bg-card")}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`Select ${c.email}`}
                    onClick={() => setSel({ ...sel, [c.id]: !on })}
                    className={cn(CB, on ? "border-primary bg-primary" : "border-[#c9cbd3] bg-card")}
                  >
                    {on && <Check className="size-[11px]" />}
                  </button>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn("grid size-8 shrink-0 place-items-center rounded-full text-xs font-[650] text-white", hueClass(c.company))}>{initials(c.person)}</span>
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-[550]">{c.person}</div>
                      <div className="truncate font-mono text-[11.5px] text-muted-foreground">{c.email}</div>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{c.company}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.role}</div>
                  </div>
                  <div className="min-w-0">
                    <StatusBadge status={c.status} className="h-auto py-[3px] text-[11.5px] font-semibold" />
                    {c.error && <div className="mt-1 text-xs text-destructive">{c.error}</div>}
                  </div>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="min-w-0 flex-1 text-[12.5px]">
                      {m ? (
                        <>
                          <div className="whitespace-nowrap">{m.kind === "followup" ? "Follow-up" : "First email"} {m.state.replace("_", " ")}</div>
                          <div className="text-[11.5px] whitespace-nowrap text-muted-foreground">{formatDateTime(m.sentAt ?? m.scheduledFor)}</div>
                        </>
                      ) : c.repliedAt ? (
                        <div className="whitespace-nowrap">Replied {formatDateTime(c.repliedAt)}</div>
                      ) : (
                        <div className="text-muted-foreground">Not scheduled yet</div>
                      )}
                    </div>
                    {m && (
                      <Link
                        href={`/mail/${encodeURIComponent(m.id)}`}
                        aria-label={`View mail for ${c.email}`}
                        className="shrink-0 rounded-md bg-st-indigo-bg px-[9px] py-1 text-xs font-semibold whitespace-nowrap text-st-indigo hover:underline"
                      >
                        View
                      </Link>
                    )}
                  </div>
                  <FollowupToggle
                    key={`${c.id}:${c.followupRequested}:${c.followupAt}`}
                    contact={c}
                    disabled={c.status === "replied" || c.status === "opted_out" || c.status === "bounced"}
                    onChange={reload}
                  />
                  <div className="min-w-0">
                    {resumes.length > 0 && (c.status === "uploaded" || c.status === "scheduled") && !c.messages.some((x) => x.kind === "initial" && x.state !== "scheduled") ? (
                      <ResumePick key={`${c.id}:${c.resumeId ?? ""}`} contact={c} resumes={resumes} onDone={reload} />
                    ) : null}
                    {c.attachment && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                        <span className="truncate">Attachment: {c.attachment.displayName}</span>
                      </div>
                    )}
                  </div>
                  <RowActions contact={c} onDone={reload} />
                </div>
              );
            })}
            {data && rows.length === 0 && (
              <div className="py-14 text-center">
                <Users aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="text-muted-foreground">No contacts match these filters. Clear the search or pick another status.</p>
              </div>
            )}
            <nav className="flex items-center justify-between gap-3 px-[18px] py-[11px]" aria-label="Pages">
              <span className="text-xs text-muted-foreground tabular-nums">{total ? `Showing ${from}–${to} of ${total} contacts` : ""}</span>
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
      </PageBody>
    </div>
  );
}
