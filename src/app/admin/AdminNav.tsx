"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Brand";

const LINKS = [
  ["/admin", "Overview"],
  ["/admin/analytics", "Analytics"],
  ["/admin/access", "Access"],
  ["/admin/agent-health", "Agent health"],
  ["/admin/applications", "Applications"],
  ["/admin/users", "Users"],
  ["/admin/support", "Support"],
  ["/admin/integrations", "Integrations"],
  ["/admin/audit", "Audit log"],
  ["/admin/settings", "Settings"],
];

/**
 * Admin chrome. Fixed sidebar from `lg` up; below that it collapses to a top bar
 * with a slide-in drawer.
 *
 * The sidebar used to be `w-56 shrink-0` at every width, so on a 390px phone it
 * took 224px and left ~120px for the content — every table column crushed to a
 * few characters wide. On a phone the nav must not hold a permanent claim on the
 * viewport.
 */
export function AdminNav({ email }: { email: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) =>
    href === "/admin" ? path === "/admin" : path.startsWith(href);

  // Don't leave the page scrollable behind the drawer.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const navList = (
    <nav className="flex flex-col gap-1">
      {LINKS.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          // Close the drawer on navigation — otherwise the new page renders
          // underneath an open overlay and reads as a dead screen. A no-op on
          // desktop, where the drawer is never open.
          onClick={() => setOpen(false)}
          className={`rounded-lg px-3 py-2 font-sans text-sm transition ${
            isActive(href)
              ? "bg-brand/10 font-medium text-brand"
              : "text-muted hover:bg-surface-2 hover:text-foreground"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );

  const footer = (
    <div className="mt-auto border-t border-border pt-4">
      <div className="truncate font-sans text-xs text-muted" title={email}>
        {email}
      </div>
      <Link href="/dashboard" className="mt-2 inline-block font-sans text-xs text-muted hover:text-foreground">
        ← back to app
      </Link>
    </div>
  );

  return (
    <>
      {/* Phone/tablet: top bar + drawer */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open admin menu"
          aria-expanded={open}
          className="rounded-lg border border-border px-2.5 py-1.5 font-sans text-sm text-muted hover:text-foreground"
        >
          ☰
        </button>
        <Link href="/admin" className="flex min-w-0 items-center gap-2">
          <Logo size={22} withWordmark={false} />
          <span className="truncate font-display text-sm font-bold tracking-tight text-foreground">
            Grindly <span className="text-brand italic">ADMIN</span>
          </span>
        </Link>
        <span className="ml-auto truncate font-sans text-[11px] text-muted" title={email}>
          {email.split("@")[0]}
        </span>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label="Close admin menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/60"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col overflow-y-auto border-r border-border bg-surface p-4">
            <div className="mb-6 flex items-center justify-between gap-2">
              <Link href="/admin" className="flex items-center gap-2">
                <Logo size={24} withWordmark={false} />
                <span className="font-display text-base font-bold tracking-tight text-foreground">
                  Grindly <span className="text-brand italic">ADMIN</span>
                </span>
              </Link>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close admin menu"
                className="rounded-lg border border-border px-2 py-1 font-sans text-xs text-muted hover:text-foreground"
              >
                ✕
              </button>
            </div>
            {navList}
            {footer}
          </aside>
        </div>
      )}

      {/* Desktop: the original fixed sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface/70 p-4 backdrop-blur lg:flex">
        <Link href="/admin" className="mb-6 flex items-center gap-2">
          <Logo size={26} withWordmark={false} />
          <span className="font-display text-base font-bold tracking-tight text-foreground">
            Grindly <span className="text-brand italic">ADMIN</span>
          </span>
        </Link>
        {navList}
        {footer}
      </aside>
    </>
  );
}
