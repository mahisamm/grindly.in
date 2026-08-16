import Link from "next/link";

/** Landing-nav links. */
export function NavMenu() {
  return (
    <nav className="flex items-center gap-4 text-[0.72rem] font-medium uppercase tracking-[0.1em]">
      {/* Real routes, not anchors. These were /#features, /#how and /#pricing —
          three fragments that match no `id` anywhere on the landing page, so
          every one of them scrolled nowhere. */}
      <Link href="/pricing" className="hidden sm:block text-muted hover:text-brand transition">
        Pricing
      </Link>
      <Link href="/privacy" className="hidden sm:block text-muted hover:text-brand transition">
        Privacy
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
