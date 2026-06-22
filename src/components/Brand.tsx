import Link from "next/link";

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="relative inline-flex" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#2a28f0" stroke="#16150f" strokeWidth="2" />
          <path d="M9 22 L16 8 L23 22 L16 17.5 Z" fill="#fff" />
        </svg>
        <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-[#ff7a1a] ring-2 ring-[var(--background)]" />
      </span>
      <span className="font-display text-[1.2rem] font-semibold tracking-tight">
        Nex<span className="brand-text">Path</span>
      </span>
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
          <a href="/#how" className="px-3 py-2 text-muted hover:text-foreground transition">
            How it works
          </a>
          <a href="/#pricing" className="px-3 py-2 text-muted hover:text-foreground transition hidden sm:block">
            Pricing
          </a>
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
