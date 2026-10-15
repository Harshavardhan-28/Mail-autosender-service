"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A div whose width/height (percent) is data-driven. The CSP forbids style attributes, so the
 * value is applied through the CSSOM (element.style), which the policy allows.
 */
export function Dyn({ w, h, className, children, ...rest }: { w?: number; h?: number; className?: string; children?: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (w !== undefined) el.style.width = `${Math.max(0, Math.min(100, w))}%`;
    if (h !== undefined) el.style.height = `${Math.max(0, Math.min(100, h))}%`;
  }, [w, h]);
  return (
    <div ref={ref} className={className} {...rest}>
      {children}
    </div>
  );
}

const HUES = [
  "bg-[oklch(0.6_0.17_275)]",
  "bg-[oklch(0.6_0.17_200)]",
  "bg-[oklch(0.6_0.17_330)]",
  "bg-[oklch(0.6_0.17_150)]",
  "bg-[oklch(0.6_0.17_45)]",
  "bg-[oklch(0.6_0.17_15)]",
  "bg-[oklch(0.6_0.17_100)]",
  "bg-[oklch(0.6_0.17_245)]",
];

/** A stable avatar colour class for a name (company or person). */
export function hueClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length]!;
}

export const initials = (name: string, n = 2) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, n)
    .join("") || "?";
