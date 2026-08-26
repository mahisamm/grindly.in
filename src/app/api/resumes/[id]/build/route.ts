import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, notFound, badRequest, serverError } from "@/lib/auth";
import { runAgent, VARIANT_DIR, type Report } from "@/lib/agent";
import { toJsonColumn } from "@/lib/jsonColumn";
import { readStruct } from "@/lib/resumeStruct";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One render, not a batch: a single Chromium pass plus the read-back.
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };

/** The label for a document the user wrote themselves. */
const OWN_EDIT_LABEL = "Yours";

/**
 * Render the saved fields to a PDF and measure it on the same ruler.
 *
 * This closes the loop the product was missing. It could tell you, precisely
 * and repeatably, that a bullet has no outcome in it and that a parser cannot
 * find your dates — and then it handed you a PDF and stopped. The only way to
 * act on any of it was to go back to Word, guess, re-export and re-upload.
 *
 * The result is stored as a variant like any other, so it appears beside the
 * machine-written rebuilds and can be compared against the original the same
 * way. It is labelled "Yours" and, unlike them, it is NOT discarded for scoring
 * below the baseline: the model's rewrites are ours to judge and throw away,
 * and this document is the user's. Telling someone their own edit was not good
 * enough to show them would be the wrong relationship entirely.
 *
 * No anti-fabrication gates run here either, and that is the same principle.
 * The gates exist because a MODEL must not introduce a fact the user did not
 * claim. A person typing about themselves is the only source this product has
 * ever accepted.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: { id: true, structJson: true, score: true, linkStyle: true, targetPages: true },
  });
  if (!resume) return notFound();

  const struct = readStruct(resume.structJson);
  if (!struct) {
    return badRequest("There is nothing saved to build. Open the editor and save first.");
  }

  const runDir = crypto.randomUUID();
  const outDir = path.join(VARIANT_DIR, resume.id, runDir);
  const outPath = path.join(outDir, "variant-1.pdf");
  await fsp.mkdir(outDir, { recursive: true }).catch(() => null);

  const rendered = await runAgent<{
    pages: number;
    chars: number;
    text: string;
    report: Report;
    over_budget?: boolean;
    compacted?: boolean;
  }>("render", {
    struct,
    out: outPath,
    link_style: resume.linkStyle,
    // The user's one-page choice applies to their own builds too — the
    // renderer walks its compact ladder; the words are theirs and are never
    // rewritten, so "still over" comes back honestly instead.
    max_pages: resume.targetPages === 1 ? 1 : null,
  });

  if (!rendered.ok) {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    return serverError(rendered.error, `build:${resume.id}`);
  }

  let bytes = 0;
  try {
    bytes = (await fsp.stat(outPath)).size;
  } catch {
    return serverError("The document was built but could not be read back.", `build:${resume.id}`);
  }

  const baseline = resume.score ?? 0;
  const score = rendered.report?.score ?? 0;

  // Keep one current "Yours" in the workspace, but archive each older build
  // into All resumes. A user may need the exact PDF they sent before editing
  // again, so a newer build must not erase it.
  // Archive and create in the same transaction: a failed save cannot leave
  // the editor without a current document.
  const previous = await prisma.variant.findMany({
    where: { resumeId: resume.id, label: OWN_EDIT_LABEL, archivedAt: null },
    select: { id: true, file: true },
  });

  let variant;
  try {
    [, variant] = await prisma.$transaction([
      prisma.variant.updateMany({
        where: { id: { in: previous.map((v) => v.id) } },
        data: { archivedAt: new Date() },
      }),
      prisma.variant.create({
      data: {
        resumeId: resume.id,
        targetId: null,
        label: OWN_EDIT_LABEL,
        score,
        grade: rendered.report?.grade ?? "",
        baselineScore: baseline,
        beatsBaseline: score >= baseline,
        pages: rendered.pages ?? null,
        changesJson: toJsonColumn(["Built from your own edits."]),
        reportJson: toJsonColumn(rendered.report),
        // No fidelity count. That number is the answer to "how much of what we
        // printed survived being read back", and it is measured against facts
        // the pipeline extracted from a source document. There is no source
        // here that differs from the output — the user typed it — so a fidelity
        // figure would be a comparison of a document with itself.
        fidelityJson: toJsonColumn(null),
        // The struct is the one the user just typed, and the text is what came
        // back off the PDF we printed from it. Both stored so this build can be
        // promoted on the same terms a rewrite can.
        //
        // The two texts are not the same text. The uploaded resume record stays
        // unchanged; this Variant stores the EXTRACTION that came back out of
        // the printed PDF. That is what `score` was computed from, and it is
        // therefore what a promoted copy has to carry if its number is to mean
        // the same thing.
        structJson: toJsonColumn(struct),
        text: typeof rendered.text === "string" ? rendered.text : "",
        file: `${runDir}/variant-1.pdf`,
        bytes,
      },
    }),
    ]);
  } catch (e) {
    return serverError("We built it but could not save it.", `build:${resume.id}: ${String(e)}`);
  }

  await prisma.scoreEvent
    .create({
      data: {
        resumeId: resume.id,
        score,
        grade: rendered.report?.grade ?? "",
        source: "edit",
        variantLabel: OWN_EDIT_LABEL,
      },
    })
    .catch((e) => console.error("[build] score history write failed:", e));

  // A manual build is a VERSION, not a mutation of the uploaded source.
  //
  // Replacing `resume.text` here made the library label an incomplete edited
  // PDF as the user's "primary uploaded resume". That was irreversible at the
  // application level: the original source text was gone even though the file
  // itself still existed. The saved Variant is already the authoritative copy
  // of this build, with its own PDF, extracted text and measured score. A user
  // who wants it to become a separate working resume can choose the explicit
  // "Use as my resume" action instead.

  await audit(user.id, "resume_built", resume.id, `score ${score}`);

  return NextResponse.json({
    ok: true,
    variantId: variant.id,
    score,
    grade: rendered.report?.grade ?? "",
    baseline,
    pages: rendered.pages ?? null,
    report: rendered.report ?? null,
    // The page budget, measured on the PDF just built. The editor shows it —
    // this content is the user's own words, so over budget means "trim in
    // the editor", never a silent rewrite.
    overBudget: Boolean(rendered.over_budget),
    // Kept for older clients: the current workspace document changed, while
    // the uploaded primary source deliberately did not.
    resumeUpdated: true,
  });
}
