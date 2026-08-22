"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * The landing page's sign-in corner, aware of whether you already have.
 *
 * The landing is cached (ISR, five minutes), so it cannot read the session
 * cookie and was showing "Sign in / Start free" to people who were signed in
 * — who then pressed Start free, were correctly bounced into the app, and
 * read it as "it signed me in without asking". This renders the anonymous
 * pair on the server, asks /api/me after mount, and swaps to "Your resumes"
 * for a live session. One small fetch, no layout shift: the signed-in button
 * is the same width class as the signed-out one.
 */
export function SessionNav() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setSignedIn(Boolean(data?.user));
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (signedIn) {
    return (
      <Link href="/app" className="btn btn-primary text-sm whitespace-nowrap">
        Your resumes
      </Link>
    );
  }

  return (
    <>
      <Link href="/login" className="text-muted hover:text-ink text-sm whitespace-nowrap">
        Sign in
      </Link>
      <Link href="/signup" className="btn btn-primary text-sm whitespace-nowrap">
        Start free
      </Link>
    </>
  );
}
