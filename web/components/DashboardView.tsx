"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, CircleAlert, Inbox, Loader2, RefreshCw, Reply, Send, Upload, type LucideIcon } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { eventLabel, formatDateTime, formatDay, formatShort, formatTime, percent, plural, statusLabel } from "@/lib/format";
import type { ContactStatus, Dashboard, SweepResult } from "@/lib/types";
import { useMode } from "./AppShell";
import { Notice } from "./Notice";
import { OverdueBanner } from "./OverdueBanner";
import { Dyn, hueClass, initials } from "./Dyn";
import { PageBody, PageHeader } from "./PageHeader";
import { SendHoldBanner } from "./SendHoldBanner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";


function Empty({ icon: Icon, children }: { icon: typeof Inbox; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-8 text-center text-[13px] text-muted-foreground">
      <Icon aria-hidden="true" className="size-5" />
      <p>{children}</p>
    </div>
  );
}

function sweepSummary(r: SweepResult): string {
  if (r.skipped) return r.reason === "dry_run" ? "Skipped: dry run has no inbox to check." : "A check is already running.";
  if (r.error) return "The inbox check failed. See the status above.";
  return `Checked ${plural(r.checked ?? 0, "thread")}, found ${plural(r.replied ?? 0, "reply", "replies")}.`;
}

const CARD = "rounded-[14px] border bg-card";

function StatCard({ icon: Icon, tone, label, children, hint }: { icon: LucideIcon; tone: string; label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className={cn(CARD, "flex flex-col gap-2.5 px-[18px] py-4")}>
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
        <span className={cn("grid size-[26px] place-items-center rounded-[7px]", tone)}>
          <Icon aria-hidden="true" className="size-3.5" />
        </span>
        {label}
      </div>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

const Big = ({ children }: { children: React.ReactNode }) => <div className="text-[30px] leading-9 font-[650] tracking-[-0.02em] tabular-nums">{children}</div>;

const PIPE: { key: ContactStatus; bar: string }[] = [
  { key: "uploaded", bar: "bg-[#a7aab8]" },
  { key: "scheduled", bar: "bg-[#6d78f0]" },
  { key: "sent", bar: "bg-[#30a46c]" },
  { key: "replied", bar: "bg-[#b38cf0]" },
];

const EVENT_TONE: Record<string, { icon: LucideIcon; tone: string }> = {
  reply_detected: { icon: Reply, tone: "bg-st-violet-bg text-st-violet" },
  message_sent: { icon: Send, tone: "bg-st-green-bg text-st-green" },
  message_scheduled: { icon: CalendarClock, tone: "bg-st-indigo-bg text-st-indigo" },
  batch_imported: { icon: Upload, tone: "bg-st-neutral-bg text-st-neutral" },
};

function SectionCard({ id, title, action, children }: { id: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={cn(CARD, "px-5 py-[18px]")} aria-labelledby={id}>
      <div className="mb-2.5 flex items-center">
        <h2 id={id} className="flex-1 text-[15px] font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const linkCls = "text-[12.5px] font-semibold text-primary hover:underline";

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the dashboard">
      <PageHeader eyebrow="Workspace / Dashboard" title="Dashboard" description="Loading…" />
      <PageBody className="space-y-4">
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-[14px]" />
          ))}
        </div>
        <div className="grid gap-3.5 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-64 rounded-[14px]" />
          ))}
        </div>
      </PageBody>
    </div>
  );
}

