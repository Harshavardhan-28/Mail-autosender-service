import { cn } from "@/lib/utils";
import type { MailRow } from "@/lib/types";

const CHIP = "inline-flex h-5 items-center rounded-md px-1.5 text-[11px] leading-none font-medium whitespace-nowrap";

export const kindName = (kind: MailRow["kind"]) => (kind === "followup" ? "Follow-up" : "First email");

/** The few facts worth a glance on a mail row. Words, never colour alone. */
export function MailChips({ mail, className }: { mail: Pick<MailRow, "kind" | "state" | "dryRun" | "overdue" | "contact">; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {mail.kind === "followup" && <span className={cn(CHIP, "border text-muted-foreground")}>Follow-up</span>}
      {mail.contact.status === "replied" && <span className={cn(CHIP, "bg-st-violet-bg text-st-violet")}>Replied</span>}
      {mail.state === "needs_review" && <span className={cn(CHIP, "bg-st-amber-bg text-st-amber")}>Needs review</span>}
      {mail.state === "failed" && <span className={cn(CHIP, "bg-st-red-bg text-st-red")}>Failed</span>}
      {mail.state === "sending" && <span className={cn(CHIP, "bg-st-indigo-bg text-st-indigo")}>Sending</span>}
      {mail.overdue && <span className={cn(CHIP, "bg-st-amber-bg text-st-amber")}>Overdue</span>}
      {mail.dryRun && <span className={cn(CHIP, "bg-st-neutral-bg text-st-neutral")}>Dry run</span>}
    </div>
  );
}
