-- Follow-up by calendar date: the instant the follow-up should go out (window opening of the picked day).
-- NULL = the legacy rule, sent_at + followup_delay_days.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS followup_at timestamptz;
