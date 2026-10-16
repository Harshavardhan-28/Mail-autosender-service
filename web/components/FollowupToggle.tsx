"use client";

import { useId, useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatCalendarDay } from "@/lib/format";
import { DEFAULT_SEND_TZ, describeFollowupError, FOLLOWUP_RANGE_ERROR, followupDateRange, isFollowupDateInRange, zonedDate } from "@/lib/followupDate";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Contact, FollowupResult, MessageRef } from "@/lib/types";

type Props = {
  contact: Pick<Contact, "id" | "email" | "followupRequested" | "followupAt" | "followupDelayDays"> & { messages?: MessageRef[] };
  onChange?: (result: FollowupResult) => void;
  disabled?: boolean;
  /** The send window's time zone; picked dates are calendar days there. */
  tz?: string;
};

const scheduledFollowup = (messages: MessageRef[] | undefined) => messages?.find((m) => m.kind === "followup" && m.state === "scheduled")?.scheduledFor ?? null;

/**
 * Follow-up switch + calendar date (in the send window's zone). The switch saves at once; a date change is saved when
 * the field is left or Enter is pressed (not on every keystroke) via PUT /api/contacts/:id/followup.
 * Parents pass a `key` derived from the contact's follow-up fields (and tz) to resync after reloads.
 */
export function FollowupToggle({ contact, onChange, disabled, tz = DEFAULT_SEND_TZ }: Props) {
  const id = useId();
  const range = followupDateRange(new Date(), tz);
  const [enabled, setEnabled] = useState(contact.followupRequested);
  // The date the server holds (null = legacy "N days after the first email" rule), apart from the field's draft.
  const [serverDate, setServerDate] = useState<string | null>(contact.followupAt ? zonedDate(contact.followupAt, tz) : null);
  const [followupFor, setFollowupFor] = useState<string | null>(scheduledFollowup(contact.messages));
  // A legacy follow-up shows an empty field rather than a date the server does not have.
  const resting = (on: boolean, saved: string | null) => saved ?? (on ? "" : range.fallback);
  const [date, setDate] = useState(() => resting(contact.followupRequested, serverDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const validDate = (d: string) => isFollowupDateInRange(d, range);

  async function save(next: boolean, d: string) {
    const mine = ++seq.current;
    const before = enabled;
    setEnabled(next); // optimistic; reverted below if the server refuses
    setBusy(true);
    setError(null);
    try {
      const result = await api.setFollowup(contact.id, next ? { enabled: true, date: d } : { enabled: false });
      if (mine !== seq.current) return; // a newer save superseded this one
      const on = result.contact.followupRequested;
      const saved = result.contact.followupAt ? zonedDate(result.contact.followupAt, tz) : null;
      setEnabled(on);
      setServerDate(saved);
      setFollowupFor(result.followup?.state === "scheduled" ? result.followup.scheduledFor : null);
      setDate(resting(on, saved));
      onChange?.(result);
    } catch (err) {
      if (mine !== seq.current) return;
      setEnabled(before);
      setDate(resting(before, serverDate));
      setError(describeFollowupError(err));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  function onToggle() {
    if (enabled) return void save(false, date);
    if (!validDate(date)) return setError(FOLLOWUP_RANGE_ERROR);
    void save(true, date);
  }

  function onDateChange(value: string) {
    setDate(value);
    setError(value && !validDate(value) ? FOLLOWUP_RANGE_ERROR : null);
  }

  // Saves the draft date (blur / Enter) when it differs from what the server holds.
  function commitDate() {
    if (!enabled || date === (serverDate ?? "")) return;
    if (!date) return setDate(resting(enabled, serverDate));
    if (!validDate(date)) return setError(FOLLOWUP_RANGE_ERROR);
    void save(true, date);
  }

  const delay = contact.followupDelayDays;
  const when = followupFor
    ? `Sends ${formatCalendarDay(zonedDate(followupFor, tz))}`
    : serverDate
      ? `Sends ${formatCalendarDay(serverDate)}`
      : `${delay} ${delay === 1 ? "day" : "days"} after the first email`;

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
            min={range.min}
            max={range.max}
            value={date}
            disabled={disabled}
            onChange={(e) => onDateChange(e.target.value)}
            onBlur={commitDate}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              commitDate();
            }}
            className="h-7 w-[8.5rem] px-2 text-[13px]"
          />
        </label>
        {enabled && <span className="text-xs text-muted-foreground">{when}</span>}
      </div>
      {error && (
        <p className="text-xs text-destructive" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}
