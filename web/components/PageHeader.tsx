import { cn } from "@/lib/utils";

/** Full-bleed white title bar: breadcrumb, title, optional description, actions on the right. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  /** Rendered inside the bar under the title (e.g. step tabs). */
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("border-b bg-card px-4 pt-5 md:px-8", children ? "pb-0" : "pb-4.5", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="min-w-55 flex-1 space-y-0.5">
          {eyebrow && <p className="text-xs text-muted-foreground">{eyebrow}</p>}
          <h1 className="text-[22px] leading-7 font-[650] tracking-[-0.02em]">{title}</h1>
          {description && <p className="max-w-prose pt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Centered page content under a PageHeader. */
export function PageBody({ children, className, max = "max-w-[1320px]" }: { children: React.ReactNode; className?: string; max?: string }) {
  return <div className={cn("mx-auto w-full px-4 pt-6 pb-10 md:px-8", max, className)}>{children}</div>;
}
