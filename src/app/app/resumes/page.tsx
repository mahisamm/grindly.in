import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { formatLimit, isUnlimited, limitsFor } from "@/lib/plans";
import { pickPrimary } from "@/lib/primary";
import { Uploader } from "../Uploader";
import { MakePrimary } from "../MakePrimary";
import { StartResume } from "./StartResume";

export const dynamic = "force-dynamic";
export const metadata = { title: "All resumes — Grindly" };

function date(value: Date) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  }).format(value);
}

function sourceKind(resume: { ext: string | null; fromVariantId: string | null; id: string }, primaryId: string | undefined) {
  if (resume.id === primaryId && resume.ext) return "Primary uploaded resume";
  if (resume.id === primaryId) return resume.fromVariantId ? "Primary resume · saved rebuild" : "Primary resume";
  if (resume.ext) return "Uploaded resume";
  if (resume.fromVariantId) return "Saved rebuild · your primary resume";
  return "Resume you created";
}

function generatedKind(variant: { label: string; target: { name: string; kind: string } | null }) {
  if (variant.target?.kind === "company") return `Company-specific resume · ${variant.target.name}`;
  if (variant.target) return `Role-specific ATS rebuild · ${variant.target.name}`;
  if (variant.label === "Yours") return "Built from your edits";
  return "ATS-scored rebuild";
}

/**
 * A source resume is the editable document a person owns. A generated PDF is
 * a measured output made from it. Showing them in separate sections makes it
 * impossible to mistake an AI rebuild for the original upload.
 */
