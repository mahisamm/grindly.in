import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireUser, notFound, badRequest, serverError } from "@/lib/auth";
import { runAgent, VARIANT_DIR, type Report } from "@/lib/agent";
import { toJsonColumn } from "@/lib/jsonColumn";
import { readStruct, structToText } from "@/lib/resumeStruct";
import { reserve, refund } from "@/lib/quota";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One render, not a batch: a single Chromium pass plus the read-back.
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };

/** The label for a document the user wrote themselves. */
export const OWN_EDIT_LABEL = "Yours";

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
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: { id: true, structJson: true, score: true },
  });
  if (!resume) return notFound();

  const struct = readStruct(resume.structJson);
  if (!struct) {
    return badRequest("There is nothing saved to build. Open the editor and save first.");
  }

  // Metered against the rewrite allowance: this is a Chromium render, which is
  // the expensive half of what a rewrite batch does.
  const quota = await reserve(user.id, "variantRuns");
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message, code: "quota" }, { status: 429 });
  }

  const runDir = crypto.randomUUID();
  const outDir = path.join(VARIANT_DIR, resume.id, runDir);
  const outPath = path.join(outDir, "variant-1.pdf");
  await fsp.mkdir(outDir, { recursive: true }).catch(() => null);

  const rendered = await runAgent<{ pages: number; chars: number; report: Report }>("render", {
    struct,
    out: outPath,
  });

  if (!rendered.ok) {
    await refund(user.id, "variantRuns");
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    return serverError(rendered.error, `build:${resume.id}`);
  }

  let bytes = 0;
  try {
    bytes = (await fsp.stat(outPath)).size;
  } catch {
    await refund(user.id, "variantRuns");
    return serverError("The document was built but could not be read back.", `build:${resume.id}`);
  }

  const baseline = resume.score ?? 0;
  const score = rendered.report?.score ?? 0;

  // Replace the previous "Yours", the way a rebuild supersedes its own batch:
  // there is one current version of the document you are editing, and showing
  // two invites downloading the older one.
  const previous = await prisma.variant.findMany({
    where: { resumeId: resume.id, label: OWN_EDIT_LABEL },
    select: { id: true, file: true },
  });
  if (previous.length) {
    await prisma.variant
      .deleteMany({ where: { id: { in: previous.map((v) => v.id) } } })
      .catch((e) => console.error("[build] supersede failed:", e));
    for (const old of previous) {
      const dir = path.dirname(old.file);
      if (dir && dir !== ".") {
        await fsp
          .rm(path.join(VARIANT_DIR, resume.id, dir), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }

  let variant;
  try {
    variant = await prisma.variant.create({
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
        file: `${runDir}/variant-1.pdf`,
        bytes,
      },
    });
  } catch (e) {
    await refund(user.id, "variantRuns");
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

  // The edited text becomes the resume's text, so the untargeted report on the
  // Readiness tab describes what the user now has rather than what they
  // uploaded. Without this, someone fixes every finding, rebuilds, and the
  // report still lists the problems they just solved.
  const text = structToText(struct);
  await prisma.resume
    .update({
      where: { id: resume.id },
      data: {
        text: text.slice(0, 60000),
        chars: text.trim().length,
        score,
        grade: rendered.report?.grade ?? null,
        reportJson: toJsonColumn(rendered.report),
        textHash: crypto.createHash("sha256").update(text).digest("hex"),
        // The advice was written about the previous draft and is now describing
        // a document that no longer exists.
        adviceJson: toJsonColumn(null),
      },
    })
    .catch((e) => console.error("[build] resume update failed:", e));

  await audit(user.id, "resume_built", resume.id, `score ${score}`);

  return NextResponse.json({
    ok: true,
    variantId: variant.id,
    score,
    grade: rendered.report?.grade ?? "",
    baseline,
    pages: rendered.pages ?? null,
    report: rendered.report ?? null,
  });
}
