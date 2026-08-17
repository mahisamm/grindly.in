import Link from "next/link";
import { NavMenu } from "@/components/NavMenu";

/**
 * Brand mark — "Full Stop": the GRINDLY wordmark ended by a vermilion period.
 * No pictorial glyph — the punctuation is the mark. `light` renders on a
 * dark/ink panel. Icon-only mode (withWordmark=false) falls back to the
 * compact "g." app-icon form used for favicons.
 */
export function Logo({
  size = 30,
  light = false,
  withWordmark = true,
}: {
  size?: number;
  light?: boolean;
  withWordmark?: boolean;
}) {
  if (!withWordmark) {
    return (
      <span
        className="font-display inline-flex shrink-0 items-center justify-center rounded-[28%] font-bold"
        style={{
          width: size,
          height: size,
          background: "var(--vermilion)",
          color: "var(--paper)",
          fontSize: size * 0.62,
          lineHeight: 1,
        }}
        aria-hidden
      >
        g
      </span>
    );
  }
  return (
    <span
      // Marked as a brandmark so the accessibility audit can apply WCAG 1.4.3's
      // logotype exemption to the vermilion full stop. It is 3.55:1 on paper,
      // which fails the body-text minimum and is exempt as part of a brand
      // name — the mark would stop being the mark if it were recoloured.
      data-brandmark=""
      className={`font-bold tracking-[0.14em] ${light ? "text-[var(--paper)]" : ""}`}
      style={{ fontSize: `${size * 0.032}rem` }}
    >
      GRINDLY
      <span style={{ color: "var(--vermilion)" }}>.</span>
      <span className={light ? "font-light text-[rgba(242,236,225,0.6)]" : "font-light text-muted"}>
        {" "}· agent
      </span>
    </span>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-40 glass">
      <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
        <Link href="/" className="transition hover:opacity-80" aria-label="Grindly home">
          <Logo size={30} withWordmark />
        </Link>
        <NavMenu />
      </div>
    </header>
  );
}
