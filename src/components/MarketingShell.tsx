import Link from "next/link";
import { Logo } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { MarketingResource } from "@/lib/marketing";

export function MarketingShell({ resource }: { resource: MarketingResource }) {
  return (
    <>
      <header className="border-border border-b">
        <nav aria-label="Main" className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/" aria-label="Grindly home"><Logo /></Link>
          <div className="flex items-center gap-3">
            <Link href="/pricing" className="text-muted hover:text-ink hidden text-sm sm:inline">Pricing</Link>
            <Link href="/signup" className="btn btn-primary text-sm">Check my resume free</Link>
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12 sm:px-6 sm:py-16">
        <p className="text-brand font-mono text-xs tracking-[0.16em] uppercase">{resource.eyebrow}</p>
        <h1 className="font-display mt-5 text-4xl font-bold leading-[1.06] text-balance sm:text-5xl">{resource.title}</h1>
        <p className="text-muted mt-6 max-w-2xl text-xl leading-relaxed">{resource.intro}</p>
        <div className="bg-surface border-border mt-8 rounded-xl border p-5 sm:p-6">
          <p className="font-display text-lg font-semibold">Put this into practice</p>
          <p className="text-muted mt-1.5 leading-relaxed">Upload a resume or start one from scratch. You can edit and score it free, then decide whether you want a rebuilt version.</p>
          <Link href="/signup" className="btn btn-primary mt-4">Start with my resume</Link>
        </div>

        <div className="mt-12 space-y-12">
          {resource.sections.map((section) => (
            <section key={section.title}>
              <h2 className="font-display text-2xl font-semibold">{section.title}</h2>
              <div className="text-muted mt-3 space-y-3 leading-relaxed">
                {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.points && (
                  <ul className="space-y-2 pl-5 [&_li]:pl-1" style={{ listStyle: "disc" }}>
                    {section.points.map((point) => <li key={point}>{point}</li>)}
                  </ul>
                )}
              </div>
            </section>
          ))}
        </div>

        <section className="border-border mt-14 border-t pt-10">
          <h2 className="font-display text-2xl font-semibold">Questions people ask</h2>
          <dl className="mt-6 space-y-7">
            {resource.questions.map((item) => (
              <div key={item.question}>
                <dt className="font-semibold">{item.question}</dt>
                <dd className="text-muted mt-1.5 leading-relaxed">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-border bg-surface mt-14 rounded-xl border p-6 sm:p-8">
          <h2 className="font-display text-2xl font-semibold">Ready to see what your file says?</h2>
          <p className="text-muted mt-2 max-w-xl leading-relaxed">Get a clear readiness report, edit freely, and only rebuild when it improves the document you can honestly send.</p>
          <div className="mt-5 flex flex-wrap gap-3"><Link href="/signup" className="btn btn-primary">Check my resume free</Link><Link href="/pricing" className="btn">See how access works</Link></div>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted mx-auto flex max-w-5xl flex-wrap items-center gap-5 px-5 py-8 text-sm sm:px-6">
          <Link href="/" className="hover:text-ink">Home</Link>
          <Link href="/pricing" className="hover:text-ink">Pricing</Link>
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/contact" className="hover:text-ink">Contact</Link>
          <ThemeToggle />
        </div>
      </footer>
    </>
  );
}
