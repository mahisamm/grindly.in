import Link from "next/link";
import { Logo } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ParticleField } from "@/components/ParticleField";
import { Reveal } from "@/components/Motion";
import { runAgent, type CompanyPack } from "@/lib/agent";
import { PRODUCTS, formatAmount } from "@/lib/plans";

export const revalidate = 300;

/**
 * The landing page.
 *
 * It leads with the claim nobody else in this category can make and everybody
 * else in this category contradicts: there is no such thing as an ATS score.
 * That is a strange thing to open with — it is a product page opening by
 * disowning its own market's headline metric — and it is the point. Every
 * competitor sells a number no applicant tracking system computes. Saying so,
 * and then showing what we measure instead, is both the honest position and the
 * only differentiator that cannot be copied in an afternoon.
 */
export default async function Home() {
  const packs = await runAgent<{ packs: CompanyPack[]; disclaimer: string }>("companies");
  const companies = packs.ok ? packs.packs : [];

  return (
    <>
      {/* Behind everything, and everything below is lifted to `relative z-10`
          so it stays behind. It is the only client component on this page. */}
      <ParticleField />

      <header className="border-border relative z-10 border-b">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-4 sm:px-6 sm:py-5">
          <Logo />
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Pricing is hidden on the narrowest screens rather than allowed to
                push "Start free" off the row — the pricing teaser and the
                footer both link to it further down the same page. */}
            <Link href="/pricing" className="text-muted hover:text-ink hidden text-sm sm:inline">
              Pricing
            </Link>
            <Link href="/login" className="text-muted hover:text-ink text-sm whitespace-nowrap">
              Sign in
            </Link>
            <Link href="/signup" className="btn btn-primary text-sm whitespace-nowrap">
              Start free
            </Link>
          </div>
        </nav>
      </header>

      <main className="relative z-10 flex-1">
        {/* hero */}
        <section className="mx-auto max-w-6xl px-5 pt-12 pb-12 sm:px-6 sm:pt-24 sm:pb-14">
          <p className="text-brand mb-5 font-mono text-xs tracking-[0.16em] uppercase">
            Resume readiness, measured
          </p>
          <h1 className="font-display max-w-4xl text-4xl leading-[1.05] font-bold text-balance sm:text-6xl">
            There is no such thing as an ATS score.
          </h1>
          <div className="mt-7 grid gap-10 md:grid-cols-[1.3fr_1fr]">
            <div>
              <p className="text-lg leading-relaxed">
                Workday, Greenhouse and Taleo do not grade your resume and reject it. They
                parse it into database fields and let a recruiter search. So every tool
                selling you an &ldquo;82/100 ATS score&rdquo; is selling a number no system
                anywhere computes.
              </p>
              <p className="mt-4 text-lg leading-relaxed">
                Grindly measures something you can check: <b>what a machine actually
                recovers from your file</b>. We rebuild your resume as a clean
                single-column PDF, read it back with the same extractor a parser uses, and
                count what survived.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link href="/signup" className="btn btn-primary">
                  Check my resume — free
                </Link>
                <Link href="/pricing" className="btn">
                  See pricing
                </Link>
              </div>
              <p className="text-muted mt-4 text-sm">
                No card. Your first resume, the full report and one company pack are free.
              </p>
              <p className="text-muted mt-2 text-sm">
                First job or eleventh year — the same file goes through the same parser
                either way, and a two-page senior resume is scored as one.
              </p>
            </div>

            <aside className="bg-surface border-border rounded-xl border p-6">
              <p className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
                What we score
              </p>
              <dl className="mt-4 flex flex-col gap-4 text-sm">
                {[
                  ["Machine-readable", "30", "Does any text survive extraction? An image-only export looks perfect to you and is empty to a parser."],
                  ["Contact & dates", "20", "Can a parser fill in your name, email, phone and dates? A truncated address is one nobody can reply to."],
                  ["Structure", "15", "Standard headings, real bullets, one column."],
                  ["Evidence of impact", "20", "Bullets that lead with an action and state an outcome."],
                  ["Role coverage", "15", "Skills the job asks for that your page actually shows."],
                ].map(([name, weight, blurb]) => (
                  <div key={name}>
                    <dt className="flex items-baseline justify-between gap-3 font-medium">
                      <span>{name}</span>
                      <span className="text-muted font-mono text-xs tabular-nums">{weight} pts</span>
                    </dt>
                    <dd className="text-muted mt-0.5 text-xs leading-snug">{blurb}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted mt-5 border-t pt-4 text-xs leading-snug" style={{ borderColor: "var(--border)" }}>
                The rubric is published because it is ours. Same file, same score, every
                time — it is arithmetic, not an opinion.
              </p>
            </aside>
          </div>
        </section>

        {/* the promise we refuse to break */}
        <section className="border-border border-y" style={{ background: "var(--surface-2)" }}>
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-6 sm:py-14 md:grid-cols-3">
            {[
              {
                h: "It is built not to invent",
                p: "Three gates run before a rewrite is rendered: no technology absent from your resume, no employer, date or metric whose words are not in your source, and every entry must descend from a real one. A rewrite may reword and reorder. Read what it produces before you send it — the document goes out under your name.",
              },
              {
                h: "Three versions, measured",
                p: "You get up to three rebuilds under different strategies, each scored against your original. Any version that does not beat your resume is thrown away rather than shown to you behind a tempting button. We aim for 80 and above — everything mechanical is ours to get right — and a rebuild that still lands short tells you the one thing missing instead of hiding it.",
              },
              {
                h: "Tailored to a real company",
                p: "Amazon publishes 16 Leadership Principles. Google publishes the bullet form it wants. We surface what you already have to match — every claim linked to the company's own page, never scraped, never guessed. Type any other employer and you get one of three answers, including the honest one: for most companies there is nothing specific to tailor to, and we say so instead of inventing it.",
              },
            ].map((c, i) => (
              // Staggered by index rather than all at once. Three columns
              // arriving together is a page that jumped; ninety milliseconds
              // apart is a page that settled, and it is short enough that
              // nobody waiting for the third card notices they waited.
              <Reveal key={c.h} delay={i * 90}>
                <h2 className="font-display text-xl font-semibold">{c.h}</h2>
                <p className="text-muted mt-2 leading-relaxed">{c.p}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* companies */}
        {companies.length > 0 && (
          <section className="mx-auto max-w-6xl px-5 py-12 sm:px-6 sm:py-16">
            <h2 className="font-display text-3xl font-bold text-balance">
              Company packs, with the sources attached
            </h2>
            <p className="text-muted mt-3 max-w-2xl leading-relaxed">
              Each pack is what an employer has published about how it hires — with the
              link, so you can check it yourself. Not insider knowledge, not a prediction,
              and never scraped from a job board.
            </p>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {companies.map((c, i) => (
                <Reveal
                  as="li"
                  key={c.slug}
                  // Capped at six steps. A stagger proportional to the list
                  // makes the last card in a twelve-company grid arrive a
                  // second after the first, which reads as a slow page.
                  delay={Math.min(i, 6) * 55}
                  className="bg-surface border-border rounded-xl border p-5"
                >
                  <h3 className="font-display text-lg font-semibold">{c.name}</h3>
                  <p className="text-muted mt-1.5 text-sm leading-snug">{c.summary}</p>
                  <p className="text-muted mt-3 font-mono text-[10px] tracking-[0.1em] uppercase">
                    {c.sources.length} cited source{c.sources.length === 1 ? "" : "s"}
                  </p>
                </Reveal>
              ))}
            </ul>
            <p className="text-muted mt-6 max-w-3xl text-xs leading-relaxed">
              {packs.ok ? packs.disclaimer : ""}
            </p>
          </section>
        )}

        {/* pricing teaser */}
        <section className="border-border border-t">
          <div className="mx-auto max-w-6xl px-5 py-12 sm:px-6 sm:py-16">
            <h2 className="font-display text-3xl font-bold">Priced for a job search</h2>
            <p className="text-muted mt-3 max-w-2xl leading-relaxed">
              Not a subscription. A search runs weeks, not years, so you buy a pass that
              ends on its own — and you keep everything you made. The comparable tools
              charge {formatAmount(250000)}–{formatAmount(410000)} a month.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Reveal className="bg-surface border-border min-w-[220px] flex-1 rounded-xl border p-6">
                <p className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">Free</p>
                <p className="font-display mt-2 text-3xl font-bold">₹0</p>
                <p className="text-muted mt-2 text-sm">
                  Full report, one resume, one company pack. No watermark.
                </p>
              </Reveal>
              {(["pass90", "pack1"] as const).map((sku, i) => (
                <Reveal
                  key={sku}
                  delay={(i + 1) * 90}
                  className="bg-surface border-border min-w-[220px] flex-1 rounded-xl border p-6"
                >
                  <p className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">
                    {PRODUCTS[sku].name}
                  </p>
                  <p className="font-display mt-2 text-3xl font-bold">
                    {formatAmount(PRODUCTS[sku].amount)}
                  </p>
                  <p className="text-muted mt-2 text-sm">{PRODUCTS[sku].blurb}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-border relative z-10 border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm sm:px-6">
          <Logo size={24} />
          <nav className="text-muted flex flex-wrap items-center gap-5">
            <Link href="/pricing" className="hover:text-ink">Pricing</Link>
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
            <Link href="/terms" className="hover:text-ink">Terms</Link>
            {/* Reachable without an account: someone reading the landing page at
                midnight is exactly who needs it, and they have not signed up
                yet. */}
            <ThemeToggle />
          </nav>
        </div>
      </footer>
    </>
  );
}
