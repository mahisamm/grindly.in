"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The signed-in app's one navigation.
 *
 * A returning user's eye checks the same place on every page: a row of the
 * app's real destinations across the top, with everything about *them* behind
 * the avatar to its right (AccountMenu, in the layout). This replaces the
 * per-workspace left sidebar, which sat inside the content column and read as
 * part of the page rather than as the way around it.
 *
 * Desktop only (`lg` up). On a phone the same destinations live in the bottom
 * bar (MobileNav) within thumb reach.
 */

type Item = { href: string; label: string; match: (path: string) => boolean };

// Workspace paths that are NOT their own destination — /app, /app/<id> and
// /app/<id>/edit all belong to REPORT.
const SECTION_SEGMENTS = ["resumes", "applications", "tailor", "settings", "support"];

/** True for the resume workspace and its editor — the REPORT destination. */
export function isReportPath(path: string): boolean {
  if (path === "/app") return true;
  if (!path.startsWith("/app/")) return false;
  const seg = path.slice("/app/".length).split("/")[0];
  return !SECTION_SEGMENTS.includes(seg);
}

const ITEMS: Item[] = [
  { href: "/app/resumes", label: "Resumes", match: (p) => p.startsWith("/app/resumes") },
  { href: "/app", label: "Report", match: isReportPath },
  { href: "/app/applications", label: "Applications", match: (p) => p.startsWith("/app/applications") },
  { href: "/app/tailor", label: "Tailor", match: (p) => p.startsWith("/app/tailor") },
];

const LINK_CLASS =
  "rounded-lg px-3 py-2 font-mono text-[11px] font-medium tracking-[0.12em] whitespace-nowrap uppercase transition-colors";

export function AppNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Main" className="hidden items-center gap-0.5 lg:flex">
      {ITEMS.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={LINK_CLASS}
            style={
              active
                ? { background: "var(--cta)", color: "var(--on-cta)" }
                : { color: "var(--muted)" }
            }
          >
            {item.label}
          </Link>
        );
      })}
      {isAdmin && (
        <>
          <span aria-hidden className="mx-1 select-none" style={{ color: "var(--border)" }}>
            |
          </span>
          {/* A hard navigation: /admin is a separate shell with its own layout. */}
          <a href="/admin" className={LINK_CLASS} style={{ color: "var(--muted)" }}>
            Admin
          </a>
        </>
      )}
    </nav>
  );
}
