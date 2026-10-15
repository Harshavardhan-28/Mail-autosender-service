import { cn } from "@/lib/utils";

/** The Outbox mark: a small indigo gradient tile with an "O". */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#6d78f0] to-[#4f5bd5] text-sm font-bold text-white", className)}
    >
      O
    </span>
  );
}
