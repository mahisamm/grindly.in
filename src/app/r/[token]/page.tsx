import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { readReport, toPublicReport } from "@/lib/reportTypes";
import { Logo } from "@/components/Brand";
import { ReportPanel } from "@/components/Score";

export const dynamic = "force-dynamic";

/**
 * A readiness report, readable by whoever has the link.
 *
 * What is here is the measurement and nothing else: the score, the five bands
 * and the findings. Not the resume text, not the contact details, not the
 * rebuilt PDFs, not even the label the owner gave the file — that is often
 * their own name. A person opening this link learns what a parser recovers from
 * a document; they do not learn whose it is.
 *
 * `noindex` because a share link is for one person, and a report indexed by a
 * search engine is a report the owner did not agree to publish.
 */
export const metadata: Metadata = {
  title: "A resume readiness report — Grindly",
  robots: { index: false, follow: false },
};

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Length-checked before the query. The column is unique and indexed, so this
  // is not about performance — it is about not turning a 5 000-character URL
  // into a database round trip.
  if (!token || token.length < 16 || token.length > 128) notFound();

  const resume = await prisma.resume.findUnique({
    where: { shareToken: token },
    // Deliberately narrow. Anything selected here is something the holder of
    // this link can read, and the safest way to keep that list short is to
    // write it out rather than to spread a row and delete from it.
    select: { score: true, grade: true, reportJson: true, createdAt: true, truncated: true },
  });
  if (!resume) notFound();

  const stored = readReport(resume.reportJson);
  if (!stored) notFound();

  // Never hand the raw report to a stranger — see toPublicReport. The select
  // above is narrow on purpose, but the report itself carries the contact
  // details a parser recovered, so narrowing the columns was not enough.
  const report = toPublicReport(stored);

  return (
    <>
      <header className="border-border border-b">
        <nav className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-4 sm:px-6">
          <Link href="/">
            <Logo />
          </Link>
          <Link href="/signup" className="btn btn-primary text-sm whitespace-nowrap">
            Check your own — free
          </Link>
        </nav>
      </header>

      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:px-6">
        <p className="text-brand font-mono text-xs tracking-[0.16em] uppercase">
          Shared readiness report
        </p>
        <h1 className="font-display mt-3 text-3xl font-bold text-balance sm:text-4xl">
          What a machine recovers from this resume
        </h1>
        <p className="text-muted mt-3 max-w-2xl leading-relaxed">
          This is a measurement, not an opinion, and not an &ldquo;ATS score&rdquo; — no
          applicant tracking system computes one. It is a published rubric over five
          bands, run on the text a parser extracts from the file. The same bytes give
          the same number on every machine.
        </p>
        <p className="text-muted mt-2 text-sm">
          Measured {new Date(resume.createdAt).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          . The resume itself is not shared — only what was measured from it.
        </p>

        {resume.truncated && (
          <p className="text-muted mt-4 text-sm">
            The document was longer than the 60,000 characters we read, so this
            describes the first part of it.
          </p>
        )}

        <div className="mt-8">
          <ReportPanel report={report} />
        </div>

        <section className="border-border mt-10 border-t pt-8">
          <h2 className="font-display text-xl font-semibold">Where this number comes from</h2>
          <p className="text-muted mt-2 max-w-2xl leading-relaxed">
            Grindly measures what a parser can actually recover from a file, rebuilds the
            resume as a clean single-column PDF, and scores the rebuild on the same
            ruler. It refuses to invent a fact that is not already on the page.
          </p>
          <Link href="/" className="btn mt-5 inline-flex">
            See how it works
          </Link>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm sm:px-6">
          <Logo size={24} />
          <nav className="text-muted flex flex-wrap gap-5">
            <Link href="/privacy" className="hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-ink">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
