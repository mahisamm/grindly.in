"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The floating bottom bar the signed-in app uses on a phone.
 *
 * On a phone the top of the screen is the hardest place to reach and the first
 * thing a scroll takes away. The header here was three text links that wrapped
 * onto two ragged lines, cost about a hundred pixels above the fold, and put
 * every destination under the user's other hand. This is the same navigation,
 * pinned within thumb reach and out of the scroll.
 *
 * Fixed rather than sticky, and floating rather than edge-to-edge, because a
 * bar welded to the bottom edge of the viewport collides with the iOS home
 * indicator and Android's gesture pill. The inset plus `env(safe-area-inset-*)`
 * keeps it clear of both.
 *
 * Hidden from `lg` up: on a desktop the header is already in view, always, and
 * a second navigation would just be a second place to look.
 */

type Item = {
  href: string;
  label: string;
  icon: (props: { active: boolean }) => React.ReactNode;
  /** Match sub-paths too (e.g. /app/abc123 belongs to /app). */
  match: (path: string) => boolean;
};

const STROKE = { fill: "none", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ITEMS: Item[] = [
  {
    href: "/app",
    label: "Home",
    // The dashboard — the primary resume's workspace — and any other single
    // resume's workspace, which is where people spend their time.
    match: (p) =>
      p === "/app" ||
      (p.startsWith("/app/") && p !== "/app/settings" && p !== "/app/resumes"),
    icon: ({ active }) => (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" {...STROKE}>
        <path d="M4 11.5 12 5l8 6.5" />
        <path d="M6.5 10v9.5h11V10" />
        {active && <path d="M10 19.5v-5h4v5" />}
      </svg>
    ),
  },
  {
    href: "/app/resumes",
    label: "Resumes",
    match: (p) => p === "/app/resumes",
    icon: ({ active }) => (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" {...STROKE}>
        <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v4h4" />
        {active && <path d="M9 12h6M9 16h4" />}
      </svg>
    ),
  },
  {
    href: "/pricing",
    label: "Plan",
    match: (p) => p === "/pricing",
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" {...STROKE}>
        <path d="M12 3.5 14.3 9l5.7.4-4.4 3.7 1.4 5.6L12 15.6 7 18.7l1.4-5.6L4 9.4 9.7 9 12 3.5Z" />
      </svg>
    ),
  },
  {
    href: "/app/settings",
    label: "Account",
    match: (p) => p === "/app/settings",
    icon: () => (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" {...STROKE}>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </svg>
    ),
  },
];

export function MobileNav() {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Main" className="mobile-nav lg:hidden">
      <ul className="mobile-nav__list">
        {ITEMS.map((item) => {
          const active = item.match(pathname);
          return (
            <li key={item.href} className="mobile-nav__item">
              <Link
                href={item.href}
                // aria-current is what a screen reader announces; the colour
                // change is only for people who can see it.
                aria-current={active ? "page" : undefined}
                className="mobile-nav__link"
                data-active={active ? "true" : undefined}
              >
                {item.icon({ active })}
                <span className="mobile-nav__label">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
