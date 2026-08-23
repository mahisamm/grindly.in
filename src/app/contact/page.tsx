import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/Brand";
import { SUPPORT_EMAIL } from "@/lib/support";

export const metadata: Metadata = { title: "Contact — Grindly" };

/**
 * A way to reach a person, findable without an account.
 *
 * Signed-in users have the report widget in the corner of every page, which
 * is the faster route because it carries the page and resume context with
 * it. This page exists for everyone else: someone deciding whether to pay,
 * someone locked out, a payment provider's reviewer.
 */
export default function ContactPage() {
  return (
    <>
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/"><Logo /></Link>
          <Link href="/pricing" className="text-muted hover:text-ink text-sm">Pricing</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
        <h1 className="font-display text-4xl font-bold">Contact</h1>
        <p className="text-muted mt-2 text-sm">A person reads everything sent here.</p>

        <Section title="Email">
          <p>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-brand underline">
              {SUPPORT_EMAIL}
            </a>{" "}
            — for anything: a question before paying, a refund request, a problem with
            your account, something the product got wrong. We aim to reply within{" "}
            <b>2 business days</b>, usually much faster.
          </p>
          <p>
            For account or payment matters, write from the email address on your Grindly
            account so we can find you.
          </p>
        </Section>

        <Section title="Signed in already?">
          <p>
            The <b>Report a problem</b> button in the corner of every page inside the app
            is faster — it sends your message with the page you were on attached, so
            &ldquo;the rewrite came out wrong&rdquo; arrives as something we can open and
            fix.
          </p>
        </Section>

        <Section title="Operated by">
          <p>
            Grindly is built and operated by Sammeta Sakthi Mahendhar, Hyderabad, India.
            Payments are processed by Razorpay; see{" "}
            <Link href="/refunds" className="text-brand underline">
              cancellations &amp; refunds
            </Link>{" "}
            for how refunds work.
          </p>
        </Section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted mx-auto flex max-w-4xl flex-wrap gap-5 px-5 py-8 text-sm sm:px-6">
          <Link href="/" className="hover:text-ink">Home</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/refunds" className="hover:text-ink">Refunds</Link>
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
