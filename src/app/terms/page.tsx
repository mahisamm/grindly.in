import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/Brand";
import { PRODUCTS, formatAmount } from "@/lib/plans";

export const metadata: Metadata = { title: "Terms — Grindly" };

const UPDATED = "16 August 2026";

export default function TermsPage() {
  return (
    <>
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/"><Logo /></Link>
          <Link href="/privacy" className="text-muted hover:text-ink text-sm">Privacy</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-3xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
        <h1 className="font-display text-4xl font-bold">Terms</h1>
        <p className="text-muted mt-2 text-sm">Last updated {UPDATED}</p>

        <Section title="What Grindly does">
          <p>
            Grindly measures how well a machine can read your resume, rebuilds it
            onto a clean single-column layout, and tailors what it surfaces toward
            a role you name. That is the whole service.
          </p>
        </Section>

        <Section title="What we do not claim">
          <p>
            <b>There is no ATS score, and we do not promise one.</b> Applicant
            tracking systems parse resumes into fields for recruiters to search;
            they do not grade them and they do not reject on a score. The number
            Grindly shows is our own published rubric, computed by our own code.
            It is useful and it is reproducible. It is not a rating issued by any
            employer&rsquo;s software.
          </p>
          <p>
            We do not promise interviews, offers, or that any application will be
            read. Nobody can.
          </p>
        </Section>

        <Section title="Everything on your resume is your statement">
          <p>
            Grindly will not invent facts. Rewrites are checked against your
            source before they are produced: a rewrite cannot introduce a skill,
            an employer, a date or a number that your resume does not already
            contain, and one that tries is discarded rather than shown to you.
          </p>
          <p>
            That said, the finished document goes out under your name, and{" "}
            <b>you are responsible for it being true</b>. Read what we produce
            before you send it. If a rewrite has emphasised something in a way you
            cannot defend in an interview, change it. Do not use Grindly to
            misrepresent your qualifications to an employer.
          </p>
        </Section>

        <Section title="We do not apply on your behalf">
          <p>
            Grindly does not submit applications, does not log into job boards,
            and does not act on any account of yours. Bulk-submitting applications
            through a platform typically breaks that platform&rsquo;s terms and can
            get a candidate&rsquo;s account suspended. We hand you a PDF; sending it
            is your decision and your action.
          </p>
        </Section>

        <Section title="Company names">
          <p>
            Grindly is not affiliated with, endorsed by, or partnered with any
            company named in the product. Company names and trademarks belong to
            their owners and appear only to identify the employer you are applying
            to. Each company pack links to material that employer published
            itself, with the date a human last checked it — open the link and
            verify.
          </p>
        </Section>

        <Section title="Your account">
          <p>
            Keep your password to yourself; you are responsible for what happens
            under your account. Do not upload someone else&rsquo;s resume without
            their permission, do not attempt to reach another user&rsquo;s data, and
            do not try to break the service for other people.
          </p>
          <p>
            We may suspend an account that is being used to attack the service or
            to defraud employers. We will tell you why.
          </p>
        </Section>

        <Section title="Paying">
          <p>
            The {PRODUCTS.pass90.name} costs {formatAmount(PRODUCTS.pass90.amount)}{" "}
            and lasts {PRODUCTS.pass90.days} days. It is a one-time payment.{" "}
            <b>It does not auto-renew</b>, so there is nothing to cancel and
            nothing will be charged again. A single company pack costs{" "}
            {formatAmount(PRODUCTS.pack1.amount)}.
          </p>
          <p>
            When a pass ends you drop to the free plan and keep every resume and
            every PDF you have already made. Nothing is deleted.
          </p>
          <p>
            If the product does not work as described, email us within 7 days of
            paying and we will refund you. We will not refund a pass because a
            job application was unsuccessful — that is outside anything we control
            or promise. The full policy, including how to ask and how long a
            refund takes, is at{" "}
            <Link href="/refunds" className="text-brand underline">
              cancellations &amp; refunds
            </Link>.
          </p>
        </Section>

        <Section title="Availability and liability">
          <p>
            The service is provided as it is. We do not guarantee it will be
            available at any particular moment, and features that depend on
            third-party model providers can degrade when those providers do — in
            which case the readiness report still works, because it never needed
            them.
          </p>
          <p>
            To the extent the law allows, our total liability to you is limited to
            what you have paid us in the previous twelve months. Nothing here
            limits liability for fraud or for anything that cannot lawfully be
            limited.
          </p>
        </Section>

        <Section title="Changes and law">
          <p>
            If these terms change materially we will update the date above. These
            terms are governed by the laws of India.
          </p>
        </Section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted mx-auto flex max-w-4xl flex-wrap gap-5 px-5 py-8 sm:px-6 text-sm">
          <Link href="/" className="hover:text-ink">Home</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/refunds" className="hover:text-ink">Refunds</Link>
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
