import Link from "next/link";

/** Landing-nav links. */
export function NavMenu() {
  return (
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
  );
}
