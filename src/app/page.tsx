import Link from "next/link";
import { Nav, Logo } from "@/components/Brand";
import { PLANS } from "@/lib/adapters/payment";
import { Reveal, CountUp } from "@/components/Motion";
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
    title: "Answer a few profile questions",
    body: "Domains, locations, stipend, daily limits. These become the agent's firewall — what it may and may not apply to.",
  },
  {
    n: "03",
    title: "Activate & choose updates",
    body: "Start with 5 free applications or choose a paid plan, then pick email or Slack reports. Connect Gmail to auto-detect interview calls.",
  },
  {
    n: "04",
    title: "You prepare, then submit",
    body: "It reads listings, scores each against your resume, and prepares supported matches for you to complete in your own browser.",
  },
  {
    n: "05",
    title: "Daily progress reports",
    body: "Every day you get a report: who it applied to, match scores, and what it skipped (and why). Update outcomes to track your interview rate.",
  },
];

const FEATURES = [
  ["Resume-aware matching", "Skills extracted from your resume score every role 0–100. Only real fits get an application.", Target],
  ["You set the firewall", "Min match score, max/day, excluded companies, stipend floor — hard constraints the agent can't cross.", Bolt],
  ["Real applications", "Opens supported listings, fills the form, and prepares it for your approval — not just a list of links.", Doc],
  ["You control every submission", "The agent prepares the match; you complete the final submission in your own browser. Pause anytime from the dashboard.", Clock],
  ["Daily reports your way", "Get progress reports via Slack DM or email — whichever you prefer. Connect Gmail to auto-detect interview calls.", Slack],
  ["Private by design", "Resume analysis uses only the AI providers configured for this service and degrades safely if they are unavailable. Your data is never sold.", Sparkle],
] as const;

