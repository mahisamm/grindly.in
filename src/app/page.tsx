import Link from "next/link";
import { Nav, Logo } from "@/components/Brand";
import { PLANS } from "@/lib/adapters/payment";
import { Reveal, CountUp } from "@/components/Motion";
import { Target, Bolt, Doc, Clock, Slack, Sparkle } from "@/components/Doodles";

const STEPS = [
  ["01", "Drop your resume", "Create an account and upload your resume. That's the only homework you do."],
  ["02", "Answer a few profile questions", "Domains, locations, stipend, daily limits. These become the agent's firewall — what it may and may not apply to."],
  ["03", "Start free & choose updates", "Activate the free plan — 5 applications a day — then pick email or Slack reports. Connect Gmail to auto-detect interview calls."],
  ["04", "You prepare, then submit", "It reads listings, scores each against your resume, and prepares supported matches for you to complete in your own browser."],
  ["05", "Daily progress reports", "Every day you get a report: who it applied to, match scores, and what it skipped (and why). Update outcomes to track your interview rate."],
] as const;

const FEATURES = [
  ["Resume-aware matching", "Skills extracted from your resume score every role 0–100. Only real fits get an application.", Target],
  ["You set the firewall", "Min match score, max/day, excluded companies, stipend floor — hard constraints the agent can't cross.", Bolt],
  ["Real applications", "Opens supported listings, fills the form, and prepares it for your approval — not just a list of links.", Doc],
  ["You control every submission", "The agent prepares the match; you complete the final submission in your own browser. Pause anytime from the dashboard.", Clock],
  ["Daily reports your way", "Get progress reports via Slack DM or email — whichever you prefer. Connect Gmail to auto-detect interview calls.", Slack],
  ["Private by design", "Resume analysis uses only the AI providers configured for this service and degrades safely if they're unavailable. Your data is never sold.", Sparkle],
] as const;

const MOCK_ROWS = [
  ["Frontend Developer Intern", "Razorpay", 86, "applied"],
  ["Data Science Intern", "Swiggy", 81, "applied"],
  ["ML Research Intern", "Sarvam AI", 74, "ready"],
  ["Sales Intern", "LocalBiz", 38, "skipped"],
] as const;

