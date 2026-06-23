import Link from "next/link";

export function Logo({
  size = 30,
  light = false,
  withWordmark = true,
}: {
  size?: number;
  /** Render on a dark/brand background — white icon + white wordmark. */
  light?: boolean;
  withWordmark?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="relative inline-flex" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
          {light ? (
            <>
              <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#fff" stroke="#fff" strokeWidth="2" />
              <path d="M9 22 L16 8 L23 22 L16 17.5 Z" fill="#2a28f0" />
            </>
          ) : (
            <>
              <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#2a28f0" stroke="#16150f" strokeWidth="2" />
              <path d="M9 22 L16 8 L23 22 L16 17.5 Z" fill="#fff" />
            </>
          )}
        </svg>
        <span
          className={`absolute -right-1 -top-1 size-2.5 rounded-full bg-[#ff7a1a] ring-2 ${
            light ? "ring-[var(--brand)]" : "ring-[var(--background)]"
          }`}
        />
      </span>
      {withWordmark && (
        <span className={`font-display text-[1.2rem] font-semibold tracking-tight ${light ? "text-white" : ""}`}>
          Nex<span className={light ? "text-white" : "brand-text"}>Path</span>
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
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 text-sm font-medium">
          <Link href="/#how" className="px-3 py-2 text-muted hover:text-foreground transition">
            How it works
          </Link>
          <Link href="/#pricing" className="px-3 py-2 text-muted hover:text-foreground transition hidden sm:block">
            Pricing
          </Link>
          <Link
            href="/login"
            className="px-3 py-2 text-muted hover:text-foreground transition"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className="ml-2 rounded-xl brand-gradient sticker-sm px-4 py-2 font-semibold transition hover:translate-y-[-1px]"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
