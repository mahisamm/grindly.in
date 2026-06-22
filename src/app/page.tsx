import Link from "next/link";
import { Nav, Logo } from "@/components/Brand";
import { PLANS } from "@/lib/adapters/payment";
import {
  Magnifier, PaperPlane, Resume, Sparkle, Arrow, Clock,
  Bolt, Target, Doc, Slack, Star,
} from "@/components/Doodles";

const STEPS = [
  {
    n: "01",
    title: "Drop your resume",
    body: "Create an account and upload your resume. That's the only homework you do.",
  },
  {
    n: "02",
    title: "Answer a few proff questions",
    body: "Domains, locations, stipend, daily limits. These become the agent's firewall — what it may and may not apply to.",
  },
  {
    n: "03",
    title: "Pay & connect Slack",
    body: "After checkout, the bot DMs you on Slack to confirm preferences and say it's starting.",
  },
  {
    n: "04",
    title: "The agent applies for you",
    body: "It reads listings, scores each against your resume, and auto-applies to the strong matches — within your limits.",
  },
  {
    n: "05",
    title: "Daily progress reports",
    body: "Every day it pings you on Slack: who it applied to, match scores, and what it skipped (and why).",
  },
];

const FEATURES = [
  ["Resume-aware matching", "Skills extracted from your resume score every role 0–100. Only real fits get an application.", Target],
  ["You set the firewall", "Min match score, max/day, excluded companies, stipend floor — hard constraints the agent can't cross.", Bolt],
  ["Real applications", "Drives the platform like a human: opens the listing, fills the form, submits. Not just a list of links.", Doc],
  ["Runs on your terms", "Auto-submit, or shortlist-and-ask. Pause anytime from the dashboard.", Clock],
  ["Slack-native updates", "Onboarding questions and daily reports come to you in Slack — no new app to babysit.", Slack],
  ["Private brain", "Resume analysis runs on a local LLM. Your resume isn't shipped to a third-party model.", Sparkle],
] as const;

