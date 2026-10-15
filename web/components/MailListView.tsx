"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCheck, ChevronLeft, ChevronRight, Inbox, Search, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatAbsolute, formatRelative, plural } from "@/lib/format";
import type { MailRow, MailsPage, MailTab, MessageKind } from "@/lib/types";
import { useMode } from "./AppShell";
import { MailChips } from "./MailChips";
import { Notice } from "./Notice";
import { OverdueBanner } from "./OverdueBanner";
import { PageHeader } from "./PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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

function When({ mail }: { mail: MailRow }) {
  const sent = mail.state === "sent";
  const at = sent ? (mail.sentAt ?? mail.scheduledFor) : mail.scheduledFor;
  const rel = formatRelative(at);
  const lead = sent ? "Sent" : mail.state === "sending" ? "Sending since" : mail.state === "needs_review" || mail.state === "failed" ? "Was due" : "Scheduled for";
  return (
    <div className="text-left sm:text-right">
      <div className="text-[13px] font-medium">
        {lead}
        {rel ? ` ${rel}` : ""}
      </div>
      <time className="text-xs text-muted-foreground tabular-nums" dateTime={new Date(at).toISOString()}>
        {formatAbsolute(at)}
      </time>
    </div>
  );
}

function MailItem({ mail, from }: { mail: MailRow; from: string }) {
  return (
    <li>
      <Link
        href={`/mail/${encodeURIComponent(mail.id)}?from=${encodeURIComponent(from)}`}
        className={cn(
          "group flex flex-col gap-2 px-4 py-3 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:ring-inset sm:flex-row sm:items-start sm:justify-between sm:gap-6",
          mail.overdue && "border-l-2 border-st-amber pl-3.5",
        )}
      >
        <div className="min-w-0 space-y-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium">{mail.contact.person}</span>
            <span className="truncate text-xs text-muted-foreground">{mail.contact.company}</span>
          </div>
          <div className="truncate text-[13px]">{mail.subject}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{mail.contact.email}</div>
          {mail.error && <div className="truncate text-xs text-destructive">{mail.error}</div>}
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 sm:items-end">
          <When mail={mail} />
          <MailChips mail={mail} />
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
  const backTo = listQueryString({ tab, q, kind, page });

  return (
    <div>
      <PageHeader
        title="Mail"
        description={
          <>
            What has gone out, and what will.
            {mode?.dryRun ? " Dry run: nothing is delivered." : ""}
          </>
        }
      />

      {tab === "scheduled" && <OverdueBanner className="mb-4" onRescheduled={reload} />}

      <div role="tablist" aria-label="Mail" className="mb-4 inline-flex max-w-full overflow-x-auto rounded-lg border bg-muted/50 p-0.5">
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
                "inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
                active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {n !== undefined && (
                <span
                  data-slot="tab-count"
                  className={cn("min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 tabular-nums", alert ? "bg-st-amber-bg text-st-amber" : "bg-muted text-muted-foreground")}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <form className="mb-4 flex flex-wrap items-end gap-3" role="search" onSubmit={(e) => (e.preventDefault(), setPage(1), setQ(search.trim()))}>
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="mail-q">Search</Label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input id="mail-q" type="search" maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, company, email or subject" className="pl-8" />
          </div>
        </div>
        <div className="w-44 space-y-1.5">
          <Label htmlFor="mail-kind">Type</Label>
          <NativeSelect
            id="mail-kind"
            value={kind}
            onChange={(e) => {
              setPage(1);
              setKind(e.target.value as MessageKind | "");
            }}
          >
            <option value="">All mail</option>
            <option value="initial">First emails</option>
            <option value="followup">Follow-ups</option>
          </NativeSelect>
        </div>
      </form>

      {error && (
        <Notice tone="danger" role="alert" className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={reload}>
              Retry
            </Button>
          </div>
        </Notice>
      )}

      <div role="tabpanel" id="mail-panel" aria-labelledby={`tab-${tab}`} className="rounded-lg border bg-card" aria-busy={loading}>
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
        ) : data && data.mails.length === 0 ? (
          <Empty
            tab={tab}
            filtered={filtered}
            onClear={() => {
              setSearch("");
              setQ("");
              setKind("");
              setPage(1);
            }}
          />
        ) : (
          data && (
            <ul aria-label={`${TABS.find((t) => t.key === tab)!.label} mail`} className={cn("divide-y", loading && "opacity-60")}>
              {data.mails.map((m) => (
                <MailItem key={m.id} mail={m} from={backTo} />
              ))}
            </ul>
          )
        )}

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
    </div>
  );
}
