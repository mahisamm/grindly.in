import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { MARKETING_RESOURCES } from "@/lib/marketing";

export const metadata: Metadata = {
  title: "Resume guides — Grindly",
  description: "Practical, honest guides for building, checking and tailoring a resume that software and people can read.",
  alternates: { canonical: "/resources" },
};

export default function ResourcesPage() {
  return (
    <>
      <header className="border-border border-b">
        <nav aria-label="Main" className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4 sm:px-6 sm:py-5">
          <Link href="/" aria-label="Grindly home"><Logo /></Link>
          <Link href="/signup" className="btn btn-primary text-sm">Check my resume free</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl flex-1 px-5 py-12 sm:px-6 sm:py-16">
        <p className="text-brand font-mono text-xs tracking-[0.16em] uppercase">Practical resume guides</p>
        <h1 className="font-display mt-5 max-w-3xl text-4xl font-bold leading-[1.06] text-balance sm:text-5xl">Good advice before the tool asks you to sign up.</h1>
        <p className="text-muted mt-5 max-w-2xl text-lg leading-relaxed">Clear guidance for making a resume readable, specific and honest. Each guide points to a concrete next step—not a fake promise about a secret ATS score.</p>
        <ul className="mt-10 grid gap-5 sm:grid-cols-2">
          {MARKETING_RESOURCES.map((resource) => (
            <li key={resource.slug} className="bg-surface border-border flex flex-col rounded-xl border p-6">
              <p className="text-brand font-mono text-[10px] tracking-[0.14em] uppercase">{resource.eyebrow}</p>
              <h2 className="font-display mt-3 text-xl font-semibold">{resource.title}</h2>
              <p className="text-muted mt-2 flex-1 text-sm leading-relaxed">{resource.description}</p>
              <Link href={`/resources/${resource.slug}`} className="btn mt-5 self-start">Read guide</Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
