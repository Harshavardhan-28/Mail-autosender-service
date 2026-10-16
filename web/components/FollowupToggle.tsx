"use client";

import { useId, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { refusalText } from "@/lib/refusals";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Contact, FollowupResult } from "@/lib/types";

const MAX_DAYS = 90; // same cap the server enforces
const DEFAULT_DAYS = 7;
const SEND_TZ = "Asia/Kolkata"; // send-window tz: the picked date is a calendar day here

const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: SEND_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Props = {
  contact: Pick<Contact, "id" | "email" | "followupRequested" | "followupAt">;
  onChange?: (result: FollowupResult) => void;
  disabled?: boolean;
};

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const r = err.refused?.[0];
    if (r) return refusalText(r.reason);
    return err.message;
  }
  return "Could not update the follow-up";
}

/**
 * Follow-up switch + calendar date (IST). Saves immediately via PUT /api/contacts/:id/followup.
 * Parents pass a `key` derived from the contact's follow-up fields to resync after reloads.
 */
export function FollowupToggle({ contact, onChange, disabled }: Props) {
  const id = useId();
  const [enabled, setEnabled] = useState(contact.followupRequested);
  const today = istDay.format(new Date());
  const min = today;
  const max = addDays(today, MAX_DAYS);
  const initial = contact.followupAt ? istDay.format(new Date(contact.followupAt)) : addDays(today, DEFAULT_DAYS);
  const [date, setDate] = useState(initial);
  const [savedDate, setSavedDate] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= min && d <= max;
  const rangeError = "Pick a date within the next 90 days";

  async function save(next: boolean, d: string) {
    const before = enabled;
    setEnabled(next); // optimistic; reverted below if the server refuses
    setBusy(true);
    setError(null);
    try {
      const result = await api.setFollowup(contact.id, next ? { enabled: true, date: d } : { enabled: false });
      setEnabled(result.contact.followupRequested);
      if (result.contact.followupAt) {
        const saved = istDay.format(new Date(result.contact.followupAt));
        setSavedDate(saved);
        setDate(saved);
      }
      onChange?.(result);
    } catch (err) {
      setEnabled(before);
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function onToggle() {
    if (enabled) return void save(false, date);
    if (!validDate(date)) return setError(rangeError);
    void save(true, date);
  }

  function onDateChange(value: string) {
    setDate(value);
    if (!validDate(value)) return setError(rangeError);
    setError(null);
    if (enabled && value !== savedDate) void save(true, value);
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2.5">
        <Switch
          checked={enabled}
          disabled={disabled || busy}
          onCheckedChange={onToggle}
          aria-label={`Follow up with ${contact.email}`}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="sr-only">Follow-up date for {contact.email}</span>
          <Input
            type="date"
            min={min}
            max={max}
            value={date}
            disabled={disabled || busy}
            onChange={(e) => onDateChange(e.target.value)}
            className="h-7 w-[8.5rem] px-2 text-[13px]"
          />
        </label>
        {enabled && validDate(savedDate) && (
          <span className="text-xs text-muted-foreground">Sends {dayLabel.format(new Date(`${savedDate}T00:00:00Z`))}</span>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}
