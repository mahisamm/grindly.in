import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/Brand";
import { currentUser } from "@/lib/auth";
import { paymentsEnabled } from "@/lib/config";
import { LIMITS, PRODUCTS, formatAmount } from "@/lib/plans";
import { Checkout } from "./Checkout";

export const metadata: Metadata = { title: "Pricing — Grindly" };
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const user = await currentUser();
  // Server-side, so a stub deployment cannot render a price beside a free grant.
  const paymentsLive = paymentsEnabled();

  return (
    <>
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/"><Logo /></Link>
          <Link href={user ? "/app" : "/signup"} className="btn btn-primary text-sm">
            {user ? "Your resumes" : "Start free"}
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl flex-1 px-5 py-12 sm:px-6 sm:py-16">
        <h1 className="font-display text-4xl font-bold text-balance sm:text-5xl">
          A pass, not a subscription
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed">
          A job search is weeks, not years — a placement season runs six to ten, and
          changing companies with four years behind you takes about the same. Charging
          every month for a product you need once is how a company makes money from
          people forgetting to cancel. Buy a pass, it ends on its own, and you keep
          everything you made.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <div className="bg-surface border-border flex flex-col rounded-xl border p-6">
            <p className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">Free</p>
            <p className="font-display mt-3 text-4xl font-bold">₹0</p>
            <p className="text-muted mt-1 text-sm">forever</p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              <Feature>The complete readiness report</Feature>
              <Feature>{LIMITS.free.resumes} resumes</Feature>
              <Feature>{LIMITS.free.variantRunsPerDay} rebuilds a day</Feature>
              <Feature>{LIMITS.free.targetsPerResume} company target per resume</Feature>
              <Feature>No watermark on your PDF</Feature>
            </ul>
            <Link href="/signup" className="btn mt-6 w-full justify-center">
              Start free
            </Link>
          </div>

          <div
            className="bg-surface flex flex-col rounded-xl border-2 p-6"
            style={{ borderColor: "var(--brand)" }}
          >
            <p className="text-brand font-mono text-[11px] tracking-[0.14em] uppercase">
              {PRODUCTS.pass90.name}
            </p>
            <p className="font-display mt-3 text-4xl font-bold">
              {formatAmount(PRODUCTS.pass90.amount)}
            </p>
            <p className="text-muted mt-1 text-sm">
              {PRODUCTS.pass90.days} days · one payment · no auto-renew
            </p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              <Feature>{LIMITS.pass.resumes} resumes</Feature>
              <Feature>{LIMITS.pass.variantRunsPerDay} rebuilds a day</Feature>
              <Feature>Every company pack, unlimited</Feature>
              <Feature>Paste any job description</Feature>
              <Feature>Every rewrite kept until you replace it</Feature>
            </ul>
            <Checkout sku="pass90" signedIn={Boolean(user)} paymentsLive={paymentsLive} />
          </div>

          <div className="bg-surface border-border flex flex-col rounded-xl border p-6">
            <p className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
              {PRODUCTS.pack1.name}
            </p>
            <p className="font-display mt-3 text-4xl font-bold">
              {formatAmount(PRODUCTS.pack1.amount)}
            </p>
            <p className="text-muted mt-1 text-sm">one company, {PRODUCTS.pack1.days} days</p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              <Feature>Three tailored rebuilds</Feature>
              <Feature>The gap report for that role</Feature>
              <Feature>For the deadline that is tonight</Feature>
            </ul>
            <Checkout sku="pack1" signedIn={Boolean(user)} paymentsLive={paymentsLive} />
          </div>
        </div>

        <section className="border-border mt-16 border-t pt-10">
          <h2 className="font-display text-2xl font-semibold">Questions people actually ask</h2>
          <dl className="mt-6 grid gap-8 sm:grid-cols-2">
            {[
              [
                "Will this get me above 80 on the ATS?",
                "No, and nobody can promise that — there is no ATS score. What we give you is a score on our own published rubric, and the count of how many of your facts a parser recovered from the PDF we built. Both are things you can check.",
              ],
              [
                "Will it write experience I do not have?",
                "It is built not to. Three gates run before any rebuild is rendered: no technology absent from your resume, no employer, date or metric whose words are not in your source, and every entry has to descend from a real one. If a role wants something you lack, we tell you rather than writing it in. We still ask you to read the result before you send it — no automated check is perfect, and the document goes out under your name.",
              ],
              [
                "Does it auto-apply to jobs for me?",
                "No, deliberately. Bulk-submitting applications through job boards breaks their terms and gets accounts banned. Grindly gives you the document; you send it.",
              ],
              [
                "What happens when my pass ends?",
                "You drop to the free plan and keep every resume and every PDF you built. Nothing is deleted and nothing stops working.",
              ],
            ].map(([q, a]) => (
              <div key={q}>
                <dt className="font-display text-lg font-semibold">{q}</dt>
                <dd className="text-muted mt-1.5 leading-relaxed">{a}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted mx-auto flex max-w-6xl flex-wrap gap-5 px-5 py-8 sm:px-6 text-sm">
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
        </div>
      </footer>
    </>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-brand" aria-hidden="true">·</span>
      <span>{children}</span>
    </li>
  );
}
