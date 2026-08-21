"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * The signed-in identity, as every professional product wears it: one avatar
 * button in the top-right, and everything about *you* behind it — who you are
 * signed in as, what plan you are on, and the places that manage both. The
 * previous header spelled Account / Admin / Sign out as loose text links,
 * which read as navigation rather than as "this is your account".
 *
 * Desktop only (`lg` up): on phones the bottom bar already carries Account
 * within thumb reach, and a second identity menu would be two places to look.
 *
 * Deliberately a popover of LINKS, not a tab system: every destination is a
 * real page with a real URL. Closes on outside click, on Escape, and on
 * navigation. The avatar is the user's initial rather than an image — this
 * product stores resumes, not profile photos, and a grey silhouette
 * placeholder says "something failed to load" when nothing did.
 */
export function AccountMenu({
  email,
  name,
  planLabel,
  isAdmin,
  showUpgrade,
}: {
  email: string;
  name: string | null;
  /** "Free plan" / "Season Pass · 41 days left" / "Admin" — computed server-side. */
  planLabel: string;
  isAdmin: boolean;
  /** True when a pass would change anything — free users, not admins. */
  showUpgrade: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = (name?.trim() || email).charAt(0).toUpperCase();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        className="flex size-9 cursor-pointer items-center justify-center rounded-full border font-semibold transition-colors"
        style={{
          borderColor: open ? "var(--brand)" : "var(--line-2)",
          background: "var(--surface)",
          color: "var(--brand)",
        }}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="bg-surface border-border animate-in absolute right-0 z-50 mt-2 w-64 rounded-xl border p-2 shadow-lg"
        >
          {/* Who is signed in — identity first, like every account menu
              people already know. Not a link; there is nowhere it goes. */}
          <div className="border-border border-b px-3 pt-2 pb-3">
            {name && <p className="truncate text-sm font-semibold">{name}</p>}
            <p className="text-muted truncate text-xs">{email}</p>
            <p className="text-brand mt-1.5 font-mono text-[10px] tracking-[0.1em] uppercase">
              {planLabel}
            </p>
          </div>

          <div className="mt-1 flex flex-col">
            <MenuLink href="/app" onPick={() => setOpen(false)}>
              My resumes
            </MenuLink>
            <MenuLink href="/app/settings" onPick={() => setOpen(false)}>
              Account settings
            </MenuLink>
            {showUpgrade && (
              <MenuLink href="/pricing" onPick={() => setOpen(false)}>
                Get a Season Pass
              </MenuLink>
            )}
            {isAdmin && (
              <MenuLink href="/admin" onPick={() => setOpen(false)}>
                Admin dashboard
              </MenuLink>
            )}
            <MenuLink href="/contact" onPick={() => setOpen(false)}>
              Help &amp; contact
            </MenuLink>
          </div>

          <div className="border-border mt-1 border-t pt-1">
            <form action="/api/logout" method="post">
              <button
                type="submit"
                role="menuitem"
                className="text-muted hover:text-ink hover:bg-surface-2 w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  children,
  onPick,
}: {
  href: string;
  children: React.ReactNode;
  onPick: () => void;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onPick}
      className="hover:bg-surface-2 rounded-lg px-3 py-2 text-sm"
    >
      {children}
    </Link>
  );
}