export default function Home() {
  return (
    <>
      <Nav />

      {/* ══════════ HERO ══════════ */}
      <section className="grid-bg relative overflow-hidden">
        <div className="mesh" aria-hidden />
        <div className="relative z-[2] mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-5 pb-24 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:pt-20">
          {/* copy */}
          <div className="animate-in">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-[var(--line-2)] bg-[rgba(250,246,238,0.6)] px-3.5 py-1.5 text-[0.82rem] text-[var(--ink-soft)]">
              <span className="size-[7px] rounded-full bg-brand pulse-dot" />
              Your AI applies while you <em className="font-display not-italic text-ink italic">sleep</em>
            </div>

            <h1 className="display mt-4 text-[clamp(2.5rem,5.8vw,4.1rem)] tracking-[-0.02em]">
              <span className="block">Stop filling</span>
              <span className="block">internship forms.</span>
              <span className="block accent-italic">let an agent do it.</span>
            </h1>

            <p className="mt-4 max-w-[44ch] text-[var(--ink-soft)] leading-relaxed">
              Grindly reads your resume, finds internships that actually match your
              skills, and prepares supported matches — every day, inside the limits
              you set. You complete the final submission in your own browser and get
              a daily report via email or Slack.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <Link
                href="/login"
                className="press inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-[0.8rem] font-semibold uppercase tracking-[0.08em] text-[var(--paper)] transition hover:bg-ink"
              >
                Get started free
              </Link>
              <a
                href="#how"
                className="press inline-flex items-center gap-2 rounded-full border border-[var(--line-2)] px-6 py-3 text-[0.8rem] font-semibold uppercase tracking-[0.08em] transition hover:bg-ink hover:text-[var(--paper)] hover:border-ink"
              >
                See how it works
              </a>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.78rem] text-[var(--ink-mute)]">
              <span className="inline-flex cursor-not-allowed items-center gap-2 rounded-full border border-dashed border-[var(--line-2)] px-3 py-1.5 opacity-75">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M7.2 9.5a1 1 0 0 1 1-1h7.6a1 1 0 0 1 1 1v6.2a2 2 0 0 1-2 2H9.2a2 2 0 0 1-2-2V9.5z" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8.6 8.4 7.4 6.3M15.4 8.4l1.2-2.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Android app — coming to Play Store soon
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="tracking-[0.18em] text-brand">✦✦✦✦✦</span>
                Built for the intern grind across 5 platforms
              </span>
            </div>
          </div>

          {/* dashboard mock — proto panel */}
          <Reveal className="relative">
            <div className="rounded-[6px] border border-[var(--line-2)] bg-surface p-4 sm:p-6 shadow-[8px_8px_0_rgba(23,20,15,0.08)]">
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-dashed border-[var(--line-2)] pb-3 text-[0.78rem]">
                <span className="inline-flex items-center gap-2 font-semibold">
                  <span className="size-[7px] rounded-full bg-brand pulse-dot" /> Agent active · Free plan
                </span>
                <span className="text-[0.68rem] uppercase tracking-[0.12em] text-[var(--ink-mute)]">Today</span>
              </div>
              <div className="mb-4 grid grid-cols-3 gap-2.5">
                {[["Applied", 5, "brand"], ["Avg match", 78, ""], ["Ready", 3, "mute"]].map(([label, n, kind]) => (
                  <div key={label as string} className="rounded-[6px] border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
                    <b className={`block font-display text-[1.9rem] leading-none tabular-nums ${kind === "brand" ? "text-brand" : kind === "mute" ? "text-[var(--ink-mute)]" : ""}`}>
                      <CountUp value={n as number} />
                    </b>
                    <span className="text-[0.66rem] uppercase tracking-[0.1em] text-[var(--ink-mute)]">{label}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                {MOCK_ROWS.map(([title, company, score, tag]) => (
                  <div key={title} className="flex items-center justify-between gap-3 rounded-[6px] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[0.82rem]">
                    <div>
                      <b className="block font-semibold leading-tight">{title}</b>
                      <small className="text-[0.72rem] text-[var(--ink-mute)]">{company}</small>
                    </div>
                    <div className="flex flex-none items-center gap-2.5">
                      <span className="font-display font-black tabular-nums" style={{ color: tag === "skipped" ? "var(--ink-mute)" : "var(--vermilion)" }}>{score}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.1em] ${
                        tag === "skipped"
                          ? "border-[var(--line-2)] text-[var(--ink-mute)]"
                          : "border-brand bg-[rgba(227,64,42,0.07)] text-brand"
                      }`}>{tag}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ══════════ MARQUEE ══════════ */}
      <section className="relative z-[5] overflow-hidden border-y border-ink bg-ink py-5 text-[var(--paper)]" aria-hidden>
        <div className="marquee-track">
          {[0, 1].map((k) => (
            <span key={k} className="flex items-center">
              {["THE AGENT THAT GROWS WITH YOU", "PREPARES WHILE YOU SLEEP", "5 PLATFORMS, ONE BOT"].map((t) => (
                <span key={t} className="flex items-center">
                  <span className="px-[clamp(18px,2.6vw,34px)] font-display text-[clamp(1.9rem,4vw,3rem)] tracking-[-0.01em]">{t}</span>
                  <span className="text-brand">✦</span>
                </span>
              ))}
            </span>
          ))}
        </div>
        <div className="marquee-track-rev mt-2.5 text-[rgba(242,236,225,0.55)]">
          {[0, 1].map((k) => (
            <span key={k} className="flex items-center">
              {["resume-aware matching", "you set the firewall", "daily slack reports", "you approve every submit"].map((t) => (
                <span key={t} className="px-[clamp(18px,2.6vw,34px)] font-display text-[clamp(1rem,1.8vw,1.35rem)] italic font-light">{t} ·</span>
              ))}
            </span>
          ))}
        </div>
      </section>

      {/* ══════════ 01 — FEATURES ══════════ */}
      <section id="features" className="relative z-[5] border-t border-[var(--line-2)] px-[clamp(18px,5vw,80px)] py-[clamp(60px,9vw,120px)]">
        <div className="mb-[clamp(40px,6vw,72px)] grid grid-cols-1 items-center gap-[clamp(20px,4vw,60px)] lg:grid-cols-[1.05fr_0.95fr]">
          <Reveal>
            <span className="text-[0.72rem] font-medium uppercase tracking-[0.16em] text-brand">01 — Features</span>
            <h2 className="mt-2.5 text-[clamp(2.2rem,5vw,3.6rem)] leading-[0.98] tracking-[-0.02em]">
              Everything an intern-hunter <span className="accent-italic">wishes</span> they had.
            </h2>
            <p className="mt-3.5 max-w-[44ch] text-[var(--ink-soft)]">
              The agent drives job platforms like a human would — reads listings,
              scores them against your resume, fills the forms, and prepares each
              one for your approval. You watch it happen from one dashboard.
            </p>
          </Reveal>
          <Reveal delay={80} className="hidden lg:block">
            <div className="rounded-[6px] border border-[var(--line-2)] bg-surface p-6 shadow-[8px_8px_0_rgba(23,20,15,0.08)]">
              <p className="font-display text-[1.4rem] leading-tight">
                “It applied to 5 solid matches before I woke up — and skipped the junk.”
              </p>
              <p className="mt-3 text-[0.8rem] uppercase tracking-[0.1em] text-[var(--ink-mute)]">— the point of Grindly</p>
            </div>
          </Reveal>
        </div>

        <div className="grid grid-cols-1 border-l border-t border-[var(--line)] sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([title, body, Icon], i) => (
            <Reveal key={title} delay={(i % 3) * 70} className="group border-b border-r border-[var(--line)] p-[clamp(20px,2.6vw,34px)] transition-colors hover:bg-surface">
              <span className="mb-3.5 inline-grid size-11 place-items-center rounded-xl border border-[var(--line-2)] text-ink transition-colors group-hover:border-brand group-hover:bg-brand group-hover:text-[var(--paper)]">
                <Icon size={20} />
              </span>
              <h3 className="text-[1.25rem] font-black">{title}</h3>
              <p className="mt-1.5 text-[0.86rem] leading-relaxed text-[var(--ink-soft)]">{body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ══════════ 02 — HOW IT WORKS ══════════ */}
      <section id="how" className="relative z-[5] border-t border-[var(--line-2)] px-[clamp(18px,5vw,80px)] py-[clamp(60px,9vw,120px)]">
        <Reveal className="mb-[clamp(30px,5vw,60px)]">
          <span className="text-[0.72rem] font-medium uppercase tracking-[0.16em] text-brand">02 — How it works</span>
          <h2 className="mt-2.5 text-[clamp(2.2rem,5vw,3.6rem)] tracking-[-0.02em]">How it works</h2>
          <p className="mt-3.5 text-[var(--ink-soft)]">From signup to your first prepared matches in minutes.</p>
        </Reveal>

        <div className="border-t border-[var(--line)]">
          {STEPS.map(([n, title, body]) => (
            <Reveal key={n} className="group grid grid-cols-[90px_1fr] items-center gap-5 border-b border-[var(--line)] py-[clamp(14px,2vw,26px)] transition-all hover:bg-surface hover:pl-3.5 md:grid-cols-[120px_1fr_minmax(0,380px)]">
              <span className="text-[0.72rem] uppercase tracking-[0.1em] tabular-nums text-[var(--ink-mute)]">Step · {n}</span>
              <span className="font-display text-[clamp(1.5rem,3.2vw,2.6rem)] leading-tight tracking-[-0.01em] transition-colors group-hover:text-brand">{title}</span>
              <span className="col-start-2 text-[0.84rem] leading-relaxed text-[var(--ink-soft)] md:col-start-3">{body}</span>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ══════════ 03 — PRICING (dark) ══════════ */}
      <section id="pricing" className="relative z-[5] bg-ink px-[clamp(18px,5vw,80px)] py-[clamp(60px,9vw,120px)] text-[var(--paper)]">
        <Reveal className="flex items-baseline gap-4">
          <span className="text-[0.72rem] font-medium uppercase tracking-[0.16em] text-brand">03 — Pricing</span>
        </Reveal>
        <Reveal>
          <h2 className="mt-2 text-[clamp(2.6rem,6vw,5rem)] tracking-[-0.02em] text-[var(--paper)]">Free while we're in beta</h2>
          <p className="mt-3 text-[0.95rem] text-[rgba(242,236,225,0.6)]">No card, no catch. Paid plans come later.</p>
        </Reveal>

        <div className="mt-[clamp(32px,5vw,56px)] grid grid-cols-1 justify-center gap-[clamp(16px,2vw,26px)] md:grid-cols-[repeat(3,minmax(0,340px))]">
          {/* Free — the only pickable plan */}
          <Reveal className="relative flex flex-col gap-4 rounded-[4px] border border-[rgba(242,236,225,0.3)] bg-[rgba(242,236,225,0.04)] p-[clamp(24px,2.6vw,34px)] transition-all hover:-translate-y-1 hover:border-brand">
            <span className="absolute -top-2.5 left-[clamp(24px,2.6vw,34px)] rounded-full bg-brand px-2.5 py-1 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-[var(--paper)]">✦ Free during beta</span>
            <div className="flex items-baseline justify-between gap-2.5 border-b border-[rgba(242,236,225,0.16)] pb-4">
              <h3 className="font-display text-[clamp(1.6rem,2.6vw,2.2rem)] text-[var(--paper)]">Free</h3>
              <span className="whitespace-nowrap font-display text-[clamp(1.4rem,2.2vw,1.9rem)] text-brand">₹0<small className="text-[0.8rem] font-normal text-[rgba(242,236,225,0.55)]"> /mo</small></span>
            </div>
            <p className="text-[0.9rem] leading-relaxed text-[rgba(242,236,225,0.7)]">Up to 5 applications a day, every day.</p>
            <ul className="flex flex-col gap-2.5">
              {["5 applications / day", "Resume-aware matching", "Daily email or Slack reports", "Community support"].map((f) => (
                <li key={f} className="relative pl-4.5 text-[0.82rem] text-[rgba(242,236,225,0.82)] before:absolute before:left-0 before:top-[0.5em] before:size-1.5 before:rounded-full before:bg-brand">{f}</li>
              ))}
            </ul>
            <Link href="/login" className="press mt-auto block rounded-full bg-brand px-4 py-3 text-center text-[0.78rem] font-medium uppercase tracking-[0.1em] text-[var(--paper)] transition hover:bg-[var(--paper)] hover:text-ink">
              Get started free
            </Link>
          </Reveal>

          {/* Plus / Pro — coming soon, no checkout */}
          {(Object.entries(PLANS) as [keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]][]).map(([key, p], i) => (
            <Reveal key={key} delay={(i + 1) * 80} className="relative flex flex-col gap-4 rounded-[4px] border border-[rgba(242,236,225,0.18)] p-[clamp(24px,2.6vw,34px)] opacity-80">
              <span className="absolute -top-2.5 left-[clamp(24px,2.6vw,34px)] rounded-full border border-[rgba(242,236,225,0.3)] bg-ink px-2.5 py-1 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-[rgba(242,236,225,0.7)]">Coming soon</span>
              <div className="flex items-baseline justify-between gap-2.5 border-b border-[rgba(242,236,225,0.16)] pb-4">
                <h3 className="font-display text-[clamp(1.6rem,2.6vw,2.2rem)] text-[var(--paper)]">{p.name}</h3>
                <span className="whitespace-nowrap font-display text-[clamp(1.4rem,2.2vw,1.9rem)] text-brand">₹{p.price}<small className="text-[0.8rem] font-normal text-[rgba(242,236,225,0.55)]"> /mo</small></span>
              </div>
              <p className="text-[0.9rem] leading-relaxed text-[rgba(242,236,225,0.7)]">{p.blurb}</p>
              <ul className="flex flex-col gap-2.5">
                {[`${p.perDay} applications / day`, "Resume-aware matching", "Daily reports your way", key === "pro" ? "Dedicated email support" : "Community support"].map((f) => (
                  <li key={f} className="relative pl-4.5 text-[0.82rem] text-[rgba(242,236,225,0.82)] before:absolute before:left-0 before:top-[0.5em] before:size-1.5 before:rounded-full before:bg-brand">{f}</li>
                ))}
              </ul>
              <div className="mt-auto block cursor-default rounded-full border border-dashed border-[rgba(242,236,225,0.4)] px-4 py-3 text-center text-[0.78rem] font-medium uppercase tracking-[0.1em] text-[rgba(242,236,225,0.6)]">
                Coming soon
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ══════════ CTA BAND ══════════ */}
      <section className="relative z-[5] border-t border-[var(--line-2)] px-[clamp(18px,5vw,80px)] py-[clamp(60px,8vw,110px)]">
        <Reveal className="relative mx-auto max-w-[1000px] overflow-hidden rounded-lg bg-brand px-[clamp(20px,4vw,60px)] py-[clamp(44px,6vw,90px)] text-center text-[var(--paper)]">
          <span aria-hidden className="pointer-events-none absolute bottom-[-0.34em] left-1/2 -translate-x-1/2 whitespace-nowrap font-display text-[clamp(5rem,16vw,13rem)] tracking-[-0.02em] text-[rgba(23,20,15,0.10)]">GRINDLY</span>
          <h2 className="relative z-[1] text-[clamp(2.2rem,5.4vw,4.2rem)] tracking-[-0.02em] text-[var(--paper)]">Your next internship is<br />one signup away.</h2>
          <p className="relative z-[1] mx-auto mt-3.5 max-w-[46ch] text-[0.96rem] text-[rgba(242,236,225,0.85)]">Let the agent grind the applications. You focus on the interviews.</p>
          <Link href="/login" className="press relative z-[1] mt-7 inline-flex items-center gap-2 rounded-full bg-ink px-7 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.1em] text-[var(--paper)] transition hover:bg-[var(--paper)] hover:text-ink">
            Get started free →
          </Link>
        </Reveal>
      </section>

      {/* ══════════ FOOTER ══════════ */}
      <footer className="relative z-[5] flex flex-wrap items-center justify-between gap-5 border-t border-[var(--line-2)] px-[clamp(18px,5vw,80px)] py-[clamp(28px,4vw,44px)] text-[0.82rem] text-[var(--ink-soft)]">
        <Logo size={26} withWordmark />
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <Link href="/privacy" className="hover:text-brand transition">Privacy</Link>
          <Link href="/terms" className="hover:text-brand transition">Terms</Link>
          <span className="text-[var(--ink-mute)]">© {new Date().getFullYear()} Grindly · Built for the intern grind.</span>
        </div>
      </footer>
    </>
  );
}
