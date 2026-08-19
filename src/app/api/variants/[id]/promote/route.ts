import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, badRequest, notFound, serverError } from "@/lib/auth";
import { limitsFor, formatLimit } from "@/lib/plans";
import { toJsonColumn } from "@/lib/jsonColumn";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** A promoted resume's name: "Backend Engineer at Zoho — Impact-focused". */
function promotedLabel(parentLabel: string, targetName: string, variantLabel: string): string {
  const left = (targetName || parentLabel || "Rebuild").trim();
  return `${left} — ${variantLabel}`.slice(0, 120);
}

/**
 * "Use as my resume" — promote one rebuild into a resume of its own.
 *
 * THIS CREATES. It does not overwrite, and the distinction is the whole design.
 *
 * The obvious implementation is to write the variant's text and struct back
 * onto the resume it was built from, which is what the word "promote" sounds
 * like it means, and what an older note in resume_optimize.py called "the button
 * that overwrites the master resume". Three things break when it does:
 *
 *   Every variant carries `baselineScore` — the score of the document it beat.
 *   Overwrite the source and that baseline describes text that no longer
 *   exists, so "+18 against your resume" becomes a claim nobody, including us,
 *   can check. This product's one real asset is that its numbers are checkable.
 *
 *   A resume owns targets, runs, score history and logged applications. Someone
 *   who promoted a rebuild and then preferred the original would have to choose
 *   between keeping their application history and keeping their document.
 *
 *   And a rebuild is not better in every respect. It scores higher against a
 *   parser; it may still have lost a line its owner wanted. They should be able
 *   to look at both, side by side, afterwards.
 *
 * So the rebuild becomes a new document and the account's `primaryResumeId`
 * pointer moves to it. The pointer moves back for free — one button, nothing
 * lost in either direction. It counts against the plan's resume cap exactly as
 * an upload does, because it is one.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  const variant = await prisma.variant.findFirst({
    // Ownership is checked through the resume, the only row here that carries a
    // userId. A variant id is handed to the client, so this is the difference
    // between promoting your own rebuild and promoting somebody else's.
    where: { id, resume: { userId: user.id } },
    select: {
      id: true,
      label: true,
      score: true,
      grade: true,
      text: true,
      structJson: true,
      reportJson: true,
      targetId: true,
      resume: {
        select: {
          id: true,
          label: true,
          contactJson: true,
          linksJson: true,
          skillsJson: true,
          linkStyle: true,
        },
      },
    },
  });
  if (!variant) return notFound();

  // Rebuilds made before these columns existed have no fields to promote. Said
  // plainly, and the card hides the button when it already knows — nobody should
  // discover a limitation by pressing a button that then refuses.
  if (!variant.structJson || !variant.text.trim()) {
    return badRequest(
      "This rebuild predates the change that keeps its editable fields. Run the rewrite again and the new one can be promoted.",
    );
  }

  const count = await prisma.resume.count({ where: { userId: user.id } });
  if (count >= limitsFor(user).resumes) {
    return NextResponse.json(
      {
        error: `Your plan holds ${formatLimit(limitsFor(user).resumes)} resumes, and this makes a new one. Delete one, or get a Season Pass.`,
        code: "plan_limit",
      },
      { status: 402 },
    );
  }

  const targetName = variant.targetId
    ? ((
        await prisma.target.findFirst({
          where: { id: variant.targetId },
          select: { name: true },
        })
      )?.name ?? "")
    : "";

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const resume = await tx.resume.create({
        data: {
          userId: user.id,
          label: promotedLabel(variant.resume.label, targetName, variant.label),
          // Built by us, not uploaded. `ext` is null for exactly that case;
          // claiming ".pdf" would make the report page offer to show an original
          // file that does not exist.
          ext: null,
          originalName: null,
          text: variant.text,
          chars: variant.text.length,
          // Score and report are COPIED rather than recomputed. Both were
          // measured on the finished PDF by the same scorer the report page
          // runs, so recomputing spends a subprocess to reproduce the same
          // answer — or, worse, a slightly different one, leaving the card and
          // the resume disagreeing about a document neither of them changed.
          score: variant.score,
          grade: variant.grade,
          reportJson: toJsonColumn(variant.reportJson),
          structJson: toJsonColumn(variant.structJson),
          // Identity and the skills allow-list belong to the PERSON, not to the
          // document. Carried across so the promoted resume can be rewritten
          // again without re-deriving a claim its owner already made.
          contactJson: toJsonColumn(variant.resume.contactJson),
          linksJson: toJsonColumn(variant.resume.linksJson),
          skillsJson: (variant.resume.skillsJson ?? []) as never,
          linkStyle: variant.resume.linkStyle,
          fromVariantId: variant.id,
          parentResumeId: variant.resume.id,
        },
        select: { id: true, label: true },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { primaryResumeId: resume.id },
      });
      return resume;
    });
  } catch (e) {
    return serverError("Could not promote that rebuild.", `promote:${id}: ${String(e)}`);
  }

  await audit(user.id, "variant_promoted", created.id, variant.label);
  return NextResponse.json({ ok: true, id: created.id, label: created.label });
}
