"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CalendarClock, CheckCheck, ChevronLeft, ChevronRight, Inbox, RefreshCw, Search, TriangleAlert, Upload } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatAbsolute, formatRelative, plural } from "@/lib/format";
import type { MailRow, MailsPage, MailTab, MessageKind } from "@/lib/types";
import { useMode } from "./AppShell";
import { hueClass, initials } from "./Dyn";
import { kindName } from "./MailChips";
import { MailDetailView } from "./MailDetailView";
import { StatusBadge } from "./StatusBadge";
import { Notice } from "./Notice";
import { OverdueBanner } from "./OverdueBanner";
import { PageHeader } from "./PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;
const TABS: { key: MailTab; label: string; icon: typeof Inbox }[] = [
  { key: "scheduled", label: "Scheduled", icon: CalendarClock },
  { key: "sent", label: "Sent", icon: CheckCheck },
  { key: "attention", label: "Needs attention", icon: TriangleAlert },
];

export const isTab = (v: string | undefined): v is MailTab => v === "sent" || v === "scheduled" || v === "attention";
export const isKind = (v: string | undefined): v is MessageKind => v === "initial" || v === "followup";

/** The list's query string. The detail page carries it so "Back" returns to the same tab, search and page. */
export function listQueryString({ tab, q, kind, page }: { tab: MailTab; q: string; kind: MessageKind | ""; page: number }): string {
  const p = new URLSearchParams({ tab });
  if (q) p.set("q", q);
  if (kind) p.set("kind", kind);
  if (page > 1) p.set("page", String(page));
  return p.toString();
}

function describe(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

const LG = "(min-width: 1024px)";
function useDesktop() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(LG);
      m?.addEventListener?.("change", cb);
      return () => m?.removeEventListener?.("change", cb);
    },
    () => !!window.matchMedia?.(LG)?.matches,
    () => false,
  );
}

