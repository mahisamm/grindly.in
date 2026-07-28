import { NextResponse } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { spawnWorkerKick } from "@/lib/workerKick";
import { enqueueAgentRun } from "@/lib/agentRunQueue";

const RESUME_DIR = path.join(process.cwd(), "data", "resumes");
// Masters this uid might already have on disk under other extensions — cleared so
// find_resume_file() (agent/resume_parse.py) can't pick a stale one over the new PDF.
const OTHER_MASTER_EXTS = [".docx", ".txt"];

/**
 * Promote an AI-optimized variant to the user's master resume — "use this one".
 *
 * Copies the compiled variant PDF over the master slot, then resets everything
 * derived from the OLD resume (skills, score, analysis, hash) exactly like a
 * fresh upload does, and queues a re-analysis so the dashboard reflects the new
 * document. The old variants are cleared: they describe a resume that's no longer
 * the master.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const variant = await prisma.resumeVariant.findFirst({ where: { id, userId: uid } });
  if (!variant) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Re-validate the stored path stays under data/resume_variants before reading.
  // The trailing separator matters: a bare prefix test also accepts a SIBLING
  // directory that merely starts with the same characters (data/resume_variants_x).
  const variantsDir = path.join(process.cwd(), "data", "resume_variants") + path.sep;
  const srcAbs = path.resolve(/*turbopackIgnore: true*/ process.cwd(), variant.pdfPath);
  if (!srcAbs.startsWith(variantsDir) || !fs.existsSync(srcAbs)) {
    return NextResponse.json({ error: "This optimized file is no longer available. Please regenerate." }, { status: 410 });
  }

  const resumeName = `Grindly optimized — ${variant.label}.pdf`;
  try {
    await fsp.mkdir(RESUME_DIR, { recursive: true });
    await fsp.copyFile(srcAbs, path.join(RESUME_DIR, `${uid}.pdf`));
    for (const ext of OTHER_MASTER_EXTS) {
      await fsp.rm(path.join(RESUME_DIR, `${uid}${ext}`), { force: true }).catch(() => {});
    }
  } catch (e) {
    console.error("[resume/use] copy failed:", e);
    return NextResponse.json({ error: "Server storage error — please try again." }, { status: 500 });
  }

  try {
    // Same reset a new master upload performs: nothing derived from the old resume
    // may survive, or the agent would match on stale skills.
    await prisma.profile.update({
      where: { userId: uid },
      data: {
        resumeName,
        skills: "[]",
        resumeText: null,
        resumeScore: null,
        resumeSuggestions: null,
        resumeHash: null,
        resumeParseFailed: false,
        resumeVariantStatus: null,
        resumeVariantDetail: null,
        // The LaTeX master describes the resume being REPLACED. The upload path
        // clears these (src/app/api/resume/route.ts) and this path forgot to —
        // so after "Use as my resume" the tailoring pipeline kept editing a
        // .tex of the old document and mailing employers the old resume.
        resumeTexName: null,
        resumeTexStatus: null,
        resumeTexDetail: null,
      },
    });
    // The stored variants were generated from the PREVIOUS master; drop them.
    await prisma.resumeVariant.deleteMany({ where: { userId: uid } });
    // And the stale .tex file itself, same as a fresh master upload does.
    await fsp
      .rm(path.join(process.cwd(), "data", "resume_tex", `${uid}.tex`), { force: true })
      .catch(() => {});
    await enqueueAgentRun(uid, "analyze");
  } catch (e) {
    console.error("[resume/use] db write failed:", e);
    return NextResponse.json({ error: "Could not switch your resume — please try again." }, { status: 500 });
  }

  spawnWorkerKick(process.cwd(), uid);
  return NextResponse.json({ ok: true, resumeName });
}
