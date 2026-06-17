import Link from "next/link";
import { Nav, Logo } from "@/components/Brand";
import { PLANS } from "@/lib/adapters/payment";

const STEPS = [
  {
    n: "01",
    title: "Sign up & drop your resume",
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
  ["Resume-aware matching", "Skills extracted from your resume score every role 0–100. Only real fits get an application."],
  ["You set the firewall", "Min match score, max/day, excluded companies, stipend floor — hard constraints the agent can't cross."],
  ["Real applications", "Drives Internshala like a human: opens the listing, fills the form, submits. Not just a list of links."],
  ["Runs on your terms", "Auto-submit, or shortlist-and-ask. Pause anytime from the dashboard."],
  ["Slack-native updates", "Onboarding questions and daily reports come to you in Slack — no new app to babysit."],
  ["Private brain", "Resume analysis runs on a local LLM. Your resume isn't shipped to a third-party model."],
];

export default function Home() {
  return (
    <>
      <Nav />

      {/* hero */}
      <section className="grid-bg">
        <div className="mx-auto max-w-6xl px-5 pt-20 pb-24 text-center">
          <div className="animate-in inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-3 py-1 text-xs text-muted">
            <span className="size-1.5 rounded-full bg-accent pulse-dot" />
            Your AI applies while you sleep
          </div>
          <h1 className="animate-in mt-6 text-4xl sm:text-6xl font-semibold tracking-tight leading-[1.05]">
            Stop filling internship forms.
            <br />
            <span className="brand-text">Let an agent do it.</span>
          </h1>
          <p className="animate-in mx-auto mt-6 max-w-2xl text-lg text-muted">
            InternPilot reads your resume, finds internships that actually match your
            skills, and applies for you — every day, inside the limits you set. You just
            read the Slack report.
          </p>
          <div className="animate-in mt-9 flex items-center justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-xl brand-gradient px-6 py-3 font-medium text-white glow hover:opacity-90 transition"
            >
              Start applying free
            </Link>
            <a
              href="#how"
              className="rounded-xl border border-border bg-surface px-6 py-3 font-medium hover:border-brand/60 transition"
            >
              See how it works
            </a>
          </div>

          {/* mock dashboard preview */}
          <div className="animate-in mx-auto mt-16 max-w-4xl">
            <div className="glass rounded-2xl p-2 glow">
              <div className="rounded-xl bg-surface-2 p-5 text-left">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <span className="size-2 rounded-full bg-accent pulse-dot" />
                    Agent active · Pro plan
                  </div>
                  <div className="text-xs text-muted">Today</div>
                </div>
                <div className="grid grid-cols-3 gap-3 py-4">
                  {[
                    ["Applied today", "12", "text-accent"],
                    ["Avg match", "78", "text-brand-2"],
                    ["Skipped (low fit)", "9", "text-muted"],
                  ].map(([label, val, c]) => (
                    <div key={label} className="rounded-lg border border-border bg-surface p-3">
                      <div className={`text-2xl font-semibold ${c}`}>{val}</div>
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
                      className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                    >
                      <div>
                        <div className="font-medium">{title}</div>
                        <div className="text-xs text-muted">{co}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-brand-2">{score as number}</span>
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs ${
                            st === "applied"
                              ? "bg-accent/15 text-accent"
                              : "bg-surface-2 text-muted"
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

      {/* features */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="text-center text-3xl font-semibold tracking-tight">
          Everything an intern-hunter wishes they had
        </h2>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([t, b]) => (
            <div
              key={t}
              className="rounded-xl border border-border bg-surface p-5 hover:border-brand/50 transition"
            >
              <div className="size-9 rounded-lg brand-gradient mb-4" />
              <h3 className="font-medium">{t}</h3>
              <p className="mt-1 text-sm text-muted">{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* how it works */}
      <section id="how" className="border-y border-border bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="text-center text-3xl font-semibold tracking-tight">How it works</h2>
          <p className="mt-3 text-center text-muted">From signup to your first applications in minutes.</p>
          <div className="mt-12 grid gap-4 md:grid-cols-5">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-xl border border-border bg-surface p-5">
                <div className="font-mono text-sm brand-text">{s.n}</div>
                <h3 className="mt-3 font-medium leading-snug">{s.title}</h3>
                <p className="mt-2 text-sm text-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* pricing */}
      <section id="pricing" className="mx-auto max-w-5xl px-5 py-20">
        <h2 className="text-center text-3xl font-semibold tracking-tight">Simple pricing</h2>
        <p className="mt-3 text-center text-muted">Cancel anytime. Test-mode billing while local.</p>
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {(Object.entries(PLANS) as [keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]][]).map(
            ([key, p]) => (
              <div
                key={key}
                className={`rounded-2xl border p-6 ${
                  key === "pro" ? "border-brand glow bg-surface" : "border-border bg-surface"
                }`}
              >
                {key === "pro" && (
                  <div className="mb-3 inline-block rounded-full bg-brand/15 px-2.5 py-0.5 text-xs text-brand-2">
                    Most popular
                  </div>
                )}
                <div className="text-lg font-medium">{p.name}</div>
                <div className="mt-2 text-3xl font-semibold">
                  ₹{p.price}
                  <span className="text-base font-normal text-muted">/mo</span>
                </div>
                <p className="mt-2 text-sm text-muted">{p.blurb}</p>
                <ul className="mt-5 space-y-2 text-sm">
                  {[
                    `${p.perDay} applications / day`,
                    "Resume-aware matching",
                    "Daily Slack reports",
                    key === "pro" ? "Priority match queue" : "Email support",
                  ].map((f) => (
                    <li key={f} className="flex items-center gap-2 text-muted">
                      <span className="text-accent">✓</span> {f}
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={`mt-6 block rounded-xl px-4 py-2.5 text-center font-medium transition ${
                    key === "pro"
                      ? "brand-gradient text-white hover:opacity-90"
                      : "border border-border hover:border-brand/60"
                  }`}
                >
                  Choose {p.name}
                </Link>
              </div>
            )
          )}
        </div>
      </section>

      {/* cta */}
      <section className="mx-auto max-w-4xl px-5 pb-24">
        <div className="grid-bg rounded-3xl border border-border p-12 text-center glow">
          <h2 className="text-3xl font-semibold tracking-tight">
            Your next internship is one signup away.
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-muted">
            Let the agent grind the applications. You focus on the interviews.
          </p>
          <Link
            href="/signup"
            className="mt-7 inline-block rounded-xl brand-gradient px-7 py-3 font-medium text-white hover:opacity-90 transition"
          >
            Get started
          </Link>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-5 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted">
          <Logo size={22} />
          <div>© {new Date().getFullYear()} InternPilot · Built for the intern grind.</div>
        </div>
      </footer>
    </>
  );
}
