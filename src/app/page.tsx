import Link from "next/link";
import { Nav, Logo } from "@/components/Brand";
import { Bolt, Doc, Target } from "@/components/Doodles";
import { Reveal } from "@/components/Motion";

const STEPS = [
  ["01", "Upload your resume", "Grindly reads your experience and skills once."],
  ["02", "Set your preferences", "Choose the roles, locations, match score, and daily limit you want."],
  ["03", "Receive useful matches", "The agent finds company opportunities, prepares each application, and sends only eligible applications you have authorised."],
] as const;

const BENEFITS = [
  ["Relevant roles", "Your resume and preferences filter out poor matches.", Target],
  ["You stay in control", "You set the daily limit, excluded companies, and whether auto-apply is on.", Bolt],
  ["Ready when you need to act", "Company forms can be sent with consent. Other platforms are prepared for your final review.", Doc],
] as const;

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main-content">
        <section className="grid-bg px-5 py-20 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-[var(--line-2)] bg-surface px-3 py-1.5 text-sm text-[var(--ink-soft)]">
              <span className="size-2 rounded-full bg-brand" /> Free, limited beta
            </p>
            <h1 className="display mt-5 text-[clamp(2.7rem,7vw,5rem)] tracking-[-0.03em]">
              Find better internships.<br />Let the agent handle the busywork.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-[var(--ink-soft)] sm:text-lg">
              Grindly finds roles that match your resume, prepares applications, and helps you apply within the limits you choose.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link href="/login" className="press rounded-full bg-brand px-7 py-3.5 text-sm font-semibold text-[var(--paper)] transition hover:bg-ink">
                Join the beta
              </Link>
              <a href="#how" className="press rounded-full border border-[var(--line-2)] px-7 py-3.5 text-sm font-semibold transition hover:bg-ink hover:text-[var(--paper)]">
                See how it works
              </a>
            </div>
            <p className="mx-auto mt-5 max-w-xl text-sm text-[var(--ink-mute)]">
              With your consent, Grindly can send eligible company applications. LinkedIn, Naukri, Unstop, and Indeed stay ready for your final submit.
            </p>
          </div>
        </section>

        <section id="features" className="border-t border-[var(--line-2)] px-5 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="display text-3xl sm:text-4xl">Only what helps your job search.</h2>
            </Reveal>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {BENEFITS.map(([title, body, Icon]) => (
                <Reveal key={title} className="rounded-xl border border-[var(--line)] bg-surface p-6">
                  <Icon size={22} />
                  <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">{body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="border-t border-[var(--line-2)] px-5 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <Reveal>
              <p className="text-sm font-semibold uppercase tracking-[0.14em] text-brand">How it works</p>
              <h2 className="display mt-2 text-3xl sm:text-4xl">Three simple steps.</h2>
            </Reveal>
            <div className="mt-8 divide-y divide-[var(--line)] border-y border-[var(--line)]">
              {STEPS.map(([number, title, body]) => (
                <Reveal key={number} className="grid gap-2 py-6 sm:grid-cols-[90px_1fr_1.4fr] sm:gap-5">
                  <span className="text-sm font-semibold text-brand">{number}</span>
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="text-sm leading-relaxed text-[var(--ink-soft)]">{body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--line-2)] px-5 py-16 sm:py-20">
          <Reveal className="mx-auto max-w-3xl rounded-2xl bg-ink px-7 py-12 text-center text-[var(--paper)] sm:px-12">
            <h2 className="display text-3xl sm:text-4xl">Free while we improve the beta.</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[rgba(242,236,225,0.72)]">
              No card required. Join with your resume, choose what you want, and keep full control over the agent.
            </p>
            <Link href="/login" className="press mt-7 inline-block rounded-full bg-brand px-7 py-3.5 text-sm font-semibold text-[var(--paper)] transition hover:bg-[var(--paper)] hover:text-ink">
              Join the beta
            </Link>
          </Reveal>
        </section>
      </main>
      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line-2)] px-5 py-8 text-sm text-[var(--ink-soft)]">
        <Logo size={26} withWordmark />
        <div className="flex gap-5">
          <Link href="/help" className="hover:text-brand">Help</Link>
          <Link href="/privacy" className="hover:text-brand">Privacy</Link>
          <Link href="/terms" className="hover:text-brand">Terms</Link>
        </div>
      </footer>
    </>
  );
}
