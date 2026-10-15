"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { fillTemplate, PLACEHOLDERS, validateTemplate } from "@/lib/template";
import type { Dashboard, FollowupTemplate } from "@/lib/types";
import { SendWindowForm } from "./SendWindowForm";
import { Clock, Loader2, Palette, Send, Shield, Type, type LucideIcon } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import type { ThemePref } from "@/lib/theme";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmailLetter } from "./EmailLetter";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { SendHoldBanner } from "./SendHoldBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE = { person: "Aisha Rao", role: "Software Engineer Intern", company: "Northwind Labs", subject: "Software Engineer Intern role at Northwind Labs" };

function TemplateForm() {
  const [tpl, setTpl] = useState<FollowupTemplate | null>(null);
  const [errors, setErrors] = useState<{ subject?: string; body?: string }>({});
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getFollowupTemplate().then(setTpl, (err) => setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not load the template." }));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!tpl) return;
    const v = validateTemplate(tpl);
    setErrors(v);
    setNote(null);
    if (v.subject || v.body) return;
    setBusy(true);
    try {
      setTpl(await api.saveFollowupTemplate({ subject: tpl.subject.trim(), body: tpl.body }));
      setNote({ kind: "ok", text: "Template saved. New follow-ups use it; already-sent ones are unchanged." });
    } catch (err) {
      setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not save the template." });
    } finally {
      setBusy(false);
    }
  }

  if (!tpl) return <p className="text-[13px] text-muted-foreground">{note?.text ?? "Loading…"}</p>;

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="tpl-subject">Subject</Label>
        <Input
          id="tpl-subject"
          maxLength={200}
          value={tpl.subject}
          onChange={(e) => setTpl({ ...tpl, subject: e.target.value })}
          aria-invalid={errors.subject ? true : undefined}
          aria-describedby={errors.subject ? "tpl-subject-err" : undefined}
        />
        {errors.subject && (
          <p className="text-xs text-destructive" id="tpl-subject-err">
            {errors.subject}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tpl-body">Text</Label>
        <Textarea
          id="tpl-body"
          rows={9}
          maxLength={5000}
          value={tpl.body}
          onChange={(e) => setTpl({ ...tpl, body: e.target.value })}
          aria-invalid={errors.body ? true : undefined}
          aria-describedby={`tpl-help${errors.body ? " tpl-body-err" : ""}`}
          className="font-mono text-xs leading-5"
        />
        {errors.body && (
          <p className="text-xs text-destructive" id="tpl-body-err">
            {errors.body}
          </p>
        )}
      </div>
      <div className="space-y-2 rounded-lg border bg-muted/40 p-3" id="tpl-help">
        <p className="text-xs text-muted-foreground">Placeholders. A contact&apos;s own Follow-up Text column, when filled, replaces this text.</p>
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {PLACEHOLDERS.map((p) => (
            <div key={p.name} className="contents">
              <dt className="font-mono text-xs text-accent-text">{`{{${p.name}}}`}</dt>
              <dd className="text-xs text-muted-foreground">{p.help}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Preview with a sample contact</p>
        <EmailLetter label="Preview with a sample contact" subject={fillTemplate(tpl.subject, SAMPLE).replace(/[\r\n]+/g, " ")} body={fillTemplate(tpl.body, SAMPLE)} />
      </div>
      {note && (
        <Notice tone={note.kind === "ok" ? "success" : "danger"} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Saving…" : "Save template"}
        </Button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    if (!current) return setNote({ kind: "err", text: "Enter your current password." });
    if (next.length < 10) return setNote({ kind: "err", text: "New password must be at least 10 characters." });
    if (next === current) return setNote({ kind: "err", text: "New password must differ from the current one." });
    if (next !== confirm) return setNote({ kind: "err", text: "The two new passwords don't match." });
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setNote({ kind: "ok", text: "Password changed. Other signed-in sessions were signed out." });
    } catch (err) {
      setCurrent("");
      setNote({ kind: "err", text: err instanceof ApiError && err.status === 400 ? err.message : "Could not change the password. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {/* Lets password managers associate the change with the account. */}
      <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
      <div className="space-y-1.5">
        <Label htmlFor="pw-current">Current password</Label>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pw-new">New password</Label>
        <Input id="pw-new" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-hint" />
        <p className="text-xs text-muted-foreground" id="pw-hint">
          At least 10 characters.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pw-confirm">Repeat new password</Label>
        <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {note && (
        <Notice tone={note.kind === "ok" ? "success" : "danger"} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

function SendStatus() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.getDashboard().then(setD, () => setFailed(true));
  }, []);
  if (failed) return <p className="text-[13px] text-muted-foreground">Could not load the sending status.</p>;
  if (!d) return <Skeleton className="h-20 w-full" />;
  const row = "flex items-center justify-between gap-4 py-2.5 text-[13px]";
  return (
    <div className="space-y-4">
      <dl className="divide-y">
        <div className={row}>
          <dt className="text-muted-foreground">Mode</dt>
          <dd>
            <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium", d.dryRun ? "bg-st-amber-bg text-st-amber" : "bg-st-green-bg text-st-green")}>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              {d.dryRun ? "Dry run" : "Live sending"}
            </span>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Sent in the last 24 h</dt>
          <dd className="tabular-nums">
            {d.sentToday} <span className="text-muted-foreground">of {d.dailyCap}</span>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Follow-ups</dt>
          <dd>{d.followupsHeld ? <span className="font-medium text-st-amber">On hold</span> : "Sending"}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Last reply check</dt>
          <dd>{d.sweep ? `${formatDateTime(d.sweep.at)} · ${d.sweep.ok ? "succeeded" : "failed"}` : d.dryRun ? "Not run in dry run" : "Not run yet"}</dd>
        </div>
      </dl>
      {d.sendHold && <SendHoldBanner hold={d.sendHold} />}
    </div>
  );
}

const TABS: { key: string; label: string; icon: LucideIcon; title: string; description: string }[] = [
  { key: "sending", label: "Sending", icon: Send, title: "Sending", description: "The server's current mode and limits." },
  { key: "window", label: "Send window", icon: Clock, title: "Send window", description: "The daily hours in which real emails go out." },
  { key: "template", label: "Follow-up template", icon: Type, title: "Follow-up template", description: "Used for follow-ups when a contact has no text of its own." },
  { key: "appearance", label: "Appearance", icon: Palette, title: "Appearance", description: "Choose how Outbox looks on this device." },
  { key: "account", label: "Account", icon: Shield, title: "Account", description: "Change your password. Other signed-in sessions are signed out." },
];

const THEMES: { value: ThemePref; label: string; bg: string; side: string; line: string }[] = [
  { value: "light", label: "Light", bg: "#f6f6f9", side: "#111228", line: "#e1e2e8" },
  { value: "dark", label: "Dark", bg: "#0b0b0d", side: "#0f1012", line: "#25262b" },
  { value: "system", label: "Match system", bg: "linear-gradient(90deg,#f6f6f9 50%,#0b0b0d 50%)", side: "#111228", line: "#a0a3ae" },
];

function Appearance() {
  const { pref, setPref } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
      {THEMES.map((t) => (
        <button
          key={t.value}
          type="button"
          role="radio"
          aria-checked={pref === t.value}
          onClick={() => setPref(t.value)}
          className={cn("rounded-xl border-2 p-2.5 text-left transition-colors", pref === t.value ? "border-primary" : "border-border hover:border-input")}
        >
          <span className="flex h-20 overflow-hidden rounded-lg" style={{ background: t.bg }}>
            <span className="w-1/4" style={{ background: t.side }} />
            <span className="flex flex-1 flex-col gap-1.5 p-2.5">
              <span className="h-2 w-3/5 rounded-sm" style={{ background: t.line }} />
              <span className="h-2 w-2/5 rounded-sm" style={{ background: t.line }} />
            </span>
          </span>
          <span className="mt-2 block text-[13px] font-medium">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function SettingsView() {
  const [tab, setTab] = useState("sending");
  const current = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader eyebrow="Account / Settings" title="Settings" />
      <div className="grid items-start gap-6 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-7">
        <nav aria-label="Settings sections" className="flex gap-0.5 overflow-x-auto md:sticky md:top-20 md:flex-col">
          {TABS.map(({ key, label, icon: Icon }) => {
            const on = key === tab;
            return (
              <button
                key={key}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => setTab(key)}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors",
                  on ? "bg-card text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-[15px]", on && "text-primary")} />
                {label}
              </button>
            );
          })}
        </nav>
        <section aria-labelledby="settings-title" className="min-w-0 space-y-4 rounded-xl border bg-card p-5 sm:p-6">
          <div>
            <h2 id="settings-title" className="text-base font-semibold">
              {current.title}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{current.description}</p>
          </div>
          {tab === "sending" && <SendStatus />}
          {tab === "window" && <SendWindowForm />}
          {tab === "template" && <TemplateForm />}
          {tab === "appearance" && <Appearance />}
          {tab === "account" && <PasswordForm />}
        </section>
      </div>
    </div>
  );
}
