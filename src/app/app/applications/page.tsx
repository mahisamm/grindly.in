import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { ApplicationsClient } from "./ApplicationsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Applications — Grindly" };

/**
 * Every application this account has logged, across every resume, in one place.
 *
 * It used to live inside a single resume's workspace (the "Progress" tab), so
 * an account with three resumes had its send history split three ways and no
 * screen that answered "how is the search going" as a whole. Grindly still
 * submits nothing on anyone's behalf — every row here is typed by the person
 * who sent it — and the one column that earns a database over a spreadsheet is
 * which version of which resume went out.
 */
export default async function ApplicationsPage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected

  const [applications, resumes] = await Promise.all([
    prisma.application.findMany({
      where: { userId: user.id },
      orderBy: { appliedAt: "desc" },
      take: 500,
    }),
    prisma.resume.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        variants: {
          where: { archivedAt: null },
          orderBy: { createdAt: "desc" },
          select: { label: true },
        },
      },
    }),
  ]);

  const labelById = new Map(resumes.map((r) => [r.id, r.label]));

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-6 sm:py-10">
      <h1 className="font-display text-2xl font-bold sm:text-3xl">Applications</h1>
      <p className="text-muted mt-1.5 max-w-2xl text-sm leading-relaxed">
        Every application you have logged, across every resume. Typed by you — Grindly
        does not submit anything on your behalf, because bulk applying through job boards
        breaks their terms and gets accounts banned. What a spreadsheet cannot tell you
        is which version of which resume went to whom.
      </p>

      <ApplicationsClient
        resumes={resumes.map((r) => ({
          id: r.id,
          label: r.label,
          variantLabels: [...new Set(r.variants.map((v) => v.label))],
        }))}
        applications={applications.map((a) => ({
          id: a.id,
          company: a.company,
          role: a.role,
          status: a.status,
          variantLabel: a.variantLabel,
          notes: a.notes,
          appliedAt: a.appliedAt.toISOString(),
          resumeId: a.resumeId,
          resumeLabel: labelById.get(a.resumeId) ?? "Deleted resume",
        }))}
      />
    </div>
  );
}
