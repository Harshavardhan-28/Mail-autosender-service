"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Paperclip, TriangleAlert, User } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { eventDetail, eventLabel, formatAbsolute, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MailDetail, MailEvent } from "@/lib/types";
import { EmailLetter } from "./EmailLetter";
import { kindName, MailChips } from "./MailChips";
import { Notice } from "./Notice";
import { PageBody, PageHeader } from "./PageHeader";
import { ResolveDialog } from "./ResolveDialog";
import { StatusBadge } from "./StatusBadge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-2 text-[13px] first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Timeline({ events }: { events: MailEvent[] }) {
  if (events.length === 0) return <p className="text-[13px] text-muted-foreground">No activity recorded for this mail yet.</p>;
  return (
    <ol aria-label="Timeline" className="relative space-y-4 border-l pl-5">
      {events.map((e, i) => {
        const detail = eventDetail(e.type, e.meta);
        return (
          <li key={`${e.type}-${e.at}-${i}`} className="relative">
            <span aria-hidden="true" className="absolute top-1.5 -left-[1.6rem] size-2 rounded-full bg-muted-foreground/60 ring-4 ring-background" />
            <div className="text-[13px] font-medium">{eventLabel(e.type)}</div>
            {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
            <time className="text-xs text-muted-foreground tabular-nums" dateTime={e.at}>
              {formatAbsolute(e.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

export function MailDetailView({ id, backQuery = "", embedded = false, onChanged }: { id: string; backQuery?: string; embedded?: boolean; onChanged?: () => void }) {
  const router = useRouter();
  const [mail, setMail] = useState<MailDetail | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const backHref = `/mail${backQuery ? `?${backQuery}` : ""}`;

  useEffect(() => {
    let live = true;
    api.getMail(id).then(
      (m) => {
        if (!live) return;
        setMail(m);
        setError(null);
      },
      (err) => live && setError({ message: err instanceof ApiError ? err.message : "Something went wrong. Try again.", notFound: err instanceof ApiError && err.status === 404 }),
    );
    return () => {
      live = false;
    };
  }, [id, tick]);

  async function cancel() {
    if (!mail) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelMessage(mail.id);
      toast.success(`${kindName(mail.kind)} cancelled`);
      setConfirmCancel(false);
      if (embedded) onChanged?.();
      else router.push(backHref);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <Link href={backHref} className="inline-flex items-center gap-1.5 rounded-sm text-[13px] font-medium text-accent-text underline-offset-2 hover:underline">
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      All mail
    </Link>
  );

  if (error && !mail) {
    return (
      <div className={embedded ? "p-6" : undefined}>
        {!embedded && back}
        <Notice tone="danger" role="alert" title={error.notFound ? "This mail no longer exists" : "Could not load this mail"}>
          <p>{error.notFound ? "It may have been cancelled, or its contact deleted." : error.message}</p>
          {!error.notFound && (
            <Button size="sm" variant="outline" className="mt-2" onClick={reload}>
              Retry
            </Button>
          )}
        </Notice>
      </div>
    );
  }

  if (!mail) {
    return (
      <div aria-busy="true" className={embedded ? "p-6" : undefined}>
        {!embedded && back}
        <Skeleton className="mb-2 h-6 w-80 max-w-full" />
        <Skeleton className="mb-6 h-4 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const sent = mail.state === "sent";
  const at = sent ? (mail.sentAt ?? mail.scheduledFor) : mail.scheduledFor;
  const rel = formatRelative(at);
  const timeLabel = sent ? "Sent" : mail.state === "needs_review" || mail.state === "failed" ? "Was due" : "Scheduled for";
  const c = mail.contact;
  const contactHref = `/contacts?batchId=${encodeURIComponent(mail.batch.id)}&q=${encodeURIComponent(c.email)}`;

  const dialogs = (
    <>
      <AlertDialog open={confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this send?</AlertDialogTitle>
            <AlertDialogDescription>
              {mail.kind === "followup" ? "The follow-up" : "The email"} to {c.email} will not be sent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && <p className="text-xs text-destructive">{actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void cancel();
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              Cancel send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ResolveDialog
        open={resolving}
        onClose={() => setResolving(false)}
        messageId={mail.id}
        kindLabel={kindName(mail.kind)}
        email={c.email}
        onResolved={(action) => {
          setResolving(false);
          if (action === "cancel" && !embedded) router.push(backHref);
          else if (embedded) {
            reload();
            onChanged?.();
          } else reload();
        }}
      />
    </>
  );

  if (embedded) {
    const ST_DOT: Record<string, string> = { sent: "bg-[#30a46c]", reply_detected: "bg-[#8e4ec6]", failed: "bg-[#e5484d]", needs_review: "bg-[#e5484d]" };
    const meta: { k: string; v: React.ReactNode; sub?: string }[] = [
      { k: "To", v: c.person, sub: c.email },
      { k: "Company", v: c.company, sub: c.role },
      { k: timeLabel, v: rel ?? formatAbsolute(at), sub: formatAbsolute(at) },
      { k: "Batch", v: mail.batch.name, sub: "CSV import" },
      { k: "Attachment", v: mail.attachment?.displayName ?? "None", sub: mail.kind === "followup" ? "Not attached to follow-ups" : undefined },
      { k: "Attempts", v: String(mail.attempts), sub: mail.attempts > 1 ? "retried" : "—" },
      { k: "Follow-up", v: mail.related ? (mail.related.kind === "followup" ? "Queued" : "This is the follow-up") : "None", sub: "if no reply" },
      { k: "Mode", v: mail.dryRun ? "Dry run" : "Live", sub: mail.dryRun ? "not delivered" : "delivered via SMTP" },
    ];
    return (
      <div className="flex flex-col gap-[18px]">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={mail.state} />
              <MailChips mail={mail} />
            </div>
            <h2 className="text-xl leading-7 font-[650] tracking-[-0.015em] text-pretty">{mail.subject}</h2>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {mail.state === "needs_review" && (
              <Button size="sm" variant="outline" className="border-st-amber/40 text-st-amber hover:bg-st-amber-bg hover:text-st-amber" onClick={() => setResolving(true)}>
                <TriangleAlert />
                Resolve
              </Button>
            )}
            {mail.state === "scheduled" && (
              <Button size="sm" variant="outline" onClick={() => (setActionError(null), setConfirmCancel(true))}>
                Cancel send
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link href={contactHref}>
                <User />
                Open contact
              </Link>
            </Button>
          </div>
        </div>
        {mail.state === "needs_review" && (
          <Notice tone="warning" title="Delivery unknown">
            <p>The send was interrupted, so it is unclear whether this went out. Check your Sent folder, then use Resolve to record what happened.</p>
          </Notice>
        )}
        {mail.error && (
          <div className="flex gap-2.5 rounded-[10px] bg-st-red-bg px-3.5 py-3 text-[13px] text-st-red" role="alert">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div>
              <b>Delivery problem.</b> {mail.error}
            </div>
          </div>
        )}
        <dl className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card lg:grid-cols-4">
          {meta.map((f) => (
            <div key={f.k} className="min-w-0 border-r border-b px-4 py-3">
              <dt className="mb-0.5 text-[11.5px] text-muted-foreground">{f.k}</dt>
              <dd className="truncate text-[13px] font-medium">{f.v}</dd>
              {f.sub && <dd className="truncate font-mono text-[11.5px] text-muted-foreground">{f.sub}</dd>}
            </div>
          ))}
        </dl>
        <div className="grid items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_260px]">
          <article aria-label="Email" className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b px-[18px] py-3 text-[12.5px] text-muted-foreground">
              Exactly as it {sent ? "was" : "will be"} sent
              {mail.attachment && (
                <span className="ml-auto flex items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 font-medium text-foreground">
                  <Paperclip aria-hidden="true" className="size-3.5" />
                  {mail.attachment.displayName}
                </span>
              )}
            </div>
            <div className="px-[22px] py-5 text-sm leading-[1.65] whitespace-pre-wrap text-foreground">{mail.body}</div>
          </article>
          <div className="flex flex-col gap-3.5">
            <section aria-labelledby="h-timeline" className="rounded-xl border bg-card px-4 py-3.5">
              <h3 id="h-timeline" className="mb-3 text-[12.5px] font-semibold">
                Timeline
              </h3>
              {mail.timeline.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No activity recorded for this mail yet.</p>
              ) : (
                <ol aria-label="Timeline">
                  {mail.timeline.map((e, i) => (
                    <li key={`${e.type}-${e.at}-${i}`} className="flex gap-2.5 pb-3 last:pb-0">
                      <span aria-hidden="true" className={cn("mt-1 size-[9px] shrink-0 rounded-full", ST_DOT[e.type] ?? "bg-[#5e6ad2]")} />
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium">{eventLabel(e.type)}</div>
                        <time dateTime={e.at} className="font-mono text-[11.5px] text-muted-foreground">
                          {formatAbsolute(e.at)}
                        </time>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            {mail.related && (
              <section className="rounded-xl border bg-card px-4 py-3.5">
                <h3 className="mb-2 text-[12.5px] font-semibold">In this thread</h3>
                <p className="text-[12.5px] leading-normal text-muted-foreground">
                  {mail.kind === "followup" ? "Threaded under the first email. Goes out only if there is no reply." : "A follow-up is queued and is cancelled automatically if they reply."}
                </p>
                <Link href={`/mail/${encodeURIComponent(mail.related.id)}`} className="mt-1.5 inline-block text-[12.5px] font-medium text-primary hover:underline">
                  {mail.related.kind === "followup" ? "View the follow-up" : "View the first email"}
                </Link>
              </section>
            )}
          </div>
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={back}
        title={mail.subject}
        description={<span className="inline-flex flex-wrap items-center gap-2">{kindName(mail.kind)} to {c.person}</span>}
        actions={
          <>
            {mail.state === "needs_review" && (
              <Button size="sm" variant="outline" className="border-st-amber/40 text-st-amber hover:bg-st-amber-bg hover:text-st-amber" onClick={() => setResolving(true)}>
                <TriangleAlert />
                Resolve
              </Button>
            )}
            {mail.state === "scheduled" && (
              <Button size="sm" variant="outline" onClick={() => (setActionError(null), setConfirmCancel(true))}>
                Cancel send
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link href={contactHref}>
                <User />
                Open contact
              </Link>
            </Button>
          </>
        }
      />
      <PageBody>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <StatusBadge status={mail.state} />
        <MailChips mail={mail} />
      </div>

      {mail.state === "needs_review" && (
        <Notice tone="warning" title="Delivery unknown" className="mb-6">
          <p>The send was interrupted, so it is unclear whether this went out. Check your Sent folder, then use Resolve to record what happened.</p>
        </Notice>
      )}
      {mail.overdue && (
        <Notice tone="warning" title="Overdue" className="mb-6">
          <p>This was due {formatRelative(mail.scheduledFor) ?? formatAbsolute(mail.scheduledFor)} but has not gone out. The send window may have closed.</p>
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <EmailLetter label="Email" to={c.email} subject={mail.subject} attachment={mail.attachment?.displayName ?? null} body={mail.body} />
          <section aria-labelledby="h-timeline" className="rounded-lg border bg-card p-4">
            <h2 id="h-timeline" className="mb-3 text-sm font-medium">
              Timeline
            </h2>
            <Timeline events={mail.timeline} />
          </section>
        </div>

        <section aria-labelledby="h-summary" className="h-fit rounded-lg border bg-card p-4">
          <h2 id="h-summary" className="mb-3 text-sm font-medium">
            Details
          </h2>
          <dl className="divide-y [&>div]:border-0">
            <Row label="To">
              <span className="font-medium">{c.person}</span>
              <span className="block font-mono text-xs text-muted-foreground">{c.email}</span>
            </Row>
            <Row label="Company">
              {c.company}
              <span className="block text-xs text-muted-foreground">{c.role}</span>
            </Row>
            <Row label="Batch">
              <Link href={`/contacts?batchId=${encodeURIComponent(mail.batch.id)}`} className="text-accent-text underline-offset-2 hover:underline">
                {mail.batch.name}
              </Link>
            </Row>
            <Row label={timeLabel}>
              {rel && <span className="block font-medium">{rel}</span>}
              <time dateTime={new Date(at).toISOString()} className="text-xs text-muted-foreground tabular-nums">
                {formatAbsolute(at)}
              </time>
            </Row>
            <Row label="Attempts">{mail.attempts}</Row>
            {mail.error && (
              <Row label="Error">
                <span className="text-destructive">{mail.error}</span>
              </Row>
            )}
            <Row label="Message-ID">{mail.messageId ? <span className="font-mono text-xs break-all">{mail.messageId}</span> : <span className="text-muted-foreground">Not assigned yet</span>}</Row>
            <Row label="Attachment">{mail.attachment ? mail.attachment.displayName : <span className="text-muted-foreground">None</span>}</Row>
            {mail.related && (
              <Row label="Related">
                <Link href={`/mail/${encodeURIComponent(mail.related.id)}${backQuery ? `?from=${encodeURIComponent(backQuery)}` : ""}`} className="text-accent-text underline-offset-2 hover:underline">
                  {mail.related.kind === "followup" ? "View the follow-up" : "View the first email"}
                </Link>
              </Row>
            )}
          </dl>
        </section>
      </div>

      {dialogs}
      </PageBody>
    </div>
  );
}