export default async function AllResumesPage() {
  const user = await currentUser();
  if (!user) return null;

  const resumes = await prisma.resume.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, label: true, chars: true, score: true, createdAt: true,
      parentResumeId: true, fromVariantId: true, ext: true, originalName: true,
      variants: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true, label: true, score: true, createdAt: true, archivedAt: true,
          target: { select: { name: true, kind: true } },
        },
      },
    },
  });

  const limit = limitsFor(user).resumes;
  const primary = pickPrimary(resumes, user.primaryResumeId);
  const generated = resumes.flatMap((resume) =>
    resume.variants.map((variant) => ({ ...variant, resumeId: resume.id, resumeLabel: resume.label })),
  ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-6 sm:py-10">
      <Link href="/app" className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm">
        ← Back to dashboard
      </Link>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold sm:text-3xl">
            {resumes.length === 0 ? "Start with what you have" : "All resumes"}
          </h1>
          <p className="text-muted mt-1.5 max-w-3xl text-sm leading-relaxed">
            {resumes.length === 0
              ? "Upload an existing file, or build your first resume here. Both paths lead to the editor, readiness score and ATS-safe PDF."
              : "Your source resumes are separate from the ATS-scored PDFs made from them. Open or download exactly the version you need."}
          </p>
          {resumes.length > 0 && (
            <p className="text-muted mt-1 font-mono text-[11px] tracking-[0.08em] uppercase">
              {isUnlimited(limit) ? `${resumes.length} source resumes stored · no plan limit.` : `${resumes.length} of ${formatLimit(limit)} source resumes used.`}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 grid items-stretch gap-5 sm:mt-8 lg:grid-cols-2">
        <div className="h-full"><Uploader canUpload={resumes.length < limit} limit={limit} /></div>
        <StartResume disabled={resumes.length >= limit} />
      </div>

      {resumes.length > 0 && <>
        <section className="mt-10" aria-labelledby="source-resumes-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 id="source-resumes-heading" className="font-display text-xl font-semibold">Your source resumes</h2>
              <p className="text-muted mt-1 text-sm">The resumes you uploaded, wrote, or chose as your working resume.</p>
            </div>
            <span className="text-muted font-mono text-[11px] tracking-[0.08em] uppercase">Source files</span>
          </div>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {resumes.map((resume) => {
              const uploaded = Boolean(resume.ext);
              const pdf = resume.ext === ".pdf";
              return <li key={resume.id} className="bg-surface border-border flex min-h-56 flex-col rounded-xl border p-5" style={primary?.id === resume.id ? { borderColor: "var(--cta)" } : undefined}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[11px] tracking-[0.08em] uppercase" style={{ color: primary?.id === resume.id ? "var(--cta)" : undefined }}>{sourceKind(resume, primary?.id)}</p>
                    <h3 className="font-display mt-2 text-lg leading-tight font-semibold">{resume.label}</h3>
                  </div>
                  {resume.score !== null && <Score score={resume.score} />}
                </div>
                <p className="text-muted mt-3 text-sm leading-relaxed">
                  {uploaded ? `${resume.originalName || "Uploaded file"} · ${resume.chars.toLocaleString()} characters read` : "Editable in Grindly. Build a PDF after your edits to add it to the ATS-scored PDFs below."}
                </p>
                <p className="text-muted mt-3 text-xs">Added {date(resume.createdAt)}{resume.parentResumeId ? " · based on another resume" : ""}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-5">
                  <Link href={`/app/${resume.id}`} className="btn btn-primary flex-1 justify-center text-sm">Open / edit</Link>
                  {uploaded && pdf && <a href={`/api/resumes/${resume.id}/file`} target="_blank" rel="noopener noreferrer" className="btn justify-center text-sm">View</a>}
                  {uploaded ? <a href={`/api/resumes/${resume.id}/file?download=1`} download className="btn justify-center text-sm">Download</a> : <a href={`/api/resumes/${resume.id}/export?format=docx`} className="btn justify-center text-sm">.docx</a>}
                </div>
                {primary?.id === resume.id ? <p className="mt-3 font-mono text-[11px] tracking-[0.08em] uppercase" style={{ color: "var(--cta)" }}>Your primary resume</p> : <div className="mt-3"><MakePrimary id={resume.id} /></div>}
              </li>;
            })}
          </ul>
        </section>

        <section className="mt-12" aria-labelledby="generated-resumes-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 id="generated-resumes-heading" className="font-display text-xl font-semibold">ATS-scored PDFs</h2>
              <p className="text-muted mt-1 text-sm">Every PDF built from your edits or an AI rebuild. Previous versions stay here so you can download the exact one you chose.</p>
            </div>
            <span className="text-muted font-mono text-[11px] tracking-[0.08em] uppercase">{generated.length} PDFs</span>
          </div>
          {generated.length === 0 ? <div className="bg-surface border-border text-muted mt-4 rounded-xl border p-5 text-sm">No generated PDFs yet. Open a source resume to build one from your edits or create an ATS rebuild.</div> :
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {generated.map((variant) => <li key={variant.id} className="bg-surface border-border flex min-h-56 flex-col rounded-xl border p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[11px] tracking-[0.08em] uppercase" style={{ color: variant.target?.kind === "company" ? "var(--cta)" : undefined }}>{generatedKind(variant)}</p>
                    <h3 className="font-display mt-2 text-lg leading-tight font-semibold">{variant.label}</h3>
                  </div>
                  <Score score={variant.score} />
                </div>
                <p className="text-muted mt-3 text-sm leading-relaxed">From: {variant.resumeLabel}</p>
                <p className="text-muted mt-3 text-xs">Built {date(variant.createdAt)}{variant.archivedAt ? " · previous version" : " · current version"}</p>
                <div className="mt-auto flex flex-wrap gap-2 pt-5">
                  <a href={`/api/variants/${variant.id}/file`} target="_blank" rel="noopener noreferrer" className="btn btn-primary flex-1 justify-center text-sm">View PDF</a>
                  <a href={`/api/variants/${variant.id}/file?download=1`} download className="btn justify-center text-sm">Download</a>
                </div>
                {variant.target?.kind === "company" && <p className="text-muted mt-3 text-xs leading-relaxed">Download name: {variant.target.name} + your name</p>}
              </li>)}
            </ul>}
        </section>
      </>}
    </div>
  );
}

function Score({ score }: { score: number }) {
  return <span className="shrink-0 rounded px-2 py-1 font-mono text-xs tabular-nums" style={{ background: score >= 70 ? "var(--brand)" : score >= 40 ? "#a8730f" : "#a3271b", color: "var(--paper)" }}>ATS {score}</span>;
}
