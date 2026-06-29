import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function NotFound() {
  return (
    <main className="min-h-screen grid-bg flex items-center justify-center px-5">
      <div className="text-center max-w-sm">
        <Link href="/" className="flex justify-center mb-8">
          <Logo size={28} />
        </Link>
        <div className="display text-8xl text-brand font-bold">404</div>
        <h1 className="mt-4 font-display text-2xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">
          This page doesn&apos;t exist. It may have been moved or the URL is wrong.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/"
            className="rounded-xl brand-gradient sticker-sm px-5 py-2.5 text-sm font-semibold"
          >
            Go home
          </Link>
          <Link
            href="/dashboard"
            className="rounded-xl border-2 border-ink bg-surface px-5 py-2.5 text-sm font-semibold transition hover:bg-surface-2"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
