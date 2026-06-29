"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="min-h-screen grid-bg flex items-center justify-center px-5">
      <div className="text-center max-w-sm">
        <Link href="/" className="flex justify-center mb-8">
          <Logo size={28} />
        </Link>
        <div className="display text-8xl text-danger font-bold">500</div>
        <h1 className="mt-4 font-display text-2xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">
          An unexpected error occurred. Try refreshing or return to the homepage.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-xl brand-gradient sticker-sm px-5 py-2.5 text-sm font-semibold"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-xl border-2 border-ink bg-surface px-5 py-2.5 text-sm font-semibold transition hover:bg-surface-2"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
