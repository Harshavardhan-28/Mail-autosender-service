"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Dashboard } from "@/lib/types";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Skeleton } from "@/components/ui/skeleton";

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/** Analytics built only from what the dashboard endpoint already reports: totals and per-company stats. */
export function AnalyticsView() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getDashboard().then(
      (x) => live && setD(x),
      (err) => live && setError(err instanceof ApiError ? err.message : "Could not load analytics. Try again."),
    );
    return () => {
      live = false;
    };
  }, []);

  const header = <PageHeader eyebrow="Insights / Analytics" title="Analytics" description="How outreach is converting, from import to reply." />;
  if (error)
    return (
      <div className="mx-auto max-w-5xl">
        {header}
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      </div>
    );
  if (!d)
    return (
      <div className="mx-auto max-w-5xl">
        {header}
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );

  const t = d.totals;
  const imported = Object.values(t).reduce((a, b) => a + b, 0);
  const sentEver = t.sent + t.replied;
  const scheduledEver = t.scheduled + sentEver;
  const funnel = [
    { label: "Imported", v: imported, c: "#a7aab8", conv: "" },
    { label: "Scheduled", v: scheduledEver, c: "#6d78f0", conv: pct(scheduledEver, imported) },
    { label: "Sent", v: sentEver, c: "#4f5bd5", conv: pct(sentEver, scheduledEver) },
    { label: "Replied", v: t.replied, c: "#8e4ec6", conv: pct(t.replied, sentEver) },
  ];
  const kpis = [
    { l: "Emails sent", v: String(sentEver) },
    { l: "Reply rate", v: `${Math.round(d.repliedRate * 1000) / 10}%` },
    { l: "Bounced", v: String(t.bounced) },
    { l: "Opt-outs", v: String(t.opted_out) },
    { l: "Failed", v: String(t.failed) },
  ];
  const maxRate = Math.max(0.01, ...d.byCompany.map((c) => (c.sent > 0 ? c.replied / c.sent : 0)));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {header}
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-3 lg:grid-cols-5">
        {kpis.map((k) => (
          <div key={k.l} className="border-r border-b px-5 py-4 last:border-r-0">
            <p className="text-xs text-muted-foreground">{k.l}</p>
            <p className="mt-1 text-[26px] font-semibold tracking-tight">{k.v}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-[15px]">Funnel</h2>
          <p className="mt-0.5 mb-4 text-[12.5px] text-muted-foreground">From import to reply, all contacts</p>
          <div className="space-y-2">
            {funnel.map((f) => (
              <div key={f.label} className="flex items-center gap-3.5">
                <span className="w-20 text-[13px]">{f.label}</span>
                <div className="flex flex-1 justify-center">
                  <div
                    className="flex h-[38px] items-center justify-center rounded-lg text-[13px] font-semibold text-white"
                    style={{ width: `${Math.max(18, imported ? (f.v / imported) * 100 : 0)}%`, background: f.c }}
                  >
                    {f.v}
                  </div>
                </div>
                <span className="w-12 text-right text-xs text-muted-foreground">{f.conv}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-4 text-[15px]">Reply rate by company</h2>
          {d.byCompany.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No sends yet.</p>
          ) : (
            d.byCompany.map((c) => {
              const r = c.sent > 0 ? c.replied / c.sent : 0;
              return (
                <div key={c.company} className="grid grid-cols-[130px_minmax(0,1fr)_44px] items-center gap-3 py-1.5">
                  <span className="truncate text-[13px]">{c.company}</span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(r / maxRate) * 100}%` }} />
                  </div>
                  <b className="text-right text-[13px]">{Math.round(r * 100)}%</b>
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}
