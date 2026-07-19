import Link from "next/link";

/**
 * Brand mark — the proto's 2×2 grid of pulsing ink + vermilion dots,
 * followed by the GRINDLY wordmark. `light` renders on a dark/ink panel.
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
  const grid = Math.round(size * 0.55);
  const neutral = light ? "var(--paper)" : "var(--ink)";
  const dots = [
    "var(--vermilion)",
    neutral,
    neutral,
    "var(--vermilion)",
  ];
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className="grid grid-cols-2"
        style={{ width: grid, height: grid, gap: 2 }}
        aria-hidden
      >
        {dots.map((c, i) => (
          <span
            key={i}
            className="block rounded-full pulse-dot"
            style={{ background: c, animationDelay: `${i * 0.25}s` }}
          />
        ))}
      </span>
      {withWordmark && (
        <span
          className={`font-bold tracking-[0.14em] ${light ? "text-[var(--paper)]" : ""}`}
          style={{ fontSize: `${size * 0.032}rem` }}
        >
          GRINDLY
          <span className={light ? "font-light text-[rgba(242,236,225,0.6)]" : "font-light text-muted"}>
            {" "}· agent
          </span>
        </span>
      )}
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
