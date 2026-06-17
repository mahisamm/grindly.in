import Link from "next/link";

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
        <rect width="32" height="32" rx="9" className="fill-[url(#g)]" />
        <path
          d="M9 21.5 16 8l7 13.5-7-3.6-7 3.6Z"
          fill="white"
          fillOpacity="0.95"
        />
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="32" y2="32">
            <stop stopColor="#6d5efc" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
      </svg>
      <span className="text-[1.05rem]">
        Nex<span className="brand-text">Path</span>
      </span>
    </span>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-40 glass">
      <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
        <Link href="/">
          <Logo />
        </Link>
        <nav className="flex items-center gap-2 text-sm">
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
            className="ml-1 px-4 py-2 rounded-lg brand-gradient text-white font-medium hover:opacity-90 transition"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
