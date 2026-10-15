"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumn, FileText, FlaskConical, Layers, LayoutDashboard, LogOut, Mail, Menu, PanelLeftClose, PanelLeftOpen, Settings, Upload, Users, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Notice } from "./Notice";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type Mode = { dryRun: boolean; followupsHeld: boolean } | null;
type ModeContext = { mode: Mode; refreshMode: () => void; setMode: (m: Mode) => void };

const Ctx = createContext<ModeContext>({ mode: null, refreshMode: () => {}, setMode: () => {} });
export const useMode = () => useContext(Ctx);

type NavItem = { href: string; label: string; icon: LucideIcon };
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/mail", label: "Mail", icon: Mail },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/batches", label: "Batches", icon: Layers },
    ],
  },
  {
    group: "Create",
    items: [
      { href: "/upload", label: "Upload", icon: Upload },
      { href: "/resumes", label: "Resumes", icon: FileText },
    ],
  },
  { group: "Insights", items: [{ href: "/analytics", label: "Analytics", icon: ChartColumn }] },
  { group: "Account", items: [{ href: "/settings", label: "Settings", icon: Settings }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

const COLLAPSE_KEY = "outbox-sidebar-collapsed";

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function NavList({ pathname, collapsed = false, onNavigate }: { pathname: string; collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-3.5">
      {NAV_GROUPS.map(({ group, items }) => (
        <div key={group}>
          {!collapsed && <p className="px-2.5 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{group}</p>}
          <ul className="flex flex-col gap-0.5">
            {items.map(({ href, label, icon: Icon }) => {
              const active = isActive(pathname, href);
              const link = (
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? label : undefined}
                  className={cn(
                    "flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium text-sidebar-foreground transition-colors hover:bg-accent hover:text-foreground",
                    "aria-[current=page]:bg-st-indigo-bg aria-[current=page]:text-foreground",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", active && "text-primary")} />
                  {!collapsed && label}
                </Link>
              );
              return (
                <li key={href}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">{label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function ModeChip({ mode, failed, collapsed }: { mode: Mode; failed: boolean; collapsed: boolean }) {
  const base = "flex items-center gap-2 rounded-lg px-2.5 py-[9px] text-xs font-medium whitespace-nowrap";
  const dot = <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-current" />;
  const [tone, label, title] = mode
    ? mode.dryRun
      ? ["bg-st-amber-bg text-st-amber", "Dry run", "Dry run"]
      : ["bg-st-green-bg text-st-green", "Live sending", "Live sending"]
    : failed
      ? ["bg-st-red-bg text-st-red", "Mode unknown", "Could not load the server's sending mode. Treat it as live until the dashboard loads."]
      : [null, "", ""];
  if (!tone) return null;
  return (
    <span data-slot="mode-chip" title={title} className={cn(base, tone, collapsed && "w-full justify-center")}>
      {dot}
      {!collapsed && label}
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setModeState] = useState<Mode>(null);
  const [modeFailed, setModeFailed] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    if (m) setModeFailed(false);
  }, []);
  const [signingOut, setSigningOut] = useState(false);

  const refreshMode = useCallback(() => {
    api
      .getDashboard()
      .then((d) => setMode({ dryRun: d.dryRun, followupsHeld: d.followupsHeld }))
      .catch(() => setModeFailed(true));
  }, [setMode]);

  useEffect(() => {
    refreshMode();
    api.me().then(
      (u) => setUsername(typeof u?.username === "string" ? u.username : null),
      () => {},
    );
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // Storage blocked: the sidebar just starts expanded.
    }
  }, [refreshMode]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // ignore
      }
      return !c;
    });
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      // Full navigation on purpose: drops the client router cache and all in-memory data.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    }
  }

  const current = NAV.find((n) => isActive(pathname, n.href));
  const initial = (username ?? "?").slice(0, 1).toUpperCase();

  return (
    <Ctx.Provider value={{ mode, refreshMode, setMode }}>
      <TooltipProvider delayDuration={300}>
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground"
          href="#main"
        >
          Skip to content
        </a>

        <div className="flex min-h-svh">
          <aside
            className={cn(
              "sticky top-0 hidden h-svh shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar px-3 py-4 transition-[width] duration-200 md:flex",
              collapsed ? "w-16" : "w-58",
            )}
          >
            <div className={cn("flex items-center gap-2 px-1 pb-[18px]", collapsed && "flex-col")}>
              <Link href="/dashboard" className="flex min-w-0 flex-1 items-center gap-2.5 pl-1" aria-label="Outbox">
                <BrandMark />
                {!collapsed && <span className="text-[15px] font-semibold tracking-[-0.01em]">Outbox</span>}
              </Link>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-pressed={collapsed}
                className="grid size-7 shrink-0 place-items-center rounded-[7px] border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {collapsed ? <PanelLeftOpen className="size-[15px]" /> : <PanelLeftClose className="size-[15px]" />}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
              <NavList pathname={pathname} collapsed={collapsed} />
            </div>
            <div className="flex flex-col gap-2.5 pt-2">
              <div className={cn(collapsed && "flex justify-center")}>
                <ModeChip mode={mode} failed={modeFailed} collapsed={collapsed} />
              </div>
              <div className={cn("flex items-center gap-2.5 border-t border-sidebar-border px-1.5 pt-2", collapsed && "justify-center")}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Account menu" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left">
                      <Avatar className="size-7">
                        <AvatarFallback className="bg-st-indigo-bg text-xs font-semibold text-st-indigo">{initial}</AvatarFallback>
                      </Avatar>
                      {!collapsed && (
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{username ?? "Account"}</span>
                          <span className="block text-[11px] text-muted-foreground">Admin</span>
                        </span>
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-48">
                    <DropdownMenuItem asChild>
                      <Link href="/settings">
                        <Settings />
                        Settings
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={signingOut} onSelect={signOut}>
                      <LogOut />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {!collapsed && (
                  <button type="button" aria-label="Sign out" title="Sign out" disabled={signingOut} onClick={signOut} className="text-muted-foreground hover:text-foreground">
                    <LogOut className="size-[15px]" />
                  </button>
                )}
              </div>
            </div>
          </aside>

          <Sheet open={navOpen} onOpenChange={setNavOpen}>
            <SheetContent side="left" className="w-64 gap-0 border-r bg-sidebar p-0" aria-describedby="nav-desc">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription id="nav-desc" className="sr-only">
                Navigate between pages
              </SheetDescription>
              <div className="flex h-12 items-center gap-2 px-4">
                <BrandMark />
                <span className="text-sm font-semibold tracking-tight">Outbox</span>
              </div>
              <div className="px-2 py-2">
                <NavList pathname={pathname} onNavigate={() => setNavOpen(false)} />
              </div>
              <div className="mt-auto flex flex-col gap-2.5 border-t p-3">
                <ModeChip mode={mode} failed={modeFailed} collapsed={false} />
                <div className="flex items-center justify-between">
                  <span className="truncate text-[13px] font-medium">{username ?? "Account"}</span>
                  <div className="flex items-center gap-1">
                    <ThemeToggle />
                    <Button variant="ghost" size="icon" aria-label="Sign out" disabled={signingOut} onClick={signOut}>
                      <LogOut />
                    </Button>
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col">
            {mode?.dryRun && (
              <div role="status" className="flex items-center gap-2 border-b border-st-amber/25 bg-st-amber-bg px-4 py-1.5 text-xs text-foreground">
                <FlaskConical aria-hidden="true" className="size-3.5 shrink-0 text-st-amber" />
                <span>
                  <strong className="font-medium text-st-amber">Dry run.</strong> Emails are built and logged but never delivered. Set DRY_RUN=false on the server to send for real.
                </span>
              </div>
            )}
            <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:hidden">
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setNavOpen(true)}>
                <Menu />
              </Button>
              <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{current?.label ?? "Outbox"}</p>
            </header>
            <main id="main" tabIndex={-1} className="w-full flex-1 outline-none">
              {mode?.followupsHeld && (
                <Notice tone="warning" title="Follow-ups are on hold" role="status" className="mx-4 mt-4 md:mx-8">
                  <p>
                    Reply checking hasn&apos;t succeeded in the last hour, so no follow-up goes out until it does. First emails still send.{" "}
                    <Link href="/dashboard#replies" className="font-medium underline underline-offset-2">
                      See reply checks
                    </Link>
                  </p>
                </Notice>
              )}
              {children}
            </main>
          </div>
        </div>
      </TooltipProvider>
    </Ctx.Provider>
  );
}