function MailItem({ mail, from, selected, onSelect }: { mail: MailRow; from: string; selected: boolean; onSelect?: () => void }) {
  const sent = mail.state === "sent";
  const at = sent ? (mail.sentAt ?? mail.scheduledFor) : mail.scheduledFor;
  const rel = formatRelative(at);
  const lead = sent ? "Sent" : mail.state === "sending" ? "Sending since" : mail.state === "needs_review" || mail.state === "failed" ? "Was due" : "Scheduled for";
  const c = mail.contact;
  return (
    <li>
      <Link
        href={`/mail/${encodeURIComponent(mail.id)}?from=${encodeURIComponent(from)}`}
        aria-current={selected ? "true" : undefined}
        onClick={(e) => {
          if (onSelect && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "flex gap-3 border-b px-[18px] py-3.5 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50",
          selected ? "bg-st-indigo-bg/60 shadow-[inset_3px_0_0_var(--primary)]" : "bg-card",
        )}
      >
        <span className={cn("grid size-[34px] shrink-0 place-items-center rounded-[9px] text-[13px] font-[650] text-white", hueClass(c.company))}>{initials(c.person)}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold">{c.person}</span>
            <span className="truncate text-xs whitespace-nowrap text-muted-foreground">{c.company}</span>
            <time className="ml-auto text-xs whitespace-nowrap text-muted-foreground" dateTime={new Date(at).toISOString()} title={formatAbsolute(at)}>
              {lead}
              {rel ? ` ${rel}` : ""}
            </time>
          </div>
          <div className="truncate text-[13px]">{mail.subject}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{c.email}</div>
          {mail.error && <div className="truncate text-xs text-destructive">{mail.error}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={mail.state} />
            <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">{kindName(mail.kind)}</span>
            {c.status === "replied" && <span className="rounded-md bg-st-violet-bg px-2 py-0.5 text-[11px] font-semibold text-st-violet">Replied</span>}
            {mail.overdue && <span className="rounded-md bg-st-amber-bg px-2 py-0.5 text-[11px] font-semibold text-st-amber">Overdue</span>}
            {mail.dryRun && <span className="rounded-md bg-st-neutral-bg px-2 py-0.5 text-[11px] font-medium text-st-neutral">Dry run</span>}
          </div>
        </div>
      </Link>
    </li>
  );
}

function Empty({ tab, filtered, onClear }: { tab: MailTab; filtered: boolean; onClear: () => void }) {
  if (filtered) {
    return (
      <div className="px-4 py-14 text-center">
        <Search aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
        <p className="text-[13px] text-muted-foreground">No mail matches these filters.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    );
  }
  const copy = {
    scheduled: { icon: CalendarClock, text: "Nothing is scheduled to go out.", cta: true },
    sent: { icon: CheckCheck, text: "Nothing has been sent yet.", cta: true },
    attention: { icon: TriangleAlert, text: "Nothing needs your attention.", cta: false },
  }[tab];
  const Icon = copy.icon;
  return (
    <div className="px-4 py-14 text-center">
      <Icon aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
      <p className="text-[13px] text-muted-foreground">{copy.text}</p>
      {copy.cta && (
        <Button size="sm" className="mt-3" asChild>
          <Link href="/upload">Upload a CSV</Link>
        </Button>
      )}
    </div>
  );
}

export function MailListView({ initialTab, initialQ = "", initialKind, initialPage = 1 }: { initialTab?: string; initialQ?: string; initialKind?: string; initialPage?: number }) {
  const { mode } = useMode();
  const [tab, setTab] = useState<MailTab>(isTab(initialTab) ? initialTab : "scheduled");
  // No tab in the URL: open on Scheduled, or on Sent when nothing is scheduled.
  const autoPick = useRef(!isTab(initialTab));
  const [search, setSearch] = useState(initialQ);
  const [q, setQ] = useState(initialQ);
  const [kind, setKind] = useState<MessageKind | "">(isKind(initialKind) ? initialKind : "");
  const [page, setPage] = useState(Math.max(1, initialPage));
  const [data, setData] = useState<MailsPage | null>(null);
  const [counts, setCounts] = useState<MailsPage["counts"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const desktop = useDesktop();
  const [selId, setSelId] = useState<string | null>(null);

  // Search as you type, after a short pause.
  useEffect(() => {
    if (search.trim() === q) return;
    const t = setTimeout(() => {
      setPage(1);
      setQ(search.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [search, q]);

  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the request starts here; this only flags it
    setLoading(true);
    api.listMails({ state: tab, kind: kind || undefined, q: q || undefined, page, pageSize: PAGE_SIZE }).then(
      (d) => {
        if (!live) return;
        setCounts(d.counts);
        if (autoPick.current) {
          autoPick.current = false;
          if (d.counts.scheduled === 0 && d.counts.sent > 0) {
            setTab("sent");
            return;
          }
        }
        setData(d);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (!live) return;
        setError(describe(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [tab, kind, q, page, tick]);

  // Keep the URL in step so a refresh or "Back" lands on the same view.
  useEffect(() => {
    if (autoPick.current) return;
    window.history.replaceState(null, "", `/mail?${listQueryString({ tab, q, kind, page })}`);
  }, [tab, q, kind, page]);

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = q !== "" || kind !== "";
  const visible = data ? data.mails : [];
  const backTo = listQueryString({ tab, q, kind, page });

  const selected = desktop ? (visible.find((m) => m.id === selId) ?? visible[0] ?? null) : null;
  const clearFilters = () => {
    setSearch("");
    setQ("");
    setKind("");
    setPage(1);
  };

  return (
    <div className="flex min-h-svh flex-col lg:h-svh">
      <PageHeader
        eyebrow="Workspace / Mail"
        title="Mail"
        description={mode?.dryRun ? "Dry run: nothing is delivered." : undefined}
        actions={
          <>
            <form
              className="flex h-9 min-w-44 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-3 text-[13px] text-muted-foreground sm:w-72 sm:flex-none"
              role="search"
              onSubmit={(e) => (e.preventDefault(), setPage(1), setQ(search.trim()))}
            >
              <Search aria-hidden="true" className="size-3.5 shrink-0" />
              <input
                type="search"
                aria-label="Search"
                maxLength={200}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, subject…"
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              />
            </form>
            <Button variant="outline" asChild>
              <Link href="/dashboard#replies">
                <RefreshCw />
                Check replies
              </Link>
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

      <div role="tablist" aria-label="Mail" className="flex items-center gap-1 overflow-x-auto border-b bg-card px-4 md:px-8">
        {TABS.map(({ key, label }) => {
          const active = tab === key;
          const n = counts?.[key];
          const alert = key === "attention" && (n ?? 0) > 0;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={active}
              aria-controls="mail-panel"
              onClick={() => {
                if (key === tab) return;
                autoPick.current = false;
                setPage(1);
                            setTab(key);
              }}
              className={cn(
                "-mb-px inline-flex items-center gap-2 border-b-2 px-3 pt-3 pb-[11px] text-[13.5px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:bg-accent",
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {n !== undefined && (
                <span
                  data-slot="tab-count"
                  className={cn("rounded-full px-[7px] text-[11px] leading-5 font-semibold tabular-nums", alert ? "bg-st-amber-bg text-st-amber" : active ? "bg-st-indigo-bg text-st-indigo" : "bg-secondary text-muted-foreground")}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b bg-sidebar px-4 py-3 md:px-8">
        <div role="group" aria-label="Type" className="flex shrink-0 gap-0.5 rounded-lg bg-accent p-0.5">
          {(
            [
              ["", "All types"],
              ["initial", "First emails"],
              ["followup", "Follow-ups"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => {
                setPage(1);
                setKind(k);
              }}
              className={cn("rounded-md px-[11px] py-[5px] text-[12.5px] font-medium whitespace-nowrap", kind === k ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "scheduled" && <OverdueBanner className="mx-4 mt-4 md:mx-8" onRescheduled={reload} />}

      {error && (
        <Notice tone="danger" role="alert" className="mx-4 mt-4 md:mx-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={reload}>
              Retry
            </Button>
          </div>
        </Notice>
      )}

      <div className="flex min-h-0 flex-1">
        <div role="tabpanel" id="mail-panel" aria-labelledby={`tab-${tab}`} aria-busy={loading} className="flex min-h-0 w-full min-w-0 flex-col border-r bg-card lg:w-[470px] lg:flex-none">
          <div className="flex justify-between border-b px-[18px] py-2.5 text-xs text-muted-foreground">
            <span>
              {visible.length} {visible.length === 1 ? "mail" : "mails"}
            </span>
            <span>Sorted by send time</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!data && loading ? (
              <ul aria-label="Loading mail" className="divide-y">
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i} className="space-y-1.5 px-4 py-3">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-72 max-w-full" />
                    <Skeleton className="h-3 w-40" />
                  </li>
                ))}
              </ul>
            ) : data && visible.length === 0 ? (
              <Empty tab={tab} filtered={filtered} onClear={clearFilters} />
            ) : (
              data && (
                <ul aria-label={`${TABS.find((t) => t.key === tab)!.label} mail`} className={cn(loading && "opacity-60")}>
                  {visible.map((m) => (
                    <MailItem key={m.id} mail={m} from={backTo} selected={selected?.id === m.id} onSelect={desktop ? () => setSelId(m.id) : undefined} />
                  ))}
                </ul>
              )
            )}
          </div>
          <nav className="flex items-center justify-between gap-3 border-t px-4 py-2.5" aria-label="Pages">
            <span className="text-xs text-muted-foreground tabular-nums">{total ? `${from}–${to} of ${plural(total, "mail", "mails")}` : ""}</span>
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
        {desktop && (
          <div className="min-w-0 flex-1 overflow-auto px-7 py-6">
            {selected ? <MailDetailView key={selected.id} id={selected.id} embedded onChanged={reload} /> : <p className="pt-20 text-center text-[13px] text-muted-foreground">Select a mail to see it here.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
