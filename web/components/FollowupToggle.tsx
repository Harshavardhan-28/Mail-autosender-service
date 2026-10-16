"use client";

import { useId, useState } from "react";
import { api } from "@/lib/api";
import { formatCalendarDay } from "@/lib/format";
import { describeFollowupError, FOLLOWUP_RANGE_ERROR, followupDateRange, isFollowupDateInRange, istDate } from "@/lib/followupDate";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Contact, FollowupResult } from "@/lib/types";

type Props = {
  contact: Pick<Contact, "id" | "email" | "followupRequested" | "followupAt">;
  onChange?: (result: FollowupResult) => void;
  disabled?: boolean;
};

/**
 * Follow-up switch + calendar date (IST). Saves immediately via PUT /api/contacts/:id/followup.
 * Parents pass a `key` derived from the contact's follow-up fields to resync after reloads.
 */
export function FollowupToggle({ contact, onChange, disabled }: Props) {
  const id = useId();
  const [enabled, setEnabled] = useState(contact.followupRequested);
  const range = followupDateRange();
  const { min, max } = range;
  const initial = contact.followupAt ? istDate(contact.followupAt) : range.fallback;
  const [date, setDate] = useState(initial);
  const [savedDate, setSavedDate] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validDate = (d: string) => isFollowupDateInRange(d, range);
  const rangeError = FOLLOWUP_RANGE_ERROR;

  async function save(next: boolean, d: string) {
    const before = enabled;
    setEnabled(next); // optimistic; reverted below if the server refuses
    setBusy(true);
    setError(null);
    try {
      const result = await api.setFollowup(contact.id, next ? { enabled: true, date: d } : { enabled: false });
      setEnabled(result.contact.followupRequested);
      if (result.contact.followupAt) {
        const saved = istDate(result.contact.followupAt);
        setSavedDate(saved);
        setDate(saved);
      }
      onChange?.(result);
    } catch (err) {
      setEnabled(before);
      setError(describeFollowupError(err));
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
          <span className="text-xs text-muted-foreground">Sends {formatCalendarDay(savedDate)}</span>
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
