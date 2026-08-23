import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/Brand";
import { PRODUCTS, formatAmount } from "@/lib/plans";
import { SUPPORT_EMAIL } from "@/lib/support";

export const metadata: Metadata = { title: "Cancellations & refunds — Grindly" };

const UPDATED = "22 August 2026";

/**
 * The refund policy as its own page.
 *
 * The policy itself has lived in the Terms since launch; this page exists
 * because someone deciding whether to pay — and a payment provider deciding
 * whether to onboard us — should find it in one click from the footer, not
 * by reading a terms document to paragraph nine. Same policy, stated once
 * more, in full.
 */
export default function RefundsPage() {
  return (
    <>
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/"><Logo /></Link>
          <Link href="/terms" className="text-muted hover:text-ink text-sm">Terms</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
        <h1 className="font-display text-4xl font-bold">Cancellations &amp; refunds</h1>
        <p className="text-muted mt-2 text-sm">Last updated {UPDATED}</p>

        <Section title="There is nothing to cancel">
          <p>
            Every purchase is a one-time payment. The {PRODUCTS.pass90.name} (
            {formatAmount(PRODUCTS.pass90.amount)}) lasts {PRODUCTS.pass90.days} days and{" "}
            <b>does not auto-renew</b>; a company unlock (
            {formatAmount(PRODUCTS.pack1.amount)}) is likewise a one-time purchase — it
            never expires, so there is nothing recurring about it either. No
            subscription exists, so nothing recurs, nothing needs cancelling, and you will
            never be charged again without buying again.
          </p>
          <p>
            When a pass ends you drop to the free plan and keep every resume, every report
            and every PDF you made. Nothing is deleted.
          </p>
        </Section>

        <Section title="When we refund">
          <p>
            If the product does not work as described —{" "}
            <Link href="/terms" className="text-brand underline">the Terms</Link> say
            exactly what it does — email us within <b>7 days of paying</b> and we will
            refund you in full.
          </p>
          <p>
            We do not refund a pass because a job application was unsuccessful. Whether an
            employer replies is outside anything we control or promise, and the Terms make
            no promise about it.
          </p>
        </Section>

        <Section title="How to ask">
          <p>
            Email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand underline">
              {SUPPORT_EMAIL}
            </a>{" "}
            from the address on your Grindly account, with the payment reference from your
            payment confirmation. A person reads these — say what did not work as
            described.
          </p>
          <p>
            Approved refunds are issued to the original payment method within{" "}
            <b>5–7 business days</b> of approval; your bank or UPI app may take a further
            few days to show it.
          </p>
        </Section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted mx-auto flex max-w-4xl flex-wrap gap-5 px-5 py-8 text-sm sm:px-6">
          <Link href="/" className="hover:text-ink">Home</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/contact" className="hover:text-ink">Contact</Link>
        </div>
      </footer>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 leading-relaxed">{children}</div>
    </section>
  );
}