export default function Home() {
  return (
    <>
      <Nav />

      {/* ───── HERO ───── */}
      <section className="grid-bg relative overflow-hidden">
        {/* floating doodles */}
        <PaperPlane className="absolute left-[6%] top-[18%] hidden text-ink/70 lg:block wobble" />
        <Magnifier className="absolute right-[7%] top-[12%] hidden text-ink/80 lg:block" />
        <Sparkle className="absolute left-[14%] bottom-[14%] hidden text-brand md:block" size={30} />

        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:pt-20">
          {/* copy */}
          <div className="animate-in">
            <div className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-surface px-3 py-1 text-xs font-semibold">
              <span className="size-1.5 rounded-full bg-accent pulse-dot" />
              Your AI applies while you sleep
            </div>

            <h1 className="display mt-6 text-[3.1rem] leading-[0.92] sm:text-[4.3rem]">
              Stop filling
              <br />
              internship
              <br />
              forms. <span className="squiggle italic text-brand">let an</span>
              <br />
              <span className="italic text-brand">agent do it.</span>
            </h1>

            <p className="mt-7 max-w-md text-lg text-muted">
              NexPath reads your resume, finds internships that actually match your
              skills, and applies for you — every day, inside the limits you set.
              You just read the Slack report.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/signup"
                className="rounded-2xl brand-gradient sticker px-7 py-3.5 text-base font-semibold"
              >
                Get started now
              </Link>
              <a
                href="#how"
                className="rounded-2xl border-2 border-ink bg-surface px-6 py-3.5 text-base font-semibold transition hover:bg-surface-2"
              >
                See how it works
              </a>
            </div>

            <div className="mt-7 flex items-center gap-3 text-sm text-muted">
              <span className="flex text-[#ff7a1a]">
                {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={16} />)}
              </span>
              Built for the intern grind across 5 platforms
            </div>
          </div>

          {/* dashboard sticker mock */}
          <div className="animate-in relative">
            <Resume className="absolute -left-6 -top-7 z-10 hidden text-ink sm:block wobble" />
            <Arrow className="absolute -right-4 top-1/2 hidden text-brand lg:block" />
            <div className="sticker rounded-3xl bg-surface p-2.5">
              <div className="rounded-2xl bg-surface-2 p-5">
                <div className="flex items-center justify-between border-b-2 border-dashed border-border pb-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <span className="size-2 rounded-full bg-accent pulse-dot" />
                    Agent active · Pro plan
                  </div>
                  <div className="text-xs text-muted">Today</div>
                </div>
                <div className="grid grid-cols-3 gap-3 py-4">
                  {[
                    ["Applied", "12", "text-brand"],
                    ["Avg match", "78", "text-accent"],
                    ["Skipped", "9", "text-muted"],
                  ].map(([label, val, c]) => (
                    <div key={label} className="rounded-xl border-2 border-ink bg-surface p-3">
                      <div className={`display text-3xl ${c}`}>{val}</div>
                      <div className="text-xs text-muted">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  {[
                    ["Frontend Developer Intern", "Razorpay", 86, "applied"],
                    ["Data Science Intern", "Swiggy", 81, "applied"],
                    ["ML Research Intern", "Sarvam AI", 74, "applied"],
                    ["Sales Intern", "LocalBiz", 38, "skipped"],
                  ].map(([title, co, score, st]) => (
                    <div
                      key={title as string}
                      className="flex items-center justify-between rounded-xl border-2 border-ink bg-surface px-3 py-2 text-sm"
                    >
                      <div>
                        <div className="font-semibold">{title}</div>
                        <div className="text-xs text-muted">{co}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-semibold text-brand">{score as number}</span>
                        <span
                          className={`rounded-md border border-ink px-2 py-0.5 text-xs font-semibold ${
                            st === "applied" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"
                          }`}
                        >
                          {st as string}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───── BLUE MARQUEE BAND ───── */}
      <section className="border-y-2 border-ink bg-brand py-5 text-white">
        <div className="marquee-track">
          {[0, 1].map((dup) => (
            <span key={dup} className="display flex items-center text-4xl sm:text-5xl" aria-hidden={dup === 1}>
              {["THE AGENT THAT GROWS WITH YOU", "APPLIES WHILE YOU SLEEP", "5 PLATFORMS, ONE BOT"].map((t) => (
                <span key={t} className="flex items-center">
                  <span className="px-8">{t}</span>
                  <Star className="opacity-90" size={26} />
                </span>
              ))}
            </span>
          ))}
        </div>
      </section>

      {/* ───── FEATURES ───── */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="flex items-end justify-between gap-6">
          <h2 className="display max-w-xl text-4xl sm:text-5xl">
            Everything an intern-hunter <span className="text-brand">wishes</span> they had.
          </h2>
          <Magnifier className="hidden shrink-0 text-ink/70 md:block" size={70} />
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([t, b, Icon]) => (
            <div key={t} className="sticker rounded-3xl bg-surface p-6">
              <div className="mb-4 inline-flex size-14 items-center justify-center rounded-2xl border-2 border-ink bg-surface-2 text-ink">
                <Icon size={34} />
              </div>
              <h3 className="font-display text-xl font-semibold">{t}</h3>
              <p className="mt-1.5 text-sm text-muted">{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───── HOW IT WORKS ───── */}
      <section id="how" className="border-y-2 border-ink bg-surface-2/60">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="text-center">
            <h2 className="display text-4xl sm:text-5xl">How it works</h2>
            <p className="mt-3 text-muted">From signup to your first applications in minutes.</p>
          </div>
          <div className="mt-14 grid gap-5 md:grid-cols-5">
            {STEPS.map((s, i) => (
              <div key={s.n} className="relative">
                <div className="sticker h-full rounded-3xl bg-surface p-5">
                  <div className="display text-4xl text-brand">{s.n}</div>
                  <h3 className="mt-3 font-display text-lg font-semibold leading-snug">{s.title}</h3>
                  <p className="mt-2 text-sm text-muted">{s.body}</p>
                </div>
                {i < STEPS.length - 1 && (
                  <Arrow className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 text-ink md:block" size={30} />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── PRICING ───── */}
      <section id="pricing" className="mx-auto max-w-5xl px-5 py-20">
        <div className="text-center">
          <h2 className="display text-4xl sm:text-5xl">Simple pricing</h2>
          <p className="mt-3 text-muted">Cancel anytime. Test-mode billing while local.</p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {(Object.entries(PLANS) as [keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]][]).map(
            ([key, p]) => (
              <div
                key={key}
                className={`sticker rounded-3xl p-7 ${key === "pro" ? "bg-brand text-white" : "bg-surface"}`}
              >
                {key === "pro" && (
                  <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border-2 border-ink bg-[#ff7a1a] px-3 py-0.5 text-xs font-bold text-white">
                    <Sparkle size={13} /> Most popular
                  </div>
                )}
                <div className="font-display text-lg font-semibold">{p.name}</div>
                <div className="display mt-2 text-5xl">
                  ₹{p.price}
                  <span className={`font-display text-base font-normal ${key === "pro" ? "text-white/70" : "text-muted"}`}>/mo</span>
                </div>
                <p className={`mt-2 text-sm ${key === "pro" ? "text-white/80" : "text-muted"}`}>{p.blurb}</p>
                <ul className="mt-6 space-y-2.5 text-sm">
                  {[
                    `${p.perDay} applications / day`,
                    "Resume-aware matching",
                    "Daily Slack reports",
                    key === "pro" ? "Priority match queue" : "Email support",
                  ].map((f) => (
                    <li key={f} className={`flex items-center gap-2 ${key === "pro" ? "text-white/90" : "text-muted"}`}>
                      <span className={key === "pro" ? "text-[#ffd9b8]" : "text-accent"}>✓</span> {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={`mt-7 block rounded-2xl px-4 py-3 text-center font-semibold transition ${
                    key === "pro"
                      ? "border-2 border-ink bg-white text-brand hover:bg-white/90"
                      : "brand-gradient sticker-sm"
                  }`}
                >
                  Choose {p.name}
                </Link>
              </div>
            )
          )}
        </div>
      </section>

      {/* ───── CTA ───── */}
      <section className="mx-auto max-w-5xl px-5 pb-24">
        <div className="sticker relative overflow-hidden rounded-[2rem] bg-brand p-12 text-center text-white">
          <Sparkle className="absolute left-8 top-8 text-white/40" size={34} />
          <PaperPlane className="absolute right-8 bottom-6 hidden text-white/40 sm:block" size={70} />
          <h2 className="display text-4xl sm:text-5xl">
            Your next internship is
            <br />
            one signup away.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-white/80">
            Let the agent grind the applications. You focus on the interviews.
          </p>
          <Link
            href="/signup"
            className="mt-8 inline-block rounded-2xl border-2 border-ink bg-[#ff7a1a] px-8 py-3.5 font-semibold text-white shadow-[5px_5px_0_#16150f] transition hover:translate-y-[-2px]"
          >
            Get started free →
          </Link>
        </div>
      </section>

      <footer className="border-t-2 border-ink bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-muted sm:flex-row">
          <Logo size={24} />
          <div>© {new Date().getFullYear()} NexPath · Built for the intern grind.</div>
        </div>
      </footer>
    </>
  );
}
