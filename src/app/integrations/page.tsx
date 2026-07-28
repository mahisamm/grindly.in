"use client";

import Link from "next/link";
import { Logo } from "@/components/Brand";
import IntegrationsPanel from "@/components/IntegrationsPanel";

/**
 * Integrations, as its own page.
 *
 * It used to be a tab on the dashboard, permanently beside Applications. That
 * put a settings screen — visited once to connect a platform, then essentially
 * never again — in front of the one thing a user opens Grindly to look at.
 * Reached from the account menu now, with an unmissable way back.
 */
export default function IntegrationsPage() {
  return (
    <main className="min-h-screen grid-bg">
      <header className="sticky top-0 z-30 glass">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between gap-3 px-5">
          <Link href="/dashboard" className="shrink-0">
            <Logo />
          </Link>
          <Link
            href="/dashboard"
            className="press shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition hover:border-brand/60 hover:text-foreground"
          >
            ← Back to dashboard
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <div className="mb-6 border-b border-border pb-4">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="mt-1 text-sm text-muted">
            Job platforms, where updates reach you, paired browsers, and interview alerts.
          </p>
        </div>

        <IntegrationsPanel />
      </div>
    </main>
  );
}
