import Link from "next/link";

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
        <Link href="/" className="transition hover:opacity-80">
          <Logo size={30} withWordmark />
        </Link>
        <nav className="flex items-center gap-4 text-[0.72rem] font-medium uppercase tracking-[0.1em]">
          <Link href="/#features" className="hidden sm:block text-muted hover:text-brand transition">
            Features
          </Link>
          <Link href="/#how" className="hidden sm:block text-muted hover:text-brand transition">
            How it works
          </Link>
          <Link href="/#pricing" className="hidden sm:block text-muted hover:text-brand transition">
            Pricing
          </Link>
          <Link
            href="/login"
            className="press inline-flex items-baseline gap-2 rounded-full border border-[var(--line-2)] px-4 py-2 normal-case tracking-normal transition hover:bg-ink hover:text-[var(--paper)] hover:border-ink"
          >
            <span className="text-[0.7rem] uppercase tracking-[0.12em]">Sign in</span>
            <span className="font-bold">free</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