export default function Home() {
  return (
    <>
      <Nav />

      {/* ───── HERO ───── */}
      <section className="grid-bg grain relative overflow-hidden">
        {/* animated gradient mesh backdrop */}
        <div className="mesh" aria-hidden />
        {/* floating doodles */}
        <PaperPlane className="absolute left-[6%] top-[18%] z-[1] hidden text-ink/70 lg:block wobble" />
        <Magnifier className="absolute right-[7%] top-[12%] z-[1] hidden text-ink/80 lg:block" />

        <div className="relative z-[2] mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:pt-20">
          {/* copy */}
          <div className="animate-in">
            <div className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-surface px-3 py-1 text-xs font-semibold">
              <span className="size-1.5 rounded-full bg-accent pulse-dot" />
              Your AI prepares your job search
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
              Grindly reads your resume, finds internships that actually match your
              skills and prepares supported matches. You complete final submission in your own browser.
              You get a daily report via email or Slack.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/login"
                className="rounded-2xl brand-gradient sticker press px-7 py-3.5 text-base font-semibold"
              >
                Get started now
              </Link>
              <a
                href="#how"
                className="rounded-2xl border-2 border-ink bg-surface press px-6 py-3.5 text-base font-semibold transition hover:bg-surface-2"
              >
                See how it works
              </a>
            </div>

            {/* Android — coming soon badge */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl border-2 border-ink bg-surface-2 px-5 py-2.5 text-sm font-semibold text-muted opacity-60">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M17.523 15.341 14 11.818V4.5a.5.5 0 0 0-1 0v7.318l-3.523 3.523a.5.5 0 0 0 .707.707L12 14.232l1.816 1.816a.5.5 0 0 0 .707-.707z" fill="currentColor"/>
                  <path d="M2.5 14.75A.75.75 0 0 1 3.25 14h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75zM20.25 14a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5z" fill="currentColor" opacity=".4"/>
                  <path d="M12 20.5c-4.694 0-8.5-3.806-8.5-8.5a.75.75 0 0 0-1.5 0c0 5.523 4.477 10 10 10s10-4.477 10-10a.75.75 0 0 0-1.5 0c0 4.694-3.806 8.5-8.5 8.5z" fill="currentColor"/>
                </svg>
                Android App
              </span>
              <span className="text-xs text-muted">Coming to Play Store soon</span>
            </div>

            <div className="mt-5 flex items-center gap-3 text-sm text-muted">
              <span className="flex text-[#ff7a1a]">
                {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={16} />)}
              </span>
              LinkedIn · Internshala · Naukri · Unstop · Indeed
            </div>
          </div>

          {/* dashboard sticker mock */}
          <div className="animate-in relative">
            <Resume className="absolute -left-6 -top-7 z-10 hidden text-ink sm:block wobble" />
            <Arrow className="absolute -right-4 top-1/2 hidden text-brand lg:block" />
            <div className="sticker tilt rounded-3xl bg-surface p-2.5">
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
                    ["Applied", 12, "text-brand"],
                    ["Avg match", 78, "text-accent"],
                    ["Skipped", 9, "text-muted"],
                  ].map(([label, val, c]) => (
                    <div key={label as string} className="rounded-xl border-2 border-ink bg-surface p-3">
                      <div className={`display text-3xl ${c}`}>
                        <CountUp value={val as number} />
                      </div>
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
      <section className="overflow-hidden border-y-2 border-ink bg-brand py-5 text-white">
        <div className="marquee-track">
          {[0, 1].map((dup) => (
            <span key={dup} className="display flex items-center text-4xl sm:text-5xl" aria-hidden={dup === 1}>
              {["THE AGENT THAT GROWS WITH YOU", "PREPARES MATCHES FOR YOU", "ZERO BUSYWORK"].map((t) => (
                <span key={t} className="flex items-center">
                  <span className="px-8">{t}</span>
                  <Star className="opacity-90" size={26} />
                </span>
              ))}
            </span>
          ))}
        </div>
        <div className="marquee-track-rev mt-2 text-white/55">
          {[0, 1].map((dup) => (
            <span key={dup} className="font-display flex items-center text-xl sm:text-2xl" aria-hidden={dup === 1}>
              {["resume-aware matching", "you set the firewall", "daily slack reports", "real applications, not links"].map((t) => (
                <span key={t} className="flex items-center">
                  <span className="px-6">{t}</span>
                  <Sparkle className="opacity-70" size={16} />
                </span>
              ))}
            </span>
          ))}
        </div>
      </section>

      {/* ───── FEATURES ───── */}
      <section className="glow-blue relative mx-auto max-w-6xl px-5 py-20">
        <Reveal className="relative z-[1] flex items-end justify-between gap-6">
          <h2 className="display max-w-xl text-4xl sm:text-5xl">
            Everything an intern-hunter <span className="text-brand">wishes</span> they had.
          </h2>
          <Magnifier className="hidden shrink-0 text-ink/70 md:block" size={70} />
        </Reveal>
        <div className="relative z-[1] mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([t, b, Icon], i) => (
            <Reveal key={t} delay={i * 80}>
              <div className="sticker tilt h-full rounded-3xl bg-surface p-6">
                <div className="mb-4 inline-flex size-14 items-center justify-center rounded-2xl border-2 border-ink bg-surface-2 text-ink">
                  <Icon size={34} />
                </div>
                <h3 className="font-display text-xl font-semibold">{t}</h3>
                <p className="mt-1.5 text-sm text-muted">{b}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ───── HOW IT WORKS ───── */}
      <section id="how" className="border-y-2 border-ink bg-surface-2/60">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <Reveal className="text-center">
            <h2 className="display text-4xl sm:text-5xl">How it works</h2>
            <p className="mt-3 text-muted">From signup to your first applications in minutes.</p>
          </Reveal>
          <div className="mt-14 grid gap-5 md:grid-cols-5">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 90} className="relative">
                <div className="sticker h-full rounded-3xl bg-surface p-5">
                  <div className="display text-4xl text-brand">{s.n}</div>
                  <h3 className="mt-3 font-display text-lg font-semibold leading-snug">{s.title}</h3>
                  <p className="mt-2 text-sm text-muted">{s.body}</p>
                </div>
                {i < STEPS.length - 1 && (
                  <Arrow className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 text-ink md:block" size={30} />
                )}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ───── PRICING ───── */}
      <section id="pricing" className="glow-blue relative mx-auto max-w-5xl px-5 py-20">
        <Reveal className="relative z-[1] text-center">
          <h2 className="display text-4xl sm:text-5xl">Simple pricing</h2>
          <p className="mt-3 text-muted">Cancel anytime.</p>
          {/* Checkout grants the plan without charging while RAZORPAY_KEY_ID is
              unset — so say so plainly rather than showing a price we don't take. */}
          <p className="mt-4 inline-block rounded-full border-2 border-ink bg-accent/15 px-4 py-1.5 text-sm font-semibold">
            Start with 5 successful applications free
          </p>
        </Reveal>
        <div className="relative z-[1] mt-12 grid gap-6 sm:grid-cols-2">
          {(Object.entries(PLANS) as [keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]][]).map(
            ([key, p], i) => (
              <Reveal
                key={key}
                delay={i * 100}
                className={`sticker tilt rounded-3xl p-7 ${key === "pro" ? "bg-brand text-white" : "bg-surface"}`}
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
                    "Tailors your resume per role",
                    key === "pro" ? "Dedicated email support" : "Community support",
                  ].map((f) => (
                    <li key={f} className={`flex items-center gap-2 ${key === "pro" ? "text-white/90" : "text-muted"}`}>
                      <span className={key === "pro" ? "text-[#ffd9b8]" : "text-accent"}>✓</span> {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/login?plan=${key}`}
                  className={`press mt-7 block rounded-2xl px-4 py-3 text-center font-semibold transition ${
                    key === "pro"
                      ? "border-2 border-ink bg-white text-brand hover:bg-white/90"
                      : "brand-gradient sticker-sm"
                  }`}
                >
                  Choose {p.name}
                </Link>
              </Reveal>
            )
          )}
        </div>
      </section>

      {/* ───── CTA ───── */}
      <section className="mx-auto max-w-5xl px-5 pb-24">
        <div className="sticker relative overflow-hidden rounded-[2rem] bg-brand p-8 sm:p-12 text-center text-white">
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
            href="/login"
            className="press mt-8 inline-block rounded-2xl border-2 border-ink bg-[#ff7a1a] px-8 py-3.5 font-semibold text-white shadow-[5px_5px_0_#16150f] transition hover:translate-y-[-2px]"
          >
            Get started free →
          </Link>
        </div>
      </section>

      <footer className="border-t-2 border-ink bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-muted sm:flex-row">
          <Logo size={24} />
          <div>© {new Date().getFullYear()} Grindly · Built for the intern grind.</div>
          <nav className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-ink hover:underline">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-ink hover:underline">Terms of Service</Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
