import Link from "next/link";

export type SectionKey =
  | "overview"
  | "access"
  | "people"
  | "quality"
  | "money"
  | "problems"
  | "feedback"
  | "health"
  | "settings";

export const SECTIONS: { key: SectionKey; label: string; group: string }[] = [
  { key: "overview", label: "Overview", group: "Dashboard" },
  { key: "access", label: "Access requests", group: "Dashboard" },
  { key: "people", label: "Accounts", group: "Dashboard" },
  { key: "quality", label: "Quality", group: "Product" },
  { key: "money", label: "Money", group: "Product" },
  { key: "problems", label: "Problems", group: "Operations" },
  { key: "feedback", label: "Feedback", group: "Operations" },
  { key: "health", label: "Health", group: "Operations" },
  { key: "settings", label: "Settings", group: "Operations" },
];

export function isSection(value: string | undefined): value is SectionKey {
  return SECTIONS.some((s) => s.key === value);
}

/**
 * The dashboard's own navigation.
 *
 * LINKS, not a client-side tab state, and the section lives in the URL. Three
 * things follow from that and all three matter on an operator's page: the back
 * button works, a refresh at 2am keeps you where you were, and "look at the
 * error list" is a message someone can send. It is also the pattern the resume
 * workspace already uses for its tabs — one idea, applied twice.
 *
 * Rendered as a sidebar from `lg` and as a scrolling strip of pills below it. A
 * sidebar on a 412px screen is either a hamburger nobody opens or half the
 * width of the content; the strip keeps every destination one thumb away.
 */
export function AdminNav({ active, waiting }: { active: SectionKey; waiting: number }) {
  const groups = [...new Set(SECTIONS.map((s) => s.group))];

  return (
    <nav aria-label="Admin sections" className="lg:w-52 lg:shrink-0">
      {/* Mobile: one scrolling row. `scrollbar-none` is already in globals. */}
      <ul className="scrollbar-none -mx-5 flex gap-2 overflow-x-auto px-5 pb-1 lg:hidden">
        {SECTIONS.map((s) => (
          <li key={s.key}>
            <NavLink section={s.key} label={s.label} active={active === s.key} badge={s.key === "access" ? waiting : 0} pill />
          </li>
        ))}
      </ul>

      <div className="hidden lg:sticky lg:top-6 lg:block">
        {groups.map((group) => (
          <div key={group} className="mb-5">
            {/* No `opacity-` on top of `text-muted`. Two dimmings compound, and
                --muted at 70% is 3.4:1 on paper for 10px text — the third time
                this exact pairing has failed the contrast sweep. Dim OR muted,
                never both. */}
            <p className="text-muted mb-1.5 px-3 font-mono text-[10px] tracking-[0.14em] uppercase">
              {group}
            </p>
            <ul className="space-y-0.5">
              {SECTIONS.filter((s) => s.group === group).map((s) => (
                <li key={s.key}>
                  <NavLink
                    section={s.key}
                    label={s.label}
                    active={active === s.key}
                    badge={s.key === "access" ? waiting : 0}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function NavLink({
  section,
  label,
  active,
  badge,
  pill = false,
}: {
  section: SectionKey;
  label: string;
  active: boolean;
  badge: number;
  pill?: boolean;
}) {
  return (
    <Link
      // The default section is expressed by absence, so the canonical URL for
      // this page has no query string at all.
      href={section === "overview" ? "/admin" : `/admin?s=${section}`}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between gap-2 whitespace-nowrap transition-colors ${
        pill ? "rounded-full border px-3.5 py-1.5 text-xs font-semibold" : "rounded-lg px-3 py-2 text-sm"
      }`}
      style={
        active
          ? { background: "var(--cta)", color: "var(--on-cta)", borderColor: "var(--cta)" }
          : { color: "var(--muted)", borderColor: "var(--line-2)" }
      }
    >
      {label}
      {badge > 0 && (
        <span
          className="rounded-full px-1.5 font-mono text-[10px] tabular-nums"
          style={
            active
              ? { background: "var(--on-cta)", color: "var(--cta)" }
              : { background: "var(--cta)", color: "var(--on-cta)" }
          }
        >
          {badge}
        </span>
      )}
    </Link>
  );
}