export function DashboardView() {
  const { setMode } = useMode();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getDashboard().then(
      (d) => {
        setData(d);
        setError(null);
        setMode({ dryRun: d.dryRun, followupsHeld: d.followupsHeld });
      },
      (err) => setError(err instanceof ApiError ? err.message : "Could not load the dashboard."),
    );
  }, [setMode]);

  useEffect(() => {
    load();
  }, [load]);

  async function sweep() {
    setSweeping(true);
    setSweepNote(null);
    try {
      setSweepNote(sweepSummary(await api.runSweep()));
      load();
    } catch (err) {
      setSweepNote(err instanceof ApiError ? err.message : "Could not start the check.");
    } finally {
      setSweeping(false);
    }
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader eyebrow="Workspace / Dashboard" title="Dashboard" />
        <PageBody>
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        </PageBody>
      </div>
    );
  }
  if (!data) return <DashboardSkeleton />;

  const t = data.totals;
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  const pipeMax = Math.max(1, ...PIPE.map((p) => t[p.key]));
  const sw = data.sweep;
  const capRatio = data.dailyCap > 0 ? Math.min(100, (data.sentToday / data.dailyCap) * 100) : 0;
  const attention = t.failed + t.bounced;
  const next = data.upcoming[0];

  return (
    <div>
      <PageHeader
        eyebrow="Workspace / Dashboard"
        title="Dashboard"
        description={data.dryRun ? "Dry run: counts reflect simulated sends." : undefined}
        actions={
          <>
            <Button variant="outline" onClick={load}>
              <RefreshCw />
              Refresh
            </Button>
            <Button asChild>
              <Link href="/upload">
                <Upload />
                Upload CSV
              </Link>
            </Button>
          </>
        }
      />
      <PageBody className="flex flex-col gap-[18px]">
        {data.sendHold && <SendHoldBanner hold={data.sendHold} />}
        <OverdueBanner onRescheduled={load} />
        {attention > 0 && (
          <Link
            href="/mail?tab=attention"
            className="flex items-center gap-3 rounded-xl border border-st-amber/25 bg-st-amber-bg px-4 py-3 text-[13.5px] text-st-amber"
          >
            <CircleAlert aria-hidden="true" className="size-4" />
            <span className="flex-1 text-foreground">
              <b className="text-st-amber">{plural(attention, "contact")} need a look.</b> {t.failed} failed, {t.bounced} bounced.
            </span>
            <span className="flex items-center gap-1 font-semibold whitespace-nowrap">
              Review in Mail <ArrowRight className="size-3.5" />
            </span>
          </Link>
        )}

        <section className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="Today">
          <StatCard icon={Send} tone="bg-st-indigo-bg text-primary" label="Sent in the last 24 h">
            <div className="flex items-baseline gap-1.5">
              <Big>{data.sentToday}</Big>
              <span className="text-sm text-muted-foreground">/ {data.dailyCap} daily cap</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-[3px] bg-accent" role="img" aria-label={`${data.sentToday} of ${data.dailyCap} daily sends used`}>
              <Dyn w={capRatio} className={cn("h-full rounded-[3px]", capRatio >= 90 ? "bg-st-amber" : "bg-gradient-to-r from-[#6d78f0] to-[#4f5bd5]")} />
            </div>
          </StatCard>
          <StatCard icon={Reply} tone="bg-st-violet-bg text-st-violet" label="Reply rate" hint="of contacts whose first email was sent">
            <Big>{percent(data.repliedRate)}</Big>
          </StatCard>
          <StatCard
            icon={CalendarClock}
            tone="bg-[#e3f1fb] text-[#1b6aa5] dark:bg-[#10243a] dark:text-[#7fc0f0]"
            label="Waiting to send"
            hint={next ? `Next: ${formatShort(next.scheduledFor)} to ${next.person}` : "contacts scheduled"}
          >
            <Big>{t.scheduled}</Big>
          </StatCard>
          <StatCard
            icon={CircleAlert}
            tone="bg-st-red-bg text-st-red"
            label="Needs a look"
            hint={
              <>
                <Link href="/contacts?status=failed" className="text-primary hover:underline">
                  {t.failed} failed
                </Link>{" "}
                ·{" "}
                <Link href="/contacts?status=bounced" className="text-primary hover:underline">
                  {t.bounced} bounced
                </Link>
              </>
            }
          >
            <Big>{attention}</Big>
          </StatCard>
        </section>

        <div className="grid gap-3.5 lg:grid-cols-2">
          <SectionCard id="h-pipeline" title="Pipeline">
            <p className="-mt-2 mb-[18px] text-[12.5px] text-muted-foreground">Where every contact stands · {total} total</p>
            <div className="flex flex-col gap-3">
              {PIPE.map((p) => (
                <div key={p.key} className="grid grid-cols-[6rem_minmax(0,1fr)_2.75rem_2.9rem] items-center gap-3">
                  <span className="text-[13px]">{statusLabel(p.key)}</span>
                  <div className="h-[22px] overflow-hidden rounded-md bg-muted">
                    <Dyn w={(t[p.key] / pipeMax) * 100} className={cn("h-full rounded-md", p.bar)} />
                  </div>
                  <span className="text-right text-[13px] font-semibold tabular-nums">{t[p.key]}</span>
                  <span className="text-right text-xs text-muted-foreground tabular-nums">{total ? `${Math.round((t[p.key] / total) * 100)}%` : "—"}</span>
                </div>
              ))}
            </div>
            <div className="mt-[18px] flex flex-wrap items-center gap-2.5 border-t pt-3.5">
              <span className="mr-1 text-xs font-semibold text-muted-foreground">Stopped</span>
              <span className="rounded-full bg-st-red-bg px-2.5 py-0.5 text-xs font-medium text-st-red">Bounced {t.bounced}</span>
              <span className="rounded-full bg-st-neutral-bg px-2.5 py-0.5 text-xs font-medium text-st-neutral">Opted out {t.opted_out}</span>
              <span className="rounded-full bg-st-red-bg px-2.5 py-0.5 text-xs font-medium text-st-red">Failed {t.failed}</span>
            </div>
          </SectionCard>

          <SectionCard
            id="h-upcoming"
            title="Next sends"
            action={
              <Link href="/mail?tab=scheduled" className={linkCls}>
                View queue
              </Link>
            }
          >
            {data.upcoming.length === 0 ? (
              <Empty icon={CalendarClock}>
                Nothing scheduled.{" "}
                <Link href="/upload" className="font-medium text-accent-text underline-offset-2 hover:underline">
                  Upload a CSV
                </Link>{" "}
                to plan the next batch.
              </Empty>
            ) : (
              <ol>
                {data.upcoming.map((u) => {
                  const d = new Date(u.scheduledFor);
                  return (
                    <li key={u.messageId}>
                      <Link href={`/mail/${encodeURIComponent(u.messageId)}`} className="flex items-center gap-3 border-t py-2.5 first:border-t-0">
                        <time dateTime={d.toISOString()} className="w-[52px] shrink-0 rounded-lg border py-1 text-center">
                          <span className="block text-[10px] font-semibold text-muted-foreground uppercase">{formatDay(d).split(",")[0]}</span>
                          <span className="block text-[13px] font-semibold">{formatTime(d)}</span>
                        </time>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-[550]">{u.person}</div>
                          <div className="truncate font-mono text-[11.5px] text-muted-foreground">{u.email}</div>
                        </div>
                        <span
                          className={cn(
                            "max-w-32 truncate rounded-md px-2 py-0.5 text-[11.5px] font-medium",
                            u.kind === "followup" ? "bg-st-violet-bg text-st-violet" : "bg-secondary text-secondary-foreground",
                          )}
                        >
                          {u.kind === "followup" ? "Follow-up" : u.company}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </SectionCard>
        </div>

        <div className="grid gap-3.5 lg:grid-cols-2">
          <SectionCard
            id="h-companies"
            title="Top companies"
            action={
              <Link href="/analytics" className={linkCls}>
                All companies
              </Link>
            }
          >
            {data.byCompany.length === 0 ? (
              <Empty icon={Inbox}>No contacts yet.</Empty>
            ) : (
              <>
                <div className="grid grid-cols-[minmax(0,1fr)_3.4rem_3.4rem_3.6rem] gap-2 py-1.5 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
                  <span>Company</span>
                  <span className="text-right">Sent</span>
                  <span className="text-right">Replied</span>
                  <span className="text-right">Rate</span>
                </div>
                {data.byCompany.map((c) => {
                  const rate = c.sent > 0 ? (c.replied / c.sent) * 100 : 0;
                  return (
                    <div key={c.company} className="grid grid-cols-[minmax(0,1fr)_3.4rem_3.4rem_3.6rem] items-center gap-2 border-t py-[9px] text-[13px]">
                      <div className="flex min-w-0 items-center gap-[9px]">
                        <span className={cn("grid size-6 shrink-0 place-items-center rounded-[7px] text-[11px] font-[650] text-white", hueClass(c.company))}>{initials(c.company)}</span>
                        <span className="truncate font-medium">{c.company}</span>
                      </div>
                      <span className="text-right tabular-nums">{c.sent}</span>
                      <span className="text-right tabular-nums">{c.replied}</span>
                      <span className={cn("text-right font-semibold tabular-nums", rate >= 20 ? "text-st-green" : rate >= 12 ? "text-st-indigo" : "text-st-amber")}>
                        {c.sent > 0 ? `${Math.round(rate)}%` : "—"}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </SectionCard>

          <SectionCard id="h-events" title="Recent activity">
            {data.recentEvents.length === 0 ? (
              <Empty icon={Inbox}>No activity yet.</Empty>
            ) : (
              <ol className="max-h-96 overflow-y-auto">
                {data.recentEvents.map((e) => {
                  const tone = EVENT_TONE[e.type] ?? { icon: Inbox, tone: "bg-st-neutral-bg text-st-neutral" };
                  const Icon = tone.icon;
                  const label = eventLabel(e.type);
                  return (
                    <li key={e.id} className="flex gap-3 border-t py-[9px] first:border-t-0">
                      <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", tone.tone)}>
                        <Icon aria-hidden="true" className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        {typeof e.meta?.messageId === "string" && e.type !== "message_cancelled" ? (
                          <Link href={`/mail/${encodeURIComponent(e.meta.messageId)}`} className="text-[13px] font-medium hover:underline">
                            {label}
                          </Link>
                        ) : (
                          <div className="text-[13px] font-medium">{label}</div>
                        )}
                        {e.email && <div className="truncate font-mono text-[11.5px] text-muted-foreground">{e.email}</div>}
                      </div>
                      <time className="text-[11.5px] whitespace-nowrap text-muted-foreground" dateTime={e.at}>
                        {formatShort(e.at)}
                      </time>
                    </li>
                  );
                })}
              </ol>
            )}
          </SectionCard>
        </div>

        <section id="replies" aria-labelledby="h-replies" className={cn(CARD, "flex scroll-mt-20 flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4")}>
          <div className="flex min-w-60 flex-1 items-center gap-2.5">
            <span className="grid size-[34px] place-items-center rounded-[9px] bg-st-green-bg text-st-green">
              <Inbox aria-hidden="true" className="size-4" />
            </span>
            <div>
              <h2 id="h-replies" className="text-sm font-semibold">
                Reply checks
              </h2>
              <p className="text-[12.5px] text-muted-foreground">The inbox is scanned for replies so follow-ups stop on their own.</p>
            </div>
          </div>
          {sw ? (
            <>
              <div>
                <div className="text-[11.5px] text-muted-foreground">Last check</div>
                <div className="text-[13px] font-medium">
                  {formatDateTime(sw.at)} · <span className={sw.ok ? "text-st-green" : "text-st-red"}>{sw.ok ? "succeeded" : `failed${sw.errorCode ? ` (${sw.errorCode})` : ""}`}</span>
                </div>
              </div>
              <div>
                <div className="text-[11.5px] text-muted-foreground">Last success</div>
                <div className="text-[13px] font-medium">{formatDateTime(sw.lastSuccessAt)}</div>
              </div>
              <div>
                <div className="text-[11.5px] text-muted-foreground">Rows with errors</div>
                <div className="font-mono text-[13px] font-medium">{sw.rowErrors}</div>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">{data.dryRun ? "Reply checks don't run in dry run." : "No reply check has run yet."}</p>
          )}
          <Button variant="outline" onClick={sweep} disabled={sweeping}>
            {sweeping ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {sweeping ? "Checking…" : "Check replies now"}
          </Button>
          {data.followupsHeld && (
            <div className="basis-full">
              <Notice tone="warning">
                <p>Follow-ups are on hold until a reply check succeeds. First emails are not affected.</p>
              </Notice>
            </div>
          )}
          {sweepNote && (
            <p className="basis-full text-[13px] text-muted-foreground" role="status">
              {sweepNote}
            </p>
          )}
        </section>
      </PageBody>
    </div>
  );
}
