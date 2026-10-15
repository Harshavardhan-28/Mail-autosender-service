import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { title: "Upload", desc: "Choose a CSV file" },
  { title: "Review", desc: "Fix errors and duplicates" },
  { title: "Schedule", desc: "Pick when it sends" },
] as const;

/** Three-step tabs for the import flow: `current` is 1-based; steps before it show a check. `current` 4 means all done. */
export function Stepper({ current, className }: { current: 1 | 2 | 3 | 4; className?: string }) {
  return (
    <nav aria-label="Progress" className={cn("mt-[18px]", className)}>
      <ol className="flex flex-wrap">
        {STEPS.map(({ title, desc }, i) => {
          const n = i + 1;
          const done = current > n;
          const active = current === n;
          return (
            <li key={title} aria-current={active ? "step" : undefined} className={cn("mr-[22px] flex items-center gap-2.5 border-b-2 py-3 pr-[22px]", active ? "border-primary" : "border-transparent")}>
              <span
                aria-hidden="true"
                className={cn("grid size-6 shrink-0 place-items-center rounded-full text-xs font-[650] tabular-nums", done || active ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground")}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : n}
              </span>
              <span>
                <span className={cn("block text-[13.5px] font-semibold", active ? "text-foreground" : "text-muted-foreground")}>
                  {title}
                  {done && <span className="sr-only"> (done)</span>}
                </span>
                <span className="block text-[11.5px] text-muted-foreground">{desc}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
